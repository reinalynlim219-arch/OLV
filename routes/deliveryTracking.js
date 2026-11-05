// Delivery tracking log. Triggers record every status and schedule change,
// whichever page or route makes it, so the timeline cannot drift from the
// delivery record. (No live GPS tracking; see the project's scope limits.)
module.exports = function deliveryTracking({ db, requireUser, sendJSON }) {
    const run = sql => new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));
    const get = (sql, values) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
    const all = (sql, values) => new Promise((resolve, reject) => db.all(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));

    // Called after the delivery table migrations, because rebuilding that
    // table drops any triggers attached to it.
    async function setup() {
        await run(`CREATE TABLE IF NOT EXISTS delivery_tracking (
            event_id INTEGER PRIMARY KEY AUTOINCREMENT,
            delivery_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            note TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await run('CREATE INDEX IF NOT EXISTS idx_delivery_tracking_delivery ON delivery_tracking(delivery_id, event_id)');
        // Existing deliveries get one entry for their current state so the
        // timeline is never empty. Times use the best recorded timestamp.
        await run(`INSERT INTO delivery_tracking (delivery_id, status, note, created_at)
            SELECT d.delivery_id, d.status, 'Recorded before delivery tracking was enabled',
                   COALESCE(d.customer_received_at, d.driver_delivered_at, d.delivery_date || ' 00:00:00')
            FROM delivery_schedules d
            WHERE NOT EXISTS (SELECT 1 FROM delivery_tracking t WHERE t.delivery_id = d.delivery_id)`);
        await run(`CREATE TRIGGER IF NOT EXISTS track_delivery_created AFTER INSERT ON delivery_schedules BEGIN
            INSERT INTO delivery_tracking (delivery_id, status, note) VALUES (NEW.delivery_id, NEW.status,
                'Scheduled for ' || NEW.delivery_date || CASE WHEN COALESCE(NEW.delivery_time, '') <> '' THEN ' at ' || NEW.delivery_time ELSE '' END);
        END`);
        // Replaced on every start so databases made by older versions get the newest wording.
        await run('DROP TRIGGER IF EXISTS track_delivery_status');
        await run(`CREATE TRIGGER track_delivery_status AFTER UPDATE OF status ON delivery_schedules
            WHEN OLD.status IS NOT NEW.status BEGIN
            INSERT INTO delivery_tracking (delivery_id, status, note) VALUES (NEW.delivery_id, NEW.status,
                CASE NEW.status
                    WHEN 'out_for_delivery' THEN 'Picked up by ' || COALESCE((SELECT full_name FROM users WHERE user_id = NEW.assigned_to), 'delivery staff')
                    WHEN 'awaiting_customer' THEN COALESCE(NULLIF(NEW.delivery_proof, ''), 'Dropped off by the driver')
                    WHEN 'cancelled' THEN CASE WHEN NEW.delivery_proof LIKE 'Order cancelled%' THEN NEW.delivery_proof ELSE 'Delivery cancelled by staff' END
                    ELSE '' END);
        END`);
        await run(`CREATE TRIGGER IF NOT EXISTS track_delivery_rescheduled AFTER UPDATE OF delivery_date, delivery_time, assigned_to ON delivery_schedules
            WHEN OLD.status IS NEW.status AND (OLD.delivery_date IS NOT NEW.delivery_date OR OLD.delivery_time IS NOT NEW.delivery_time OR OLD.assigned_to IS NOT NEW.assigned_to) BEGIN
            INSERT INTO delivery_tracking (delivery_id, status, note) VALUES (NEW.delivery_id, 'rescheduled',
                'Schedule updated: ' || NEW.delivery_date || CASE WHEN COALESCE(NEW.delivery_time, '') <> '' THEN ' at ' || NEW.delivery_time ELSE '' END
                || ', assigned to ' || COALESCE((SELECT full_name FROM users WHERE user_id = NEW.assigned_to), 'nobody yet'));
        END`);
    }

    async function handle(req, res) {
        const user = requireUser(req, res);
        if (!user) return;
        try {
            const deliveryId = Number(new URL(req.url, 'http://localhost').searchParams.get('delivery_id'));
            if (!Number.isSafeInteger(deliveryId) || deliveryId < 1) return sendJSON(res, 400, { success: false, message: 'Choose a delivery to track.' });
            const delivery = await get(`SELECT d.delivery_id, d.order_id, d.status, d.delivery_date, d.delivery_time, d.delivery_address, d.delivery_items, d.assigned_to,
                    COALESCE(NULLIF(d.customer_name, ''), c.customer_name) AS customer_name, o.customer_id, u.full_name AS assigned_staff
                FROM delivery_schedules d LEFT JOIN orders o ON o.order_id = d.order_id
                LEFT JOIN customers c ON c.customer_id = o.customer_id LEFT JOIN users u ON u.user_id = d.assigned_to
                WHERE d.delivery_id = ?`, [deliveryId]);
            // Customers see only their own deliveries; drivers see their assigned ones
            // and unassigned scheduled ones (the same deliveries shown in their list).
            const allowed = delivery && (['admin', 'staff'].includes(user.role)
                || (user.role === 'driver' && (Number(delivery.assigned_to) === Number(user.user_id)
                    || (delivery.assigned_to == null && delivery.status === 'scheduled')))
                || (user.role === 'customer' && Number(delivery.customer_id) === Number(user.customer_id)));
            if (!allowed) return sendJSON(res, 404, { success: false, message: 'Delivery not found.' });
            const events = await all('SELECT status, note, created_at FROM delivery_tracking WHERE delivery_id = ? ORDER BY created_at, event_id', [deliveryId]);
            delete delivery.customer_id;
            delete delivery.assigned_to;
            sendJSON(res, 200, { success: true, delivery, events });
        } catch (error) {
            console.error('Delivery tracking error:', error);
            sendJSON(res, 500, { success: false, message: 'Unable to load delivery tracking.' });
        }
    }

    return { setup, handle };
};
