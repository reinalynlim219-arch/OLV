const verification = require('../utils/verification');

// An email change is saved only after the customer opens the link sent to the new address.
module.exports = function customerEmail({ db, requireAdmin, readBody, sendJSON }) {
    const requests = new Map();
    const get = (sql, values) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
    const run = (sql, values) => new Promise((resolve, reject) => db.run(sql, values, function(error) { error ? reject(error) : resolve(this); }));
    return async function handle(req, res) {
        const admin = requireAdmin(req, res);
        if (!admin) return;
        try {
            const data = await new Promise((resolve, reject) => readBody(req, (error, data) => error ? reject(error) : resolve(data || {})));
            if (!verification.configured()) return sendJSON(res, 503, { success: false, message: 'Email is not configured. The saved email has not changed.' });
            const now = Date.now();
            for (const [key, entry] of requests) if (entry.until < now) requests.delete(key);
            const email = verification.email(data.email);
            const account = await get('SELECT a.account_id, a.username, c.customer_name FROM customer_accounts a JOIN customers c ON c.customer_id = a.customer_id WHERE a.customer_id = ?', [Number(data.customer_id)]);
            if (!account) return sendJSON(res, 404, { success: false, message: 'Customer account not found.' });
            for (const key of ['admin:' + admin.user_id, 'email:' + email]) {
                const limit = requests.get(key) || { count: 0, until: now + 15 * 60000 };
                requests.set(key, limit);
                if (++limit.count > 5) return sendJSON(res, 429, { success: false, message: 'Too many requests. Try again in 15 minutes.' });
            }
            const duplicate = await get("SELECT account_id FROM verified_contacts WHERE channel = 'email' AND destination = ? AND NOT (account_type = 'customer' AND account_id = ?)", [email, account.account_id]);
            if (duplicate) throw new Error('That email is already used by another account.');
            const accountId = account.account_id;
            // Only the newest link for an account stays valid.
            verification.dropLinks(entry => entry.kind === 'email-change' && entry.accountId === accountId);
            const token = verification.createLink('confirm', {
                kind: 'email-change', accountId,
                // Check duplicates again when saving, including links opened meanwhile.
                async confirm() {
                    const saved = await run(`INSERT INTO verified_contacts(account_type, account_id, channel, destination)
                        SELECT 'customer', ?, 'email', ? WHERE EXISTS (SELECT 1 FROM customer_accounts WHERE account_id = ?)
                        AND NOT EXISTS (SELECT 1 FROM verified_contacts WHERE channel = 'email' AND destination = ? AND NOT (account_type = 'customer' AND account_id = ?))
                        ON CONFLICT(account_type, account_id, channel) DO UPDATE SET destination = excluded.destination`,
                    [accountId, email, accountId, email, accountId]);
                    if (!saved.changes) return 'email_taken';
                    await run("DELETE FROM verified_contacts WHERE account_type = 'customer' AND account_id = ? AND channel = 'unverified_email'", [accountId]);
                    return 'email_changed';
                }
            });
            await verification.sendLink(email, 'Confirm your new OLV email address',
                'The station updated the email address on your OLV customer account. Please confirm that this is your email address.',
                `${verification.baseUrl()}/verify-email?token=${token}`, 'Confirm this email', {
                    name: account.customer_name, title: 'Confirm your new email address',
                    paragraphs: ['Once confirmed, this address will receive your order and delivery updates and can be used to reset your password. Until then, your old email address stays on your account.'],
                    details: [['Username', account.username], ['New email', email]],
                    ignoreNote: 'If you did not ask the station to change your email, ignore this email and contact the station; nothing will change.'
                });
            sendJSON(res, 200, { success: true, message: `Confirmation link sent to ${email}. The email is saved once the customer opens the link (valid for 30 minutes).` });
        } catch (error) {
            sendJSON(res, 400, { success: false, message: error.code ? 'Unable to send the confirmation email. Please try again.' : error.message });
        }
    };
};
