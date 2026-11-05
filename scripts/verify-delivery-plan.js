// Checks delivery batches, route order, expected delivery times, and cash remittance
// against a throwaway database. Never touches the user's live database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const bcrypt = require('bcrypt');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'olv-plan-test-'));
const dbPath = path.join(work, 'test.db');
let server, db, output = '';
const env = { ...process.env, OLV_DB_PATH: dbPath, GMAIL_USER: '', GMAIL_APP_PASSWORD: '', OLV_DISABLE_AUTO_BACKUP: '1', HTTPS_KEY: '', HTTPS_CERT: '', ROUTING_RETRY_MS: '0' };

// A stand-in routing server (OSRM "table" service), so the test needs no internet.
// Its roads are 1.5 times the straight line, at 10 m per second. It can be switched off.
let routingUp = false;
const routing = require('node:http').createServer((req, res) => {
    const match = /^\/table\/v1\/driving\/([^?]+)/.exec(req.url);
    if (!routingUp || !match) { res.writeHead(503); return res.end('{}'); }
    const points = match[1].split(';').map(pair => pair.split(',').map(Number));
    const straight = ([lng1, lat1], [lng2, lat2]) => {
        const r = v => v * Math.PI / 180, h = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
        return 2 * 6371000 * Math.asin(Math.sqrt(h));
    };
    const distances = points.map(a => points.map(b => straight(a, b) * 1.5));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'Ok', distances, durations: distances.map(row => row.map(m => m / 10)) }));
});
const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, function (error) { error ? reject(error) : resolve(this); }));
const get = (sql, values = []) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
let passed = 0;
function check(name, condition) { assert.ok(condition, name); passed++; console.log('PASS:', name); }

async function main() {
    const init = spawnSync(process.execPath, ['database/init.js'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    db = new sqlite3.Database(dbPath);
    const password = 'TestStation2026!';
    const hash = await bcrypt.hash(password, 10);
    await run("INSERT INTO users(username,password,full_name,contact_number,role) VALUES('testadmin',?,'Test Admin','09123456789','admin'),('teststaff',?,'Test Staff','09123456788','staff'),('testdriver',?,'Test Driver','09123456780','driver'),('otherdriver',?,'Other Driver','09123456781','driver')", [hash, hash, hash, hash]);
    await run("INSERT INTO products(product_name,category,unit,price,status) VALUES('Round gallon refill','Water','gallon',30,'active')");
    await run("INSERT INTO inventory(product_id,quantity,minimum_stock,stock_status) VALUES(1,500,5,'available')");

    // Station at 13.1440, 123.7500. Customers north of it, in a line:
    //   D 22 m (walk-over), B 500 m, C 1 km, A 2 km, E has no saved location.
    // Waiting order (oldest first): A 30 gal, B 30 gal, C 15 gal, D 1 gal, E 5 gal.
    const customers = [
        ['A', 13.1620, 30], ['B', 13.1485, 30], ['C', 13.1530, 15], ['D', 13.1442, 1], ['E', null, 5]
    ];
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const ids = {};
    for (const [name, lat, gallons] of customers) {
        const c = await run("INSERT INTO customers(customer_name,contact_number,address,city,barangay,street,house_number,latitude,longitude,customer_type,status) VALUES(?,?,?,?,?,?,?,?,?,'Regular','active')",
            [`Customer ${name}`, '0912345670' + Object.keys(ids).length, `${name} Street`, 'Legazpi City', 'Bitano', `${name} Street`, '1', lat, lat == null ? null : 123.7500]);
        const total = gallons * 30 + 5;
        const o = await run("INSERT INTO orders(customer_id,total_amount,service_fee,fulfillment_method,status) VALUES(?,?,5,'delivery','pending')", [c.lastID, total]);
        await run("INSERT INTO order_items(order_id,product_id,quantity,unit_price,subtotal) VALUES(?,1,?,30,?)", [o.lastID, gallons, gallons * 30]);
        const d = await run("INSERT INTO delivery_schedules(order_id,customer_name,contact_number,delivery_reason,delivery_items,delivery_date,delivery_time,delivery_address,status) VALUES(?,?,?,'Customer order delivery',?,?,'',?,'scheduled')",
            [o.lastID, `Customer ${name}`, '09123456700', `Round gallon refill × ${gallons}`, today, `${name} Street, Bitano, Legazpi City`]);
        ids[name] = { customer: c.lastID, order: o.lastID, delivery: d.lastID, total };
    }
    await run("INSERT INTO customer_accounts(customer_id,username,password,status) VALUES(?,'customerc',?,'active')", [ids.C.customer, hash]);

    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    env.PORT = String(port);
    await new Promise(resolve => routing.listen(0, '127.0.0.1', resolve));
    env.ROUTING_URL = `http://127.0.0.1:${routing.address().port}`;
    server = spawn(process.execPath, ['app.js'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', chunk => { output += chunk; });
    server.stderr.on('data', chunk => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    let connected = false;
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/')).ok) { connected = true; break; } } catch { } await wait(100); }
    assert.ok(connected, output);
    await wait(400);
    async function api(route, method = 'GET', cookie = '', body) {
        const response = await fetch(base + route, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
        const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
        return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    async function login(username) { const r = await api('/login', 'POST', '', { username, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.cookie; }
    const admin = await login('testadmin'), staff = await login('teststaff'), driver = await login('testdriver'), otherDriver = await login('otherdriver'), customer = await login('customerc');
    const driverId = (await get("SELECT user_id FROM users WHERE username='testdriver'")).user_id;

    // ---------- settings ----------
    const settings = { vehicle_capacity: 50, first_trip: '00:00', last_trip: '23:59', trip_minutes: 60, walk_radius_m: 100, station_latitude: 13.1440, station_longitude: 123.7500 };
    check('Staff cannot change delivery settings', (await api('/api/deliveries/settings', 'PUT', staff, settings)).status === 403);
    check('Drivers cannot change delivery settings', (await api('/api/deliveries/settings', 'PUT', driver, settings)).status === 403);
    check('A station outside Legazpi City and Daraga is rejected', (await api('/api/deliveries/settings', 'PUT', admin, { ...settings, station_latitude: 14.6, station_longitude: 121 })).status === 400);
    check('Zero vehicle capacity is rejected', (await api('/api/deliveries/settings', 'PUT', admin, { ...settings, vehicle_capacity: 0 })).status === 400);
    check('A last trip before the first trip is rejected', (await api('/api/deliveries/settings', 'PUT', admin, { ...settings, first_trip: '17:00', last_trip: '08:00' })).status === 400);
    check('Admin saves delivery settings', (await api('/api/deliveries/settings', 'PUT', admin, settings)).status === 200);

    // ---------- batches and route order ----------
    check('Customers cannot open the delivery plan', (await api('/api/deliveries/plan', 'GET', customer)).status === 403);
    // Routing server down: the plan still works, with straight-line distances.
    let plan = (await api('/api/deliveries/plan', 'GET', staff)).data;
    check('Without the routing server, the plan falls back to straight-line distance',
        plan.distance_source === 'straight' && Math.abs(plan.batches[1].stops[0].leg_m - 500) < 15 && plan.batches[1].drive_minutes == null);
    routingUp = true;
    plan = (await api('/api/deliveries/plan', 'GET', staff)).data;
    check('With the routing server, the plan uses road distances', plan.distance_source === 'road');
    const stopIds = list => list.map(s => s.delivery_id);
    check('Waiting gallons are split into trips by vehicle capacity', plan.batches.length === 2 && plan.batches[0].gallons === 30 && plan.batches[1].gallons === 50);
    check('A trip never carries more than the vehicle capacity', plan.batches.every(b => b.gallons <= b.capacity));
    check('The oldest order goes in the first trip', stopIds(plan.batches[0].stops).join() === String(ids.A.delivery));
    check('Stops inside a trip are nearest-first from the station, unknown locations last',
        stopIds(plan.batches[1].stops).join() === [ids.B.delivery, ids.C.delivery, ids.E.delivery].join());
    check('Road distances are measured from the station, then stop to stop',
        Math.abs(plan.batches[1].stops[0].leg_m - 750) < 20 && Math.abs(plan.batches[1].stops[1].leg_m - 750) < 20);
    check('Each stop shows its driving time', Math.abs(plan.batches[1].stops[0].leg_s - 75) < 3);
    // Station -> B (750) -> C (750) -> back to the station (1500 by road); E has no location.
    check('Each trip shows its road distance and driving time, back to the station',
        Math.abs(plan.batches[1].route_m - 3000) < 40 && plan.batches[1].drive_minutes === 5);
    check('A customer within walking distance does not use the vehicle',
        stopIds(plan.nearby.stops).join() === String(ids.D.delivery) && !plan.batches.some(b => stopIds(b.stops).includes(ids.D.delivery)));
    const leaves = plan.batches.map(b => Date.parse(b.leaves_at));
    check('The second trip leaves one trip-length after the first', leaves[1] - leaves[0] === 60 * 60000);
    check('The first trip leaves now (within the trip hours)', Math.abs(leaves[0] - Date.now()) < 2 * 60000);

    let mine = (await api('/api/customer/orders', 'GET', customer)).data.orders[0];
    check('The customer sees an expected delivery time with their trip', mine.eta && mine.eta.kind === 'batch' && mine.eta.batch === 2 && Date.parse(mine.eta.from) === leaves[1]);

    // ---------- taking a batch ----------
    const batch2 = stopIds(plan.batches[1].stops);
    check('A driver who takes a batch gets it, even when asking to give it to someone else',(await api('/api/deliveries/plan/start-batch', 'POST', driver, { delivery_ids: batch2, assigned_to: 4 })).status === 200
        && (await get('SELECT COUNT(*) AS n FROM delivery_schedules WHERE assigned_to = ? AND status = ?', [driverId, 'out_for_delivery'])).n === 3);
    check('A second driver cannot take the same batch', (await api('/api/deliveries/plan/start-batch', 'POST', otherDriver, { delivery_ids: batch2 })).status === 409);
    plan = (await api('/api/deliveries/plan', 'GET', driver)).data;
    check('The driver sees their trip in route order', plan.trips_out.length === 1 && stopIds(plan.trips_out[0].stops).join() === batch2.join());
    check('Other drivers do not see that trip', (await api('/api/deliveries/plan', 'GET', otherDriver)).data.trips_out.length === 0);
    check('The next trip waits for the vehicle to come back', Math.abs(Date.parse(plan.batches[0].leaves_at) - (Date.now() + 60 * 60000)) < 2 * 60000);
    mine = (await api('/api/customer/orders', 'GET', customer)).data.orders[0];
    check('The customer sees their stop number while the trip is out', mine.eta && mine.eta.kind === 'on_the_way' && mine.eta.stop_number === 2 && mine.eta.stops === 3);
    check('Staff can send out a batch with a chosen driver', (await api('/api/deliveries/plan/start-batch', 'POST', staff, { delivery_ids: [ids.A.delivery], assigned_to: 4 })).status === 200
        && (await get('SELECT assigned_to FROM delivery_schedules WHERE delivery_id = ?', [ids.A.delivery])).assigned_to === 4);
    check('Staff cannot send out a batch with an unknown driver', (await api('/api/deliveries/plan/start-batch', 'POST', staff, { delivery_ids: [ids.D.delivery], assigned_to: 999 })).status === 400);

    // ---------- cash remittance ----------
    check('Drop-off with cash records the order total for the driver',
        (await api('/api/deliveries/status', 'PUT', staff, { delivery_id: ids.B.delivery, status: 'delivered', cash_collected: true })).status === 200
        && (await get('SELECT cash_collected, cash_collected_by FROM delivery_schedules WHERE delivery_id = ?', [ids.B.delivery])).cash_collected === ids.B.total
        && (await get('SELECT cash_collected_by FROM delivery_schedules WHERE delivery_id = ?', [ids.B.delivery])).cash_collected_by === driverId);
    check('Drop-off without cash records no cash',
        (await api('/api/deliveries/status', 'PUT', staff, { delivery_id: ids.E.delivery, status: 'delivered', cash_collected: false })).status === 200
        && (await get('SELECT cash_collected FROM delivery_schedules WHERE delivery_id = ?', [ids.E.delivery])).cash_collected == null);
    await api('/api/deliveries/status', 'PUT', staff, { delivery_id: ids.C.delivery, status: 'delivered', cash_collected: true });
    let remit = (await api('/api/remittance', 'GET', driver)).data;
    check('The driver sees how much cash to hand over', remit.drivers.length === 1 && remit.drivers[0].amount === ids.B.total + ids.C.total && remit.drivers[0].deliveries.length === 2);
    check('Other drivers do not see that cash', (await api('/api/remittance', 'GET', otherDriver)).data.drivers.length === 0);
    remit = (await api('/api/remittance', 'GET', staff)).data;
    const owed = remit.drivers.find(d => d.driver_id === driverId);
    check('Management sees how much each driver should remit', owed && owed.amount === ids.B.total + ids.C.total);
    check('Drivers cannot mark their own cash as remitted', (await api('/api/remittance/remit', 'PUT', driver, { driver_id: driverId, delivery_ids: owed.deliveries.map(d => d.delivery_id) })).status === 403);
    check('Customers cannot see remittance', (await api('/api/remittance', 'GET', customer)).status === 403);
    const received = await api('/api/remittance/remit', 'PUT', staff, { driver_id: driverId, delivery_ids: owed.deliveries.map(d => d.delivery_id) });
    check('Staff records the remittance for the amount shown', received.status === 200 && received.data.amount === ids.B.total + ids.C.total);
    check('The same cash cannot be remitted twice', (await api('/api/remittance/remit', 'PUT', staff, { driver_id: driverId, delivery_ids: owed.deliveries.map(d => d.delivery_id) })).status === 409);
    remit = (await api('/api/remittance', 'GET', driver)).data;
    check('After remitting, the driver owes nothing and sees the record', remit.drivers.length === 0 && remit.recent.length === 1 && remit.recent[0].amount === ids.B.total + ids.C.total);

    // ---------- remittance report ----------
    const report = await api('/api/reports/remittance', 'GET', staff);
    check('The remittance report lists each cash delivery as remitted', report.status === 200 && report.data.report.length === 2
        && report.data.report.every(row => row.remittance_status === 'remitted' && row.driver === 'Test Driver' && row.received_by === 'Test Staff'));
    check('Drivers cannot open the remittance report', (await api('/api/reports/remittance', 'GET', driver)).status === 403);

    // ---------- setup reminder and sign-in limits ----------
    const setup = (await api('/api/setup-status', 'GET', admin)).data;
    check('The setup reminder sees the saved station and missing email', setup.station_location === true && setup.email === false && setup.default_passwords.length === 0);
    await run("UPDATE users SET password = ? WHERE username = 'otherdriver'", [await bcrypt.hash('admin123', 10)]);
    check('The setup reminder flags an account with a default password', (await api('/api/setup-status', 'GET', admin)).data.default_passwords.join() === 'otherdriver');
    check('Only the admin sees the setup reminder', (await api('/api/setup-status', 'GET', staff)).status === 403);
    for (let i = 0; i < 5; i++) await api('/login', 'POST', '', { username: 'teststaff', password: 'wrong-password' });
    check('After 5 wrong passwords, even the right one must wait', (await api('/login', 'POST', '', { username: 'teststaff', password })).status === 429);
    check('Other accounts can still sign in', (await api('/login', 'POST', '', { username: 'testadmin', password })).status === 200);

    console.log(`\nAll ${passed} delivery plan checks passed.`);
}

main().catch(error => { console.error(error); console.error(output); process.exitCode = 1; }).finally(() => {
    if (server) server.kill();
    routing.close();
    if (db) db.close();
    setTimeout(() => fs.rmSync(work, { recursive: true, force: true }), 300);
});
