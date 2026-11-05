const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');
const verification = require('../utils/verification');
const original = { ...verification };
const db = new sqlite3.Database(':memory:');
const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, error => error ? reject(error) : resolve()));
const get = sql => new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row)));
const sendJSON = (res, status, body) => res.finish({ status, body });
const handler = require('../routes/customerEmail')({
    db, sendJSON, readBody: (req, callback) => callback(null, req.body),
    requireAdmin(req, res) {
        if (req.user.role === 'admin') return req.user;
        sendJSON(res, 403, { success: false });
    }
});
function call(body, user = { user_id: 1, role: 'admin' }) {
    return new Promise((resolve, reject) => {
        handler({ url: '/api/customers/email/request', body, user }, { finish: resolve }).catch(reject);
    });
}
// Opens the emailed link the same way /verify-email does.
async function openLink(link) {
    const entry = verification.takeLink(new URL(link).searchParams.get('token'), 'confirm');
    return entry ? entry.confirm() : 'link_invalid';
}
async function test() {
    await run('CREATE TABLE customer_accounts(account_id INTEGER PRIMARY KEY, customer_id INTEGER, username TEXT)');
    await run('CREATE TABLE customers(customer_id INTEGER PRIMARY KEY, customer_name TEXT)');
    await run("CREATE TABLE verified_contacts(account_type TEXT, account_id INTEGER, channel TEXT, destination TEXT, PRIMARY KEY(account_type,account_id,channel))");
    await run("INSERT INTO customer_accounts VALUES(1,1,'first'),(2,2,'second')");
    await run("INSERT INTO customers VALUES(1,'First Customer'),(2,'Second Customer')");
    await run("INSERT INTO verified_contacts VALUES('customer',1,'email','old@example.com'),('customer',2,'email','other@example.com')");
    let sent = 0;
    const links = [];
    verification.configured = () => true;
    verification.sendLink = async (to, subject, message, link) => { sent++; links.push(link); };
    assert.equal((await call({}, { role: 'customer' })).status, 403);
    assert.equal((await call({ customer_id: 1, email: 'invalid' })).status, 400);
    assert.equal((await call({ customer_id: 1, email: 'other@example.com' })).status, 400);
    assert.equal((await call({ customer_id: 1, email: 'first@example.com' })).status, 200);
    assert.equal((await call({ customer_id: 1, email: 'NEW@example.com' })).status, 200);
    assert.equal((await get("SELECT destination FROM verified_contacts WHERE account_id=1")).destination, 'old@example.com');
    assert.equal(await openLink(links[0]), 'link_invalid', 'an older link stops working once a newer one is sent');
    assert.equal(await openLink(links[1]), 'email_changed');
    assert.equal((await get("SELECT destination FROM verified_contacts WHERE account_id=1")).destination, 'new@example.com');
    assert.equal(await openLink(links[1]), 'link_invalid');
    verification.configured = () => false;
    assert.equal((await call({ customer_id: 1, email: 'next@example.com' })).status, 503);
    assert.equal(sent, 2);
    console.log('Customer email: admin permission, validation, duplicates, unchanged email before confirmation, newest-link-only, successful change, replay, and missing provider passed. No real messages sent.');
}
test().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Object.assign(verification, original); db.close(); });
