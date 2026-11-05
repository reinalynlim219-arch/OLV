// Loophole checks from the full-system audit (October 2026), kept as a test so the
// fixes stay fixed: simultaneous orders, stock promised to pending orders, order
// cancelling, input checks, who may do what, sign-out rules, and staff shortcuts.
// Runs against throwaway databases; never touches the live database or sends email.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');

const PASSWORD = 'Audit-Pass-2026!';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
const servers = []; // test servers, stopped if a check fails so the run ends
function check(name, condition, detail = '') { assert.ok(condition, `${name} ${detail}`); passed++; console.log('PASS:', name); }

async function startSystem(extraEnv = {}) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'olv-audit-test-'));
    const env = { ...process.env, OLV_DB_PATH: path.join(work, 'audit.db'), GMAIL_USER: '', GMAIL_APP_PASSWORD: '', OLV_DISABLE_AUTO_BACKUP: '1', REPORT_RECIPIENT: '', ROUTING_URL: '', HTTPS_KEY: '', HTTPS_CERT: '', APP_URL: '', ...extraEnv };
    const init = spawnSync(process.execPath, ['database/init.js'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    const db = new sqlite3.Database(env.OLV_DB_PATH);
    const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, function (error) { error ? reject(error) : resolve(this); }));
    const hash = await bcrypt.hash(PASSWORD, 10);
    await run("INSERT INTO users(username,password,full_name,contact_number,role) VALUES('a_admin',?,'Audit Admin','09170000001','admin'),('a_staff',?,'Audit Staff','09170000002','staff'),('a_driver',?,'Audit Driver','09170000003','driver'),('a_driver2',?,'Second Driver','09170000004','driver')", [hash, hash, hash, hash]);
    await run("INSERT INTO products(product_name,category,unit,price,status) VALUES('Round gallon refill','Water','gallon',30,'active'),('Archived jug','Water','gallon',50,'inactive')");
    await run("INSERT INTO inventory(product_id,quantity,minimum_stock,stock_status) VALUES(1,100,5,'available'),(2,10,1,'available')");
    await run("INSERT INTO customers(customer_name,contact_number,address,city,barangay,street,house_number,latitude,longitude,customer_type,status) VALUES('Cora Customer','09170000010','1 Rizal St','Legazpi City','Bitano','Rizal St','1',13.15,123.745,'Regular','active'),('Otto Other','09170000011','2 Rizal St','Legazpi City','Bitano','Rizal St','2',13.151,123.746,'Regular','active')");
    await run("INSERT INTO customer_accounts(customer_id,username,password,status) VALUES(1,'a_customer',?,'active'),(2,'a_other',?,'active')", [hash, hash]);
    db.close();
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    const server = spawn(process.execPath, ['app.js'], { env: { ...env, PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    servers.push(server);
    let log = '';
    server.stdout.on('data', chunk => { log += chunk; });
    server.stderr.on('data', chunk => { log += chunk; });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(base + '/')).ok; } catch { } if (!up) await wait(100); }
    assert.ok(up, log);
    await wait(500);
    async function api(route, method = 'GET', cookie = '', body) {
        const response = await fetch(base + route, { method, headers: { Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
        return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    const login = async username => { const r = await api('/login', 'POST', '', { username, password: PASSWORD }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.cookie; };
    const c = {};
    for (const [role, username] of [['customer', 'a_customer'], ['other', 'a_other'], ['driver', 'a_driver'], ['driver2', 'a_driver2'], ['staff', 'a_staff'], ['admin', 'a_admin']]) c[role] = await login(username);
    const query = (sql, values = []) => new Promise((resolve, reject) => { const d = new sqlite3.Database(env.OLV_DB_PATH); d.all(sql, values, (error, rows) => { d.close(); error ? reject(error) : resolve(rows); }); });
    const stop = async () => { server.kill(); await wait(400); fs.rmSync(work, { recursive: true, force: true }); };
    return { api, c, query, stop, base, log: () => log };
}

async function main() {
    const t = await startSystem();
    const { api, c, query } = t;
    const stock = async () => (await query('SELECT quantity FROM inventory WHERE product_id = 1'))[0].quantity;
    const free = async () => (await api('/api/customer/products', 'GET', c.customer)).data.products.find(p => p.product_id === 1).stock_quantity;
    const newest = async who => (await api('/api/customer/orders', 'GET', c[who])).data.orders.sort((a, b) => b.order_id - a.order_id)[0];
    const order = async (who, quantity, method = 'delivery') => { await api('/api/customer/orders', 'POST', c[who], { product_id: 1, quantity, fulfillment_method: method }); return newest(who); };

    // ---------- several people at the same moment ----------
    const burst = await Promise.all([...Array(6)].map((_, i) => api('/api/customer/orders', 'POST', i % 2 ? c.other : c.customer, { product_id: 1, quantity: 2, fulfillment_method: i % 3 ? 'pickup' : 'delivery' })));
    check('Six orders placed at the same moment all succeed', burst.every(r => r.status === 200), burst.map(r => r.status).join());
    check('Each of them is saved once, with its items', (await query("SELECT COUNT(*) AS n FROM orders")).at(0).n === 6 && (await query('SELECT COUNT(*) AS n FROM order_items')).at(0).n === 6);
    const pickups = (await api('/api/customer/orders', 'GET', c.customer)).data.orders.filter(o => o.fulfillment_method === 'pickup');
    const mixed = await Promise.all([...pickups.map(o => api('/api/orders/complete', 'PUT', c.staff, { order_id: o.order_id })), api('/api/customer/orders', 'POST', c.other, { product_id: 1, quantity: 1, fulfillment_method: 'pickup' })]);
    check('Completing orders while another is placed works', mixed.every(r => r.status === 200), mixed.map(r => r.status).join());
    const moved = (await query("SELECT COALESCE(SUM(quantity),0) AS n FROM inventory_movements WHERE movement_type = 'stock_out'"))[0].n;
    check('Stock and stock history agree after simultaneous changes', (await stock()) === 100 - moved);

    // ---------- stock promised to pending orders ----------
    const freeNow = await free();
    check('Customers see stock minus what pending orders were promised', freeNow === (await stock()) - (await query("SELECT SUM(oi.quantity) AS n FROM order_items oi JOIN orders o ON o.order_id = oi.order_id WHERE o.status = 'pending'"))[0].n);
    const race = await Promise.all([api('/api/customer/orders', 'POST', c.customer, { product_id: 1, quantity: freeNow, fulfillment_method: 'pickup' }), api('/api/customer/orders', 'POST', c.other, { product_id: 1, quantity: freeNow, fulfillment_method: 'pickup' })]);
    check('Two customers ordering the last free stock at once: exactly one gets it', race.map(r => r.status).sort().join() === '200,409', race.map(r => r.status).join());
    const sold = (await api('/api/customer/orders', 'GET', race[0].status === 200 ? c.customer : c.other)).data.orders.sort((a, b) => b.order_id - a.order_id)[0];
    await api('/api/customer/orders/cancel', 'PUT', race[0].status === 200 ? c.customer : c.other, { order_id: sold.order_id });
    check('Cancelling an order gives its stock back', (await free()) === freeNow);

    // ---------- order cancelling ----------
    const a = await order('customer', 4);
    check('Another customer cannot cancel someone else\'s order', (await api('/api/customer/orders/cancel', 'PUT', c.other, { order_id: a.order_id })).status === 404);
    check('Drivers cannot cancel orders', (await api('/api/orders/cancel', 'PUT', c.driver, { order_id: a.order_id })).status === 403);
    check('A customer cancels their own order before dispatch', (await api('/api/customer/orders/cancel', 'PUT', c.customer, { order_id: a.order_id })).status === 200
        && (await query('SELECT d.status FROM delivery_schedules d WHERE d.order_id = ?', [a.order_id]))[0].status === 'cancelled');
    check('A cancelled order cannot be completed or cancelled again', (await api('/api/orders/complete', 'PUT', c.staff, { order_id: a.order_id })).status >= 400 && (await api('/api/customer/orders/cancel', 'PUT', c.customer, { order_id: a.order_id })).status === 409);
    const b = await order('customer', 1);
    await api('/api/deliveries/status', 'PUT', c.driver, { delivery_id: b.delivery_id, status: 'out_for_delivery' });
    check('Once on the way, the customer can no longer cancel, but staff can', (await api('/api/customer/orders/cancel', 'PUT', c.customer, { order_id: b.order_id })).status === 409
        && (await api('/api/orders/cancel', 'PUT', c.staff, { order_id: b.order_id, reason: 'Refused at the door' })).status === 200);
    const trackB = (await api(`/api/deliveries/tracking?delivery_id=${b.delivery_id}`, 'GET', c.staff)).data;
    check('The cancel reason is in the delivery history', trackB.events.some(e => e.status === 'cancelled' && /Refused at the door/.test(e.note)));

    // ---------- staff shortcuts ----------
    const early = await order('customer', 1);
    check('Staff cannot complete a delivery order before the drop-off', (await api('/api/orders/complete', 'PUT', c.staff, { order_id: early.order_id })).status === 409);
    await api('/api/deliveries/status', 'PUT', c.driver, { delivery_id: early.delivery_id, status: 'out_for_delivery' });
    await api('/api/deliveries/status', 'PUT', c.driver, { delivery_id: early.delivery_id, status: 'delivered' });
    check('After the drop-off, staff can confirm for the customer', (await api('/api/orders/complete', 'PUT', c.staff, { order_id: early.order_id })).status === 200
        && (await query('SELECT status FROM delivery_schedules WHERE delivery_id = ?', [early.delivery_id]))[0].status === 'delivered');
    check('Nobody can cancel after the drop-off', (await api('/api/orders/cancel', 'PUT', c.admin, { order_id: early.order_id })).status === 409);

    // ---------- input checks ----------
    const profile = name => api('/api/customer/profile', 'PUT', c.customer, { full_name: name, city: 'Legazpi City', barangay: 'Bitano', street: 'Rizal St', house_number: '1' });
    check('A 5000-letter or HTML customer name is refused', (await profile('A'.repeat(5000))).status === 400 && (await profile('<img src=x onerror=alert(1)>')).status === 400);
    check('A normal name with Ñ is accepted', (await profile('Cora Ñiño-Dela Cruz')).status === 200);
    const addCustomer = body => api('/api/customers/add', 'POST', c.staff, { customer_name: 'Pia Perez', contact_number: '09170000099', city: 'Legazpi City', barangay: 'Bitano', street: 'Rizal St', house_number: '9', ...body });
    check('Staff cannot save a customer with an unknown barangay', (await addCustomer({ barangay: 'Atlantis' })).status === 400);
    check('Stock-in of 2.5 is refused', (await api('/api/inventory/stock-in', 'POST', c.staff, { product_id: 1, quantity: 2.5 })).status === 400);
    const product = body => api('/api/inventory/add', 'POST', c.staff, { product_name: 'Slim gallon refill', category: 'Water', unit: 'gallon', price: 30, quantity: 5, minimum_stock: 1, ...body });
    check('A product price of "abc" is refused instead of saved as ₱0', (await product({ price: 'abc' })).status === 400);
    check('A decimal starting stock is refused', (await product({ quantity: 2.5 })).status === 400);
    check('A second product with the same name is refused', (await product({ product_name: 'round GALLON refill' })).status === 409);
    check('Renaming a product to another product\'s name is refused', (await product({})).status === 200
        && (await api('/api/inventory/update', 'PUT', c.staff, { product_id: 3, product_name: 'Round gallon refill', category: 'Water', unit: 'gallon', price: 30, quantity: 5, minimum_stock: 1, supplier_name: '' })).status === 409);
    check('Changing your own password to "1" is refused', (await api('/api/users/change-password', 'POST', c.staff, { current_password: PASSWORD, new_password: '1' })).status === 400);

    // ---------- refill vs. new gallon pricing ----------
    const refillOnly = await api('/api/customer/orders', 'POST', c.customer, { product_id: 1, quantity: 1, fulfillment_method: 'pickup', with_new_container: true });
    check('A refill-only product cannot be ordered with a new gallon', refillOnly.status === 400, refillOnly.data.message);
    check('Staff set a new gallon price on a product', (await api('/api/inventory/update', 'PUT', c.staff, { product_id: 1, product_name: 'Round gallon refill', category: 'Water', unit: 'gallon', price: 30, new_container_price: 100, quantity: await stock(), minimum_stock: 5, supplier_name: '' })).status === 200);
    check('A new gallon price of "abc" is refused', (await api('/api/inventory/update', 'PUT', c.staff, { product_id: 1, product_name: 'Round gallon refill', category: 'Water', unit: 'gallon', price: 30, new_container_price: 'abc', quantity: await stock(), minimum_stock: 5, supplier_name: '' })).status === 400);
    const listed = (await api('/api/customer/products', 'GET', c.customer)).data.products.find(p => p.product_id === 1);
    check('Customers see both the refill and the new gallon price', listed.price === 30 && listed.new_container_price === 100);
    const refill = await api('/api/customer/orders', 'POST', c.customer, { product_id: 1, quantity: 2, fulfillment_method: 'delivery' });
    check('A refill costs only the refill price (2 × ₱30, free delivery)', refill.status === 200 && refill.data.total_amount === 60 && refill.data.service_fee === 0, JSON.stringify(refill.data));
    const withGallon = await api('/api/customer/orders', 'POST', c.customer, { product_id: 1, quantity: 2, fulfillment_method: 'delivery', with_new_container: true, unit_price: 1 });
    check('A new gallon + water costs refill + gallon (2 × ₱130, free delivery), whatever price the request claims', withGallon.status === 200 && withGallon.data.total_amount === 260, JSON.stringify(withGallon.data));
    const gallonOrder = await newest('customer');
    check('The order and its delivery say "with new gallon"', /with new gallon/.test(gallonOrder.order_items)
        && /with new gallon/.test((await query('SELECT delivery_items FROM delivery_schedules WHERE order_id = ?', [gallonOrder.order_id]))[0].delivery_items));
    check('The refill order does not say "with new gallon"', !/with new gallon/.test((await api('/api/customer/orders', 'GET', c.customer)).data.orders.find(o => o.order_id === gallonOrder.order_id - 1).order_items));

    // ---------- station gallons lent / returned ----------
    const lend = (body, who = c.staff) => api('/api/gallons/record', 'POST', who, { customer_id: 1, ...body });
    check('Staff record 3 gallons lent to a customer', (await lend({ kind: 'lent', quantity: 3, note: 'round gallons' })).status === 200);
    check('Returning 2 leaves 1 with the customer', (await lend({ kind: 'returned', quantity: 2 })).data.still_out === 1);
    check('A customer cannot return more station gallons than they hold', (await lend({ kind: 'returned', quantity: 5 })).status === 400);
    check('Zero, decimal, or made-up entries are refused', (await lend({ kind: 'lent', quantity: 0 })).status === 400 && (await lend({ kind: 'lent', quantity: 1.5 })).status === 400 && (await lend({ kind: 'stolen', quantity: 1 })).status === 400);
    check('Drivers and customers cannot edit the gallon records', (await lend({ kind: 'lent', quantity: 1 }, c.driver)).status === 403 && (await lend({ kind: 'lent', quantity: 1 }, c.customer)).status === 403);
    const door = await order('customer', 1);
    await api('/api/deliveries/status', 'PUT', c.driver, { delivery_id: door.delivery_id, status: 'out_for_delivery' });
    const doorDrop = await api('/api/deliveries/status', 'PUT', c.driver, { delivery_id: door.delivery_id, status: 'delivered', gallons_lent: 2, gallons_returned: 1 });
    check('The driver records gallons lent and collected at the drop-off', doorDrop.status === 200 && /2 gallons lent/.test(doorDrop.data.message) && /1 gallon returned/.test(doorDrop.data.message), doorDrop.data.message);
    const mine2 = (await api('/api/customer/gallons', 'GET', c.customer)).data;
    check('The customer sees how many station gallons they hold', mine2.still_out === 2, JSON.stringify(mine2));
    check('Customers cannot see other customers\' gallon records', (await api('/api/gallons?customer_id=2', 'GET', c.customer)).status === 403);
    const gallonReport = (await api('/api/reports/gallons', 'GET', c.staff)).data.report;
    check('The gallon report shows lent, returned, still out, and new gallons bought', gallonReport.some(r => r.customer_id === 1 && r.lent === 5 && r.returned === 3 && r.still_out === 2));

    // ---------- pickups are confirmed by staff, not by the customer ----------
    const pick = await order('customer', 1, 'pickup');
    check('A customer cannot mark their own pickup as collected', (await api('/api/customer/orders/complete', 'PUT', c.customer, { order_id: pick.order_id })).status === 403
        && (await query('SELECT status FROM orders WHERE order_id = ?', [pick.order_id]))[0].status === 'pending');

    // ---------- portal login for a customer without email ----------
    const walkIn = await api('/api/customers/add', 'POST', c.staff, { customer_name: 'Lola Remedios', contact_number: '09170000077', city: 'Legazpi City', barangay: 'Bitano', street: 'Rizal St', house_number: '7' });
    const walkInId = (await query("SELECT customer_id FROM customers WHERE customer_name = 'Lola Remedios'"))[0]?.customer_id;
    const makeLogin = (body, who = c.staff) => api('/api/customers/account/create', 'POST', who, { customer_id: walkInId, username: 'lola.remedios', password: 'Olv-Abcd-2345!', ...body });
    check('Staff add a walk-in customer without email', walkIn.status === 200 && walkInId);
    check('A weak password or a taken username is refused', (await makeLogin({ password: 'lola' })).status === 400 && (await makeLogin({ username: 'a_customer' })).status === 409);
    check('Drivers and customers cannot create logins', (await makeLogin({}, c.driver)).status === 403 && (await makeLogin({}, c.customer)).status === 403);
    check('Staff create a portal login for the walk-in customer', (await makeLogin({})).status === 200);
    check('A second login for the same customer is refused', (await makeLogin({ username: 'lola.two' })).status === 409);
    const lola = await api('/login', 'POST', '', { username: 'lola.remedios', password: 'Olv-Abcd-2345!' });
    check('The customer can sign in with it and order', lola.status === 200 && (await api('/api/customer/orders', 'POST', lola.cookie, { product_id: 1, quantity: 1, fulfillment_method: 'pickup' })).status === 200);

    // ---------- database backups (admin only) ----------
    check('Staff and drivers cannot make or download backups', (await api('/api/backups/now', 'POST', c.staff, {})).status === 403 && (await api('/api/backups', 'GET', c.driver)).status === 403);
    const backupNow = await api('/api/backups/now', 'POST', c.admin, {});
    check('The admin makes a backup', backupNow.status === 200 && /olv-backup-/.test(backupNow.data.message), JSON.stringify(backupNow.data));
    const backupList = (await api('/api/backups', 'GET', c.admin)).data;
    check('The backup is listed with its size', backupList.count >= 1 && backupList.latest.size > 0);
    const downloaded = await fetch(t.base + '/api/backups/download', { headers: { Cookie: c.admin } });
    const bytes = Buffer.from(await downloaded.arrayBuffer());
    check('The backup downloads as a real database file', downloaded.status === 200 && bytes.subarray(0, 15).toString() === 'SQLite format 3');
    check('Only listed backup files can be downloaded', (await api('/api/backups/download?name=..%2F..%2Fapp.js', 'GET', c.admin)).status === 404);

    // ---------- activity log (admin only) ----------
    const log = (await api('/api/activity-logs?q=Cancelled', 'GET', c.admin)).data;
    check('The activity log shows readable actions with the person and the record', log.entries.some(e => e.action === 'Cancelled an order' && e.actor_name === 'Audit Staff' && /order #\d+/.test(e.details)), JSON.stringify(log.entries.slice(0, 2)));
    check('Sign-ins are recorded', (await api('/api/activity-logs?q=Signed%20in', 'GET', c.admin)).data.total >= 1);
    check('The log can be filtered by role', (await api('/api/activity-logs?role=driver', 'GET', c.admin)).data.entries.every(e => e.actor_role === 'driver'));
    check('Passwords are never in the activity log', !(await query('SELECT GROUP_CONCAT(COALESCE(description, "") || COALESCE(details, "")) AS all_text FROM activity_logs'))[0].all_text.includes('Olv-Abcd-2345!'));
    check('Staff cannot open the activity log', (await api('/api/activity-logs', 'GET', c.staff)).status === 403 && (await api('/activity-log', 'GET', c.staff)).status === 403);

    // ---------- who may do what ----------
    for (const [route, method] of [['/api/users', 'GET'], ['/api/customer-accounts', 'GET'], ['/api/setup-status', 'GET'], ['/api/deliveries/settings', 'PUT'], ['/api/reports/email', 'POST'], ['/api/users/create', 'POST']]) {
        check(`Staff cannot use the admin-only ${method} ${route}`, (await api(route, method, c.staff, method === 'GET' ? undefined : {})).status === 403);
    }
    for (const route of ['/api/inventory', '/api/orders', '/api/customers', '/api/reports/sales', '/api/remittance']) {
        check(`Customers cannot open ${route}`, (await api(route, 'GET', c.customer)).status === 403);
    }
    for (const route of ['/api/inventory', '/api/orders', '/api/customers', '/api/reports/remittance']) {
        check(`Drivers cannot open ${route}`, (await api(route, 'GET', c.driver)).status === 403);
    }
    check('The leftover /api/admin-test route is gone', (await api('/api/admin-test', 'GET', c.admin)).status === 404);

    // ---------- sign-out rules ----------
    await api('/api/customers/archive', 'PUT', c.admin, { customer_id: 2 });
    check('An archived customer who is still signed in is signed out at once', (await api('/api/customer/orders', 'GET', c.other)).status === 401);
    check('The system is still running after all of the above', (await api('/login')).status === 200);
    const errors = t.log().split('\n').filter(line => /Unexpected error|TypeError|ReferenceError|SQLITE_ERROR|SQLITE_BUSY/.test(line));
    check('No server errors were logged', errors.length === 0, errors.slice(0, 3).join(' | '));
    await t.stop();

    // Idle sign-out, with the idle time shortened to 4 seconds.
    const s = await startSystem({ OLV_IDLE_SECONDS: '4' });
    let stayed = true;
    for (let i = 0; i < 4; i++) { await wait(2500); if ((await s.api('/api/deliveries', 'GET', s.c.driver)).status !== 200) stayed = false; }
    check('Someone who keeps using the system stays signed in past the idle time', stayed);
    await wait(5500);
    check('After the idle time without activity, they are signed out', (await s.api('/api/deliveries', 'GET', s.c.driver)).status === 401);
    await s.stop();

    console.log(`\nAll ${passed} audit checks passed.`);
}

main().catch(error => { console.error(error); for (const server of servers) server.kill(); process.exit(1); });
