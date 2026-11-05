const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');
const verification = require('../utils/verification');

// In-memory fixtures only. No live customers or messages are touched.
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
function call(handler, path, method, user, data = {}) {
    return new Promise((resolve, reject) => {
        const req = { url: path, method, user, body: data, socket: { remoteAddress: 'test' } };
        const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { resolve({ status: this.status, body, headers: this.headers }); }, finish: resolve };
        Promise.resolve(handler(req, res)).catch(reject);
    });
}
const common = {
    db, readBody: (req, cb) => cb(null, req.body),
    sendJSON: (res, status, body) => res.finish({ status, body })
};
async function test() {
    await run(`CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, customer_name TEXT, contact_number TEXT, address TEXT, city TEXT, barangay TEXT, zone TEXT, street TEXT, house_number TEXT, landmark TEXT, latitude REAL, longitude REAL, customer_type TEXT, status TEXT, privacy_consent_at DATETIME)`);
    await run(`CREATE TABLE customer_accounts (account_id INTEGER PRIMARY KEY, customer_id INTEGER, username TEXT UNIQUE, password TEXT, status TEXT)`);
    await run(`CREATE TABLE users (user_id INTEGER PRIMARY KEY, username TEXT, password TEXT, contact_number TEXT, status TEXT)`);
    // Two existing customers, so the newly registered customer is number 3 (matches the session below).
    await run("INSERT INTO customers (customer_id, customer_name, contact_number, status) VALUES (1, 'Test customer', '09123456789', 'active'), (2, 'Other customer', '09987654321', 'active')");
    let result;

    // Email links are captured instead of sent. No real email leaves the test.
    const original = { ...verification };
    let sent = 0;
    let lastLink = '';
    verification.configured = () => true;
    verification.sendLink = async (to, subject, message, link) => { sent++; lastLink = link; };
    // Sign-up codes go through the mailer; capture them the same way.
    const mailer = require('../utils/mailer');
    const originalSend = mailer.send;
    let lastCode = '';
    mailer.send = async ({ code }) => { sent++; lastCode = code; };
    const tokenFrom = (link, name) => new URL(link).searchParams.get(name);
    const sessions = new Map([['session', { role: 'customer', customer_id: 3 }]]);
    const accounts = require('../routes/accountVerification')({ ...common, strongPassword: password => typeof password === 'string' && password.length >= 8,
        address: () => 'Test address', sessions, sessionExpiry: new Map(), sessionTimestamps: new Map() });
    await get('SELECT 1');
    assert.equal((await call(accounts, '/account/recover', 'POST', null, { password: 'newpass123', confirm_password: 'newpass123' })).status, 400);
    const registration = { email: 'Student@Example.com', full_name: 'Student', username: 'student', password: 'TestPass1!', confirm_password: 'TestPass1!', contact_number: '09111111111', barangay: 'Rawis', street: 'Test', house_number: '1', privacy_consent: true };
    result = await call(accounts, '/register', 'POST', null, registration);
    assert.equal(result.status, 200);
    assert.equal(result.body.verification_token, undefined);
    assert.match(lastCode, /^\d{6}$/);
    assert.match(result.body.email_hint, /^st\*+@example\.com$/);
    assert.equal(await get("SELECT 1 FROM customer_accounts WHERE username = 'student'"), undefined);
    const ticket = result.body.otp_ticket;
    const wrongCode = lastCode === '000000' ? '111111' : '000000';
    assert.match((await call(accounts, '/register/verify', 'POST', null, { otp_ticket: ticket, code: wrongCode })).body.message, /Wrong code\. 4 tries left/);
    assert.equal((await call(accounts, '/register/verify', 'POST', null, { otp_ticket: 'forged', code: lastCode })).status, 400);
    // A new code replaces the old one.
    const firstCode = lastCode;
    assert.equal((await call(accounts, '/register/resend', 'POST', null, { otp_ticket: ticket })).status, 200);
    if (firstCode !== lastCode) assert.equal((await call(accounts, '/register/verify', 'POST', null, { otp_ticket: ticket, code: firstCode })).status, 400);
    result = await call(accounts, '/register/verify', 'POST', null, { otp_ticket: ticket, code: lastCode });
    assert.equal(result.status, 200);
    assert.equal(result.body.username, 'student');
    assert.equal((await get("SELECT destination FROM verified_contacts WHERE channel = 'email'")).destination, 'student@example.com');
    // The same code cannot be used twice.
    assert.equal((await call(accounts, '/register/verify', 'POST', null, { otp_ticket: ticket, code: lastCode })).status, 400);
    assert.equal((await call(accounts, '/register', 'POST', null, { ...registration, username: 'student2' })).status, 400);
    // Address checks, each sent from its own address so they do not use up the email limit above.
    const register = (changes, address) => new Promise((resolve, reject) => {
        const req = { url: '/register', method: 'POST', body: { ...registration, email: address + '@example.com', username: address, ...changes }, socket: { remoteAddress: address } };
        Promise.resolve(accounts(req, { finish: resolve })).catch(reject);
    });
    for (const [changes, expected] of [
        [{ city: 'Daraga', barangay: 'Rawis' }, /barangay/],
        [{ barangay: 'Nowhere' }, /barangay/],
        [{ zone: 'five' }, /Zone/],
        [{ street: 'ssdfyugih' }, /street/],
        [{ house_number: 'abc' }, /house or lot/],
        [{ landmark: 'qqqqq' }, /landmark/],
        // Data Privacy Act: no account without ticking the consent box.
        [{ privacy_consent: false }, /privacy notice/],
        // Mobile number: 09XXXXXXXXX (typed as +63 9XXXXXXXXX); letters, symbols, or a wrong start are refused.
        [{ contact_number: '0917abc4567' }, /mobile number/],
        [{ contact_number: '9171234567' }, /mobile number/],
        [{ contact_number: '08171234567' }, /mobile number/]
    ]) {
        const rejected = await register(changes, 'check' + Object.keys(changes).join('') + Object.values(changes).join('').length);
        assert.equal(rejected.status, 400, JSON.stringify(changes));
        assert.match(rejected.body.message, expected);
    }
    result = await call(accounts, '/account/recover/request', 'POST', null, { email: 'student@example.com' });
    assert.equal(result.status, 200);
    const resetToken = tokenFrom(lastLink, 'reset');
    assert.equal((await call(accounts, '/account/recover', 'POST', null, { reset_token: resetToken, password: 'short', confirm_password: 'short' })).status, 400);
    assert.equal((await call(accounts, '/account/recover', 'POST', null, { reset_token: 'wrong', password: 'NewPass1!', confirm_password: 'NewPass1!' })).status, 400);
    assert.equal((await call(accounts, '/account/recover', 'POST', null, { reset_token: resetToken, password: 'NewPass1!', confirm_password: 'NewPass1!' })).status, 200);
    assert.equal(sessions.size, 0);
    assert.ok(await bcrypt.compare('NewPass1!', (await get("SELECT password FROM customer_accounts WHERE username = 'student'")).password));
    assert.equal((await call(accounts, '/account/recover', 'POST', null, { reset_token: resetToken, password: 'NewPass1!', confirm_password: 'NewPass1!' })).status, 400);
    const before = sent;
    assert.equal((await call(accounts, '/account/recover/request', 'POST', null, { email: 'nobody@example.com' })).status, 200);
    assert.equal(sent, before);
    await call(accounts, '/account/recover/request', 'POST', null, { email: 'student@example.com' });
    await run("UPDATE verified_contacts SET destination='changed@example.com' WHERE channel='email'");
    assert.equal((await call(accounts, '/account/recover', 'POST', null, { reset_token: tokenFrom(lastLink, 'reset'), password: 'NewPass2!', confirm_password: 'NewPass2!' })).status, 400);
    verification.configured = () => false;
    assert.equal((await call(accounts, '/account/recover/request', 'POST', null, {})).status, 503);
    assert.equal(sent, 4);
    Object.assign(verification, original);
    mailer.send = originalSend;
    console.log('Email verification: 6-digit sign-up code (wrong code, resend, replay), duplicate email, reset link, weak/wrong token rejection, session revocation, unknown email privacy, changed email, and missing-provider handling passed.');
}
test().then(() => db.close()).catch(error => { console.error(error); db.close(); process.exitCode = 1; });
