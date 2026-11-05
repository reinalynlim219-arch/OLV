const bcrypt = require('bcrypt');
const verification = require('../utils/verification');
const otp = require('../utils/otp');
const mailer = require('../utils/mailer');
const { matchBarangay, checkAddressParts, checkFullName } = require('../public/js/barangays');

// Registration is confirmed with a 6-digit code sent by email; password recovery
// uses a link sent by email.
module.exports = function accountVerification({ db, readBody, sendJSON, strongPassword, address, sessions, sessionExpiry, sessionTimestamps }) {
    const ready = new Promise((resolve, reject) => db.run(`CREATE TABLE IF NOT EXISTS verified_contacts (account_type TEXT NOT NULL, account_id INTEGER NOT NULL, channel TEXT NOT NULL, destination TEXT NOT NULL,
        PRIMARY KEY(account_type, account_id, channel))`, error => error ? reject(error) : resolve())).then(() => new Promise((resolve, reject) => db.run(
        "CREATE TRIGGER IF NOT EXISTS remove_customer_verified_contacts AFTER DELETE ON customer_accounts BEGIN DELETE FROM verified_contacts WHERE account_type = 'customer' AND account_id = OLD.account_id; END",
        error => error ? reject(error) : resolve())));
    const limits = new Map();
    const get = (sql, values) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
    const run = (sql, values) => new Promise((resolve, reject) => db.run(sql, values, function(error) { error ? reject(error) : resolve(this); }));
    function limit(key) {
        const now = Date.now();
        for (const [id, entry] of limits) if (entry.until < now) limits.delete(id);
        const entry = limits.get(key) || { count: 0, until: now + 15 * 60000 };
        if (++entry.count > 5) throw new Error('Too many email requests. Try again in 15 minutes.');
        limits.set(key, entry);
    }
    function redirect(res, notice) {
        res.writeHead(302, { Location: '/login?notice=' + notice, 'Cache-Control': 'no-store' });
        res.end();
    }

    async function createCustomer(entry) {
        const d = entry.details;
        if (await get('SELECT username FROM users WHERE username = ? UNION SELECT username FROM customer_accounts WHERE username = ?', [entry.username, entry.username])) return 'username_taken';
        // privacy_consent_at: when the customer agreed to the privacy notice (RA 10173).
        const customer = await run(`INSERT INTO customers (customer_name, contact_number, address, city, barangay, zone, street, house_number, landmark, customer_type, status, privacy_consent_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Regular', 'active', CURRENT_TIMESTAMP)`, [String(d.full_name).trim(), d.contact_number, address(d), d.city || 'Legazpi City', d.barangay, d.zone || '', d.street, d.house_number, d.landmark || '']);
        try {
            const account = await run("INSERT INTO customer_accounts (customer_id, username, password, status) VALUES (?, ?, ?, 'active')", [customer.lastID, entry.username, entry.hash]);
            const contact = await run("INSERT INTO verified_contacts (account_type, account_id, channel, destination) SELECT 'customer', ?, 'email', ? WHERE NOT EXISTS (SELECT 1 FROM verified_contacts WHERE channel = 'email' AND destination = ?)", [account.lastID, entry.email, entry.email]);
            if (!contact.changes) throw new Error('email_taken');
        } catch (error) {
            await run("DELETE FROM verified_contacts WHERE account_type = 'customer' AND account_id IN (SELECT account_id FROM customer_accounts WHERE customer_id = ?)", [customer.lastID]);
            await run('DELETE FROM customer_accounts WHERE customer_id = ?', [customer.lastID]);
            await run('DELETE FROM customers WHERE customer_id = ?', [customer.lastID]);
            if (error.message === 'email_taken') return 'email_taken';
            throw error;
        }
        return 'registered';
    }

    return async function handle(req, res) {
        const url = req.url.split('?')[0];
        try {
            await ready;
            // Link opened from the email: finishes registration or an admin email change.
            if (url === '/verify-email') {
                const token = new URLSearchParams(req.url.split('?')[1] || '').get('token');
                const entry = verification.takeLink(token, 'confirm');
                if (!entry) return redirect(res, 'link_invalid');
                return redirect(res, entry.kind === 'register' ? await createCustomer(entry) : await entry.confirm());
            }
            if (!verification.configured()) return sendJSON(res, 503, { success: false, message: 'Email verification is not configured yet. Ask the station administrator for assistance.' });
            const data = await new Promise((resolve, reject) => readBody(req, (error, value) => error ? reject(error) : resolve(value || {})));
            if (url === '/register') {
                limit('ip:' + req.socket.remoteAddress);
                const to = verification.email(data.email);
                limit('to:' + to);
                const username = String(data.username || '').trim();
                data.city = String(data.city ?? 'Legazpi City').trim();
                if (!['Legazpi City', 'Daraga'].includes(data.city)) throw new Error('Choose Legazpi City or Daraga as your city / municipality.');
                data.barangay = matchBarangay(data.city, data.barangay);
                if (!data.barangay) throw new Error(`Choose a barangay of ${data.city} from the list.`);
                // Data Privacy Act (RA 10173): no account without the customer's consent.
                if (data.privacy_consent !== true) throw new Error('Please read the privacy notice and tick the box to agree before creating your account.');
                const addressProblem = checkFullName(data.full_name) || checkAddressParts(data);
                if (addressProblem) throw new Error(addressProblem);
                data.full_name = String(data.full_name).trim().replace(/\s+/g, ' ');
                for (const key of ['zone', 'street', 'house_number', 'landmark']) data[key] = String(data[key] || '').trim();
                if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username) || !strongPassword(data.password) || data.password !== data.confirm_password) throw new Error('Enter a valid username and matching strong passwords.');
                // A Philippine mobile number: +63 9XXXXXXXXX, saved as 09XXXXXXXXX.
                if (!/^09\d{9}$/.test(data.contact_number || '') || !String(data.full_name || '').trim() || !String(data.barangay || '').trim() || !String(data.street || '').trim() || !String(data.house_number || '').trim()) throw new Error('Complete your name, mobile number (+63 followed by 10 digits), and delivery address.');
                if (await get('SELECT username FROM users WHERE username = ? UNION SELECT username FROM customer_accounts WHERE username = ?', [username, username])) throw new Error('That username is already in use.');
                if (await get("SELECT account_id FROM verified_contacts WHERE channel = 'email' AND destination = ?", [to])) throw new Error('That email is already used by another account.');
                const details = { ...data };
                delete details.password;
                delete details.confirm_password;
                // The account is created only after the 6-digit code from the email is entered.
                let sent;
                try {
                    sent = await otp.start('register', to, { kind: 'register', username, email: to, details, hash: await bcrypt.hash(data.password, 12) },
                        { name: data.full_name, details: [['Username', username], ['Delivery address', address(data)]] });
                } catch (error) {
                    console.error('Sign-up code email error:', error.message);
                    throw new Error('We could not send the confirmation code. Check the email address or try again later.');
                }
                return sendJSON(res, 200, { success: true, otp_ticket: sent.ticket, email_hint: sent.email_hint,
                    message: `We sent a 6-digit code to ${sent.email_hint}. Enter it within ${sent.minutes} minutes to activate your account.` });
            }
            // The 6-digit code from the sign-up email.
            if (url === '/register/verify') {
                const entry = otp.check(data.otp_ticket, 'register', data.code);
                const outcome = await createCustomer(entry);
                if (outcome !== 'registered') throw new Error(outcome === 'username_taken'
                    ? 'That username was taken while you were confirming. Please sign up again with another username.'
                    : 'That email is already used by another account.');
                return sendJSON(res, 200, { success: true, username: entry.username, message: 'Email confirmed. Your account is active, so you can sign in now.' });
            }
            // Each ticket allows only 2 new codes (utils/otp.js), and tickets come from /register, which is limited.
            if (url === '/register/resend') {
                const sent = await otp.resend(data.otp_ticket, 'register');
                return sendJSON(res, 200, { success: true, message: `A new code was sent to ${sent.email_hint}. The old code no longer works.` });
            }
            if (url === '/account/recover/request') {
                limit('ip:' + req.socket.remoteAddress);
                const to = verification.email(data.email);
                limit('to:' + to);
                const matches = await new Promise((resolve, reject) => db.all("SELECT account_type, account_id FROM verified_contacts WHERE channel = 'email' AND destination = ?", [to], (error, rows) => error ? reject(error) : resolve(rows)));
                const account = matches.length === 1 ? matches[0] : null;
                const table = account?.account_type === 'customer' ? 'customer_accounts' : 'users';
                const row = account && await get(`SELECT username FROM ${table} WHERE ${account.account_type === 'customer' ? 'account_id' : 'user_id'} = ? AND status = 'active'`, [account.account_id]);
                if (row) {
                    const token = verification.createLink('recover', { account, to });
                    try {
                        await verification.sendLink(to, 'Reset your OLV password',
                            'We received a request to reset the password for your OLV account. Click the button below to choose a new password.',
                            `${verification.linkBase(req)}/login?reset=${token}`, 'Set a new password', {
                                name: row.username, title: 'Reset your password',
                                paragraphs: ['After the password is changed, you will be signed out on every device and can sign in again with the new password.'],
                                details: [['Username', row.username], ['Requested on', mailer.phTime()]],
                                ignoreNote: 'If you did not ask to reset your password, ignore this email; your current password stays the same.'
                            });
                    } catch (error) {
                        verification.takeLink(token, 'recover');
                        console.error('Password reset email error:', error.message);
                        throw new Error('We could not send the email right now. Please try again later.');
                    }
                }
                return sendJSON(res, 200, { success: true, message: 'If this email belongs to an active account, a password reset link has been sent. Check your inbox and spam folder.' });
            }
            // POST /account/recover: new password submitted from the emailed link.
            if (!strongPassword(data.password) || data.password !== data.confirm_password) throw new Error('Enter matching passwords with 8+ characters, uppercase, lowercase, a number, and a symbol.');
            const entry = verification.takeLink(data.reset_token, 'recover');
            if (!entry) throw new Error('This reset link is invalid, expired, or already used. Request a new one.');
            const customer = entry.account.account_type === 'customer';
            const table = customer ? 'customer_accounts' : 'users';
            const id = customer ? 'account_id' : 'user_id';
            const account = await get(`SELECT * FROM ${table} WHERE ${id} = ? AND status = 'active'`, [entry.account.account_id]);
            if (!account) throw new Error('Account is not available for recovery.');
            const contact = await get("SELECT destination FROM verified_contacts WHERE account_type = ? AND account_id = ? AND channel = 'email'", [entry.account.account_type, entry.account.account_id]);
            if (!contact || contact.destination !== entry.to) throw new Error('Account email changed. Request a new reset link.');
            await run(`UPDATE ${table} SET password = ? WHERE ${id} = ?`, [await bcrypt.hash(data.password, 12), entry.account.account_id]);
            // Other reset emails sent earlier to this account stop working too.
            verification.dropLinks(link => link.purpose === 'recover' && link.account
                && link.account.account_type === entry.account.account_type && Number(link.account.account_id) === Number(entry.account.account_id));
            // Signed out on every device (the new password is needed everywhere).
            for (const [sessionId, user] of sessions) {
                if (customer ? user.role === 'customer' && Number(user.customer_id) === Number(account.customer_id) : user.role !== 'customer' && Number(user.user_id) === Number(account.user_id)) {
                    sessions.delete(sessionId); sessionExpiry.delete(sessionId); sessionTimestamps.delete(sessionId);
                }
            }
            sendJSON(res, 200, { success: true, username: account.username, message: 'Password updated. Sign in with your new password.' });
        } catch (error) {
            if (url === '/verify-email') { console.error('Email confirmation error:', error); return redirect(res, 'verify_failed'); }
            sendJSON(res, 400, { success: false, message: error.code ? 'Unable to save account. Check your details and try again.' : error.message });
        }
    };
};
