const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');

// In-memory fixtures only. No live deliveries are touched.
const db = new sqlite3.Database(':memory:');
const run = sql => new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));
const all = sql => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
const tracking = require('../routes/deliveryTracking')({
    db, requireUser: req => req.user, sendJSON: (res, status, body) => res.finish({ status, body })
});
const call = (id, user) => new Promise(resolve => tracking.handle({ url: '/api/deliveries/tracking?delivery_id=' + id, user }, { finish: resolve }));

async function test() {
    await run('CREATE TABLE users (user_id INTEGER PRIMARY KEY, full_name TEXT)');
    await run('CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, customer_name TEXT)');
    await run('CREATE TABLE orders (order_id INTEGER PRIMARY KEY, customer_id INTEGER)');
    await run(`CREATE TABLE delivery_schedules (delivery_id INTEGER PRIMARY KEY, order_id INTEGER, customer_name TEXT DEFAULT '', delivery_items TEXT, delivery_date TEXT,
        delivery_time TEXT, delivery_address TEXT, assigned_to INTEGER, status TEXT, delivery_proof TEXT DEFAULT '', driver_delivered_at DATETIME, customer_received_at DATETIME)`);
    await run("INSERT INTO users VALUES (7, 'Driver Dan'), (8, 'Other Driver')");
    await run("INSERT INTO customers VALUES (1, 'Ana'), (2, 'Ben')");
    await run('INSERT INTO orders VALUES (10, 1), (11, 2)');
    // A delivery that existed before tracking was switched on.
    await run("INSERT INTO delivery_schedules (delivery_id, order_id, delivery_date, status, driver_delivered_at) VALUES (1, 11, '2026-09-01', 'awaiting_customer', '2026-09-01 03:00:00')");
    await tracking.setup();
    await tracking.setup(); // Safe to run on every start.
    assert.equal((await all('SELECT * FROM delivery_tracking WHERE delivery_id = 1')).length, 1);

    await run("INSERT INTO delivery_schedules (delivery_id, order_id, delivery_items, delivery_date, delivery_time, status) VALUES (2, 10, '5 gallons', '2026-10-01', '09:00', 'scheduled')");
    await run("UPDATE delivery_schedules SET assigned_to = 7, delivery_time = '10:00' WHERE delivery_id = 2");
    await run("UPDATE delivery_schedules SET status = 'out_for_delivery' WHERE delivery_id = 2");
    await run("UPDATE delivery_schedules SET status = 'out_for_delivery' WHERE delivery_id = 2"); // No change, no entry.
    await run("UPDATE delivery_schedules SET status = 'awaiting_customer', delivery_proof = 'Driver location verified' WHERE delivery_id = 2");
    await run("UPDATE delivery_schedules SET status = 'delivered' WHERE delivery_id = 2");
    const events = (await call(2, { role: 'staff', user_id: 1 })).body.events;
    assert.deepEqual(events.map(event => event.status), ['scheduled', 'rescheduled', 'out_for_delivery', 'awaiting_customer', 'delivered']);
    assert.match(events[1].note, /10:00.*Driver Dan/);
    assert.match(events[2].note, /Driver Dan/);
    assert.equal(events[3].note, 'Driver location verified');

    assert.equal((await call(2, { role: 'customer', customer_id: 1 })).status, 200);
    assert.equal((await call(2, { role: 'customer', customer_id: 2 })).status, 404, "customers cannot see another customer's delivery");
    assert.equal((await call(2, { role: 'driver', user_id: 7 })).status, 200);
    assert.equal((await call(2, { role: 'driver', user_id: 8 })).status, 404, 'drivers see only assigned deliveries');
    assert.equal((await call('abc', { role: 'staff' })).status, 400);
    const customerView = (await call(2, { role: 'customer', customer_id: 1 })).body.delivery;
    assert.equal(customerView.customer_id, undefined);
    console.log('Delivery tracking: backfill, repeat-safe setup, status/schedule history, no duplicate entries, and customer/driver access limits passed.');
}
test().then(() => db.close()).catch(error => { console.error(error); db.close(); process.exitCode = 1; });
