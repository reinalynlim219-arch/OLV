// Checks for the October 2026 features: Gmail sign-in codes (OTP), staff emails,
// the calendar, and the customer's preferred delivery date. Maps, live driver GPS,
// and the delivery chat were removed again (the user's choice), so their routes must
// be gone and tracking must carry no location. Runs against a throwaway database;
// emails go to a test outbox file (OLV_MAIL_OUTBOX), never to real addresses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');

const PASSWORD = 'Live-Pass-2026!';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
function check(name, condition, detail = '') { assert.ok(condition, `${name} ${detail}`); passed++; console.log('PASS:', name); }
const phDay = (offset = 0) => new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);

async function main() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'olv-live-test-'));
    const outbox = path.join(work, 'outbox.jsonl');
    const env = { ...process.env, OLV_DB_PATH: path.join(work, 'live.db'), GMAIL_USER: '', GMAIL_APP_PASSWORD: '', OLV_MAIL_OUTBOX: outbox, OLV_SIGNIN_CODE: '1', OLV_DISABLE_AUTO_BACKUP: '1', REPORT_RECIPIENT: '', ROUTING_URL: '', HTTPS_KEY: '', HTTPS_CERT: '', APP_URL: '' };
    const init = spawnSync(process.execPath, ['database/init.js'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    const db = new sqlite3.Database(env.OLV_DB_PATH);
    const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, function (error) { error ? reject(error) : resolve(this); }));
    const hash = await bcrypt.hash(PASSWORD, 10);
    await run("INSERT INTO users(username,password,full_name,contact_number,role) VALUES('l_admin',?,'Live Admin','09170000001','admin'),('l_staff',?,'Live Staff','09170000002','staff'),('l_driver',?,'Live Driver','09170000003','driver')", [hash, hash, hash]);
    await run("INSERT INTO products(product_name,category,unit,price,status) VALUES('Round gallon refill','Water','gallon',30,'active')");
    await run("INSERT INTO inventory(product_id,quantity,minimum_stock,stock_status) VALUES(1,100,5,'available')");
    await run("INSERT INTO customers(customer_name,contact_number,address,city,barangay,street,house_number,latitude,longitude,customer_type,status) VALUES('Cora Customer','09170000010','1 Rizal St','Legazpi City','Bitano','Rizal St','1',13.15,123.745,'Regular','active'),('Otto Other','09170000011','2 Rizal St','Legazpi City','Bitano','Rizal St','2',NULL,NULL,'Regular','active')");
    await run("INSERT INTO customer_accounts(customer_id,username,password,status) VALUES(1,'l_customer',?,'active'),(2,'l_other',?,'active')", [hash, hash]);
    db.close();

    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const server = spawn(process.execPath, ['app.js'], { env: { ...env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    server.stdout.on('data', chunk => { log += chunk; });
    server.stderr.on('data', chunk => { log += chunk; });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(base + '/')).ok; } catch { } if (!up) await wait(100); }
    assert.ok(up, log);
    await wait(500);
    try {
        async function api(route, method = 'GET', cookie = '', body, headers = {}) {
            const response = await fetch(base + route, { method, headers: { Cookie: cookie, ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
            const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
            return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
        }
        const mails = () => fs.existsSync(outbox) ? fs.readFileSync(outbox, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
        const lastCodeTo = to => mails().filter(m => m.to === to && m.code).at(-1)?.code;
        const query = (sql, values = []) => new Promise((resolve, reject) => { const d = new sqlite3.Database(env.OLV_DB_PATH); d.all(sql, values, (error, rows) => { d.close(); error ? reject(error) : resolve(rows); }); });
        const login = async username => { const r = await api('/login', 'POST', '', { username, password: PASSWORD }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r; };
        const c = {};
        for (const [role, username] of [['customer', 'l_customer'], ['other', 'l_other'], ['driver', 'l_driver'], ['staff', 'l_staff'], ['admin', 'l_admin']]) {
            const r = await login(username);
            check(`${role}: no email on file, so the password alone signs in`, Boolean(r.cookie) && !r.data.otp_required);
            c[role] = r.cookie;
        }

        // ---------- staff email + sign-in code ----------
        const users = (await api('/api/users', 'GET', c.admin)).data.users;
        const staffId = users.find(u => u.username === 'l_staff').user_id;
        const staffUpdate = { user_id: staffId, username: 'l_staff', full_name: 'Live Staff', contact_number: '09170000002', role: 'staff', status: 'active' };
        check('A bad staff email is refused', (await api('/api/users/update', 'PUT', c.admin, { ...staffUpdate, email: 'not-an-email' })).status === 400);
        check('Admin saves a staff email', (await api('/api/users/update', 'PUT', c.admin, { ...staffUpdate, email: 'Staff@Example.com' })).status === 200);
        check('The email shows on the staff list (lower case)', (await api('/api/users', 'GET', c.admin)).data.users.find(u => u.user_id === staffId).email === 'staff@example.com');
        const adminId = users.find(u => u.username === 'l_admin').user_id;
        check('Another account cannot take the same email', (await api('/api/users/update', 'PUT', c.admin, { user_id: adminId, username: 'l_admin', full_name: 'Live Admin', contact_number: '09170000001', role: 'admin', status: 'active', email: 'staff@example.com' })).status === 409);

        const step1 = await api('/login', 'POST', '', { username: 'l_staff', password: PASSWORD });
        check('With an email, the right password asks for a code instead of signing in', step1.status === 200 && step1.data.otp_required === true && !step1.cookie && /^st\*+@example\.com$/.test(step1.data.email_hint));
        const code = lastCodeTo('staff@example.com');
        check('A 6-digit code is emailed to the account email', /^\d{6}$/.test(code || ''));
        const wrong = code === '000000' ? '111111' : '000000';
        check('A wrong code is refused', (await api('/login/verify', 'POST', '', { otp_ticket: step1.data.otp_ticket, code: wrong })).status === 400);
        check('A code for another ticket is refused', (await api('/login/verify', 'POST', '', { otp_ticket: 'x'.repeat(64), code })).status === 400);
        const step2 = await api('/login/verify', 'POST', '', { otp_ticket: step1.data.otp_ticket, code });
        check('The right code signs in', step2.status === 200 && Boolean(step2.cookie) && step2.data.user.username === 'l_staff');
        check('The new session works', (await api('/api/current-user', 'GET', step2.cookie)).status === 200);
        // Editing the staff account (adding the email) signed the old session out, as designed.
        check('The edit signed out the staff member\'s old session', (await api('/api/current-user', 'GET', c.staff)).status === 401);
        c.staff = step2.cookie;
        check('The same code cannot be used again', (await api('/login/verify', 'POST', '', { otp_ticket: step1.data.otp_ticket, code })).status === 400);
        const again = await api('/login', 'POST', '', { username: 'l_staff', password: PASSWORD });
        for (let i = 0; i < 4; i++) await api('/login/verify', 'POST', '', { otp_ticket: again.data.otp_ticket, code: wrong });
        const fifth = await api('/login/verify', 'POST', '', { otp_ticket: again.data.otp_ticket, code: wrong });
        check('After 5 wrong codes the ticket stops working', /Too many wrong codes/.test(fifth.data.message) && (await api('/login/verify', 'POST', '', { otp_ticket: again.data.otp_ticket, code: lastCodeTo('staff@example.com') })).status === 400);
        const resendTicket = (await api('/login', 'POST', '', { username: 'l_staff', password: PASSWORD })).data.otp_ticket;
        const before = mails().length;
        check('"Send a new code" emails a new code', (await api('/login/resend', 'POST', '', { otp_ticket: resendTicket })).status === 200 && mails().length === before + 1);
        await api('/login/resend', 'POST', '', { otp_ticket: resendTicket });
        check('Only 2 new codes per sign-in', (await api('/login/resend', 'POST', '', { otp_ticket: resendTicket })).status === 400);
        check('The wrong password never sends a code', (await api('/login', 'POST', '', { username: 'l_staff', password: 'Wrong-Pass-1!' })).status === 401 && mails().length === before + 2);
        check('The email is never in the sign-in answer in full', !JSON.stringify(step1.data).includes('staff@example.com'));

        // ---------- preferred delivery date ----------
        const orderOn = (day, cookie = c.customer) => api('/api/customer/orders', 'POST', cookie, { product_id: 1, quantity: 2, fulfillment_method: 'delivery', ...(day !== undefined ? { preferred_date: day } : {}) });
        check('A past delivery date is refused', (await orderOn(phDay(-1))).status === 400);
        check('A date more than 30 days ahead is refused', (await orderOn(phDay(31))).status === 400);
        check('A made-up date is refused', (await orderOn('2026-02-31x')).status === 400);
        const later = await orderOn(phDay(3));
        check('An order with a date 3 days ahead is saved', later.status === 200);
        check('Its delivery is scheduled on that day', (await query('SELECT delivery_date FROM delivery_schedules WHERE order_id = ?', [later.data.order_id]))[0].delivery_date === phDay(3));
        const now = await orderOn(undefined);
        check('Without a date, the delivery is scheduled today', (await query('SELECT delivery_date FROM delivery_schedules WHERE order_id = ?', [now.data.order_id]))[0].delivery_date === phDay(0));
        const pickup = await api('/api/customer/orders', 'POST', c.customer, { product_id: 1, quantity: 1, fulfillment_method: 'pickup', preferred_date: phDay(2) });
        check('Pickup orders ignore the delivery date', pickup.status === 200 && (await query('SELECT preferred_date FROM orders WHERE order_id = ?', [pickup.data.order_id]))[0].preferred_date === null);
        const deliveryId = (await query('SELECT delivery_id FROM delivery_schedules WHERE order_id = ?', [now.data.order_id]))[0].delivery_id;

        // ---------- Orders page: items, schedule, address, and Approve ----------
        const listed = (await api('/api/orders', 'GET', c.staff)).data.find(o => o.order_id === later.data.order_id);
        check('Staff see the items, schedule, and address of a portal order', /Round gallon refill × 2/.test(listed.items) && listed.delivery_date === phDay(3) && listed.preferred_date === phDay(3) && /Rizal St/.test(listed.delivery_address));
        const approve = (cookie, id = later.data.order_id) => api('/api/orders/approve', 'PUT', cookie, { order_id: id });
        check('Drivers and customers cannot approve orders', (await approve(c.driver)).status === 403 && (await approve(c.customer)).status === 403);
        check('Staff approve a pending order', (await approve(c.staff)).status === 200);
        const approved = (await api('/api/orders', 'GET', c.staff)).data.find(o => o.order_id === later.data.order_id);
        check('The order shows who approved it, and stays pending', approved.approved_at && approved.approved_by_name && approved.status === 'pending');
        check('An order cannot be approved twice', (await approve(c.admin)).status === 409);
        check('The customer sees the approval in the portal', (await api('/api/customer/orders', 'GET', c.customer)).data.orders.find(o => o.order_id === later.data.order_id).approved_at);
        await api('/api/orders/cancel', 'PUT', c.staff, { order_id: pickup.data.order_id });
        check('A cancelled order cannot be approved', (await approve(c.staff, pickup.data.order_id)).status === 409);
        check('Approving is in the activity log', (await query("SELECT COUNT(*) AS n FROM activity_logs WHERE route = '/api/orders/approve'"))[0].n === 1);

        // ---------- no maps, no live driver GPS ----------
        check('The driver GPS route is gone', [404, 403].includes((await api('/api/driver/location', 'POST', c.driver, { latitude: 13.15, longitude: 123.75 })).status));
        check('The live map route is gone', (await api('/api/deliveries/live-map', 'GET', c.staff)).status === 404);
        check('The map files are no longer served', (await api('/js/olv-map.js')).status === 404 && (await api('/vendor/leaflet/leaflet.js')).status === 404);
        check('The driver starts the delivery', (await api('/api/deliveries/status', 'PUT', c.driver, { delivery_id: deliveryId, status: 'out_for_delivery' })).status === 200);
        let track = (await api(`/api/deliveries/tracking?delivery_id=${deliveryId}`, 'GET', c.customer)).data;
        check('Tracking shows the status timeline with no location data', track.success && track.events.length >= 2 && track.map === undefined && !/latitude|longitude/.test(JSON.stringify(track)));
        check('Another customer cannot see this delivery', (await api(`/api/deliveries/tracking?delivery_id=${deliveryId}`, 'GET', c.other)).status === 404);

        // ---------- no delivery chat (removed, the user's choice) ----------
        check('The chat route is gone for every role', (await Promise.all([c.customer, c.driver, c.staff].map(cookie => api(`/api/deliveries/messages?delivery_id=${deliveryId}`, 'GET', cookie))))
            .every(r => [403, 404].includes(r.status)) && [403, 404].includes((await api('/api/deliveries/messages', 'POST', c.customer, { delivery_id: deliveryId, body: 'hi' })).status));
        check('The tracking window has no chat', !/trackChat|deliveries\/messages/.test(String((await api('/js/delivery-tracking.js')).data)));

        // ---------- after the drop-off ----------
        await api('/api/deliveries/status', 'PUT', c.driver, { delivery_id: deliveryId, status: 'delivered', cash_collected: true });
        check('The delivery waits for the customer to confirm', (await query('SELECT status FROM delivery_schedules WHERE delivery_id = ?', [deliveryId]))[0].status === 'awaiting_customer');
        check('Staff confirm the receipt for the customer', (await api('/api/orders/complete', 'PUT', c.staff, { order_id: now.data.order_id })).status === 200);

        // ---------- calendar ----------
        const month = phDay(0).slice(0, 7);
        const staffCal = (await api(`/api/calendar?month=${month}`, 'GET', c.staff)).data;
        check('Staff calendar lists this month\'s deliveries and orders', staffCal.deliveries.some(d => d.delivery_id === deliveryId) && staffCal.orders.length >= 3);
        const driverCal = (await api(`/api/calendar?month=${month}`, 'GET', c.driver)).data;
        check('Driver calendar has only their deliveries and no orders', driverCal.orders.length === 0 && driverCal.deliveries.every(d => d.delivery_id === deliveryId));
        check('Customers cannot open the calendar', (await api(`/api/calendar?month=${month}`, 'GET', c.customer)).status === 403 && (await api('/calendar', 'GET', c.customer)).status === 403);
        check('A bad month is refused', (await api('/api/calendar?month=2026-13', 'GET', c.staff)).status === 400);
        check('The calendar page opens for staff', (await api('/calendar', 'GET', c.staff)).status === 200);

        // ---------- emails stayed in the test outbox ----------
        check('No email left the test (all in the outbox file)', mails().every(m => /@example\.com$/.test(m.to)));
        console.log(`\nAll ${passed} new-feature checks passed.`);
    } finally {
        server.kill();
        await wait(400);
        fs.rmSync(work, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
