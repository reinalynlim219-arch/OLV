// Customer history page and data. (The Container Tracking area was removed from
// the system; its tables are kept so saved container records are not lost and
// the customer-delete safety check still sees them.)
module.exports = function stationRecords({ db, requireUser, sendJSON, servePage }) {
    const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, function(error) { error ? reject(error) : resolve(this); }));
    const get = (sql, values = []) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
    const all = (sql, values = []) => new Promise((resolve, reject) => db.all(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
    const ready = (async () => {
        await run(`CREATE TABLE IF NOT EXISTS containers (
            container_id INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT UNIQUE NOT NULL,
            description TEXT NOT NULL, status TEXT NOT NULL, customer_id INTEGER,
            note TEXT NOT NULL, updated_by INTEGER NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE TABLE IF NOT EXISTS container_events (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT, container_id INTEGER NOT NULL,
            old_status TEXT, new_status TEXT NOT NULL, customer_id INTEGER,
            note TEXT NOT NULL, user_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        // Triggers keep the history and the current status in the same atomic write.
        await run(`CREATE TRIGGER IF NOT EXISTS log_container_created AFTER INSERT ON containers BEGIN
            INSERT INTO container_events(container_id, old_status, new_status, customer_id, note, user_id)
            VALUES(NEW.container_id, NULL, NEW.status, NEW.customer_id, NEW.note, NEW.updated_by); END`);
        await run(`CREATE TRIGGER IF NOT EXISTS log_container_changed AFTER UPDATE OF status ON containers BEGIN
            INSERT INTO container_events(container_id, old_status, new_status, customer_id, note, user_id)
            VALUES(NEW.container_id, OLD.status, NEW.status, COALESCE(NEW.customer_id, OLD.customer_id), NEW.note, NEW.updated_by); END`);
    })();
    return async function handle(req, res) {
        const user = requireUser(req, res);
        if (!user) return;
        if (!['admin', 'staff'].includes(user.role)) return sendJSON(res, 403, { success: false, message: 'Staff or administrator access is required.' });
        const url = new URL(req.url, 'http://localhost');
        try {
            await ready;
            if (req.method === 'GET' && url.pathname === '/customer-history') return servePage('customer-history.html', res);
            if (req.method === 'GET' && url.pathname === '/api/customer-history') {
                const id = Number(url.searchParams.get('id'));
                const customer = await get('SELECT customer_id, customer_name, contact_number, address, status FROM customers WHERE customer_id = ?', [id]);
                if (!customer) return sendJSON(res, 404, { success: false, message: 'Customer not found.' });
                const orders = await all(`SELECT o.order_id, o.order_date, o.total_amount, o.status, o.fulfillment_method,
                    (SELECT GROUP_CONCAT(p.product_name || ' × ' || oi.quantity || CASE WHEN oi.with_new_container = 1 THEN ' (with new gallon)' ELSE '' END, ', ') FROM order_items oi LEFT JOIN products p ON p.product_id = oi.product_id WHERE oi.order_id = o.order_id) AS items
                    FROM orders o WHERE o.customer_id = ? ORDER BY o.order_id DESC`, [id]);
                const deliveries = await all('SELECT d.delivery_id, d.order_id, d.delivery_date, d.status, d.customer_received_at FROM delivery_schedules d JOIN orders o ON o.order_id = d.order_id WHERE o.customer_id = ? ORDER BY d.delivery_id DESC', [id]);
                return sendJSON(res, 200, { success: true, customer, orders, deliveries });
            }
            sendJSON(res, 404, { success: false, message: 'Record route not found.' });
        } catch (error) {
            sendJSON(res, 400, { success: false, message: error.code ? 'Unable to load customer history.' : error.message });
        }
    };
};
