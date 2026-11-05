// Calendar page (/calendar): deliveries and orders for one month, by day.
//  - Admin/staff: every delivery (by scheduled day) and every order (by the day it
//    was placed, Philippine time).
//  - Drivers: only the deliveries assigned to them (no orders).
module.exports = function calendar({ db, requireUser, sendJSON, servePage }) {
    const all = (sql, values = []) => new Promise((resolve, reject) => db.all(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));

    async function handle(req, res, url) {
        const user = requireUser(req, res);
        if (!user) return;
        if (!["admin", "staff", "driver"].includes(user.role)) return sendJSON(res, 403, { success: false, message: "Not allowed." });
        if (url === "/calendar") return servePage("calendar.html", res);
        try {
            const month = new URL(req.url, "http://localhost").searchParams.get("month") || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
            if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return sendJSON(res, 400, { success: false, message: "Choose a month like 2026-10." });
            const driver = user.role === "driver";
            const deliveries = await all(`SELECT d.delivery_id, d.delivery_date AS day, d.delivery_time, d.status, d.delivery_address, d.delivery_items,
                    COALESCE(NULLIF(d.customer_name, ''), c.customer_name) AS customer_name, u.full_name AS driver_name
                FROM delivery_schedules d LEFT JOIN orders o ON o.order_id = d.order_id
                LEFT JOIN customers c ON c.customer_id = o.customer_id LEFT JOIN users u ON u.user_id = d.assigned_to
                WHERE substr(d.delivery_date, 1, 7) = ? ${driver ? "AND d.assigned_to = ?" : ""}
                ORDER BY d.delivery_date, (COALESCE(d.delivery_time, '') = ''), d.delivery_time, d.delivery_id`, driver ? [month, user.user_id] : [month]);
            const orders = driver ? [] : await all(`SELECT o.order_id, date(o.order_date, '+8 hours') AS day, o.total_amount, o.status,
                    COALESCE(o.fulfillment_method, 'delivery') AS fulfillment_method, o.preferred_date, c.customer_name
                FROM orders o LEFT JOIN customers c ON c.customer_id = o.customer_id
                WHERE substr(date(o.order_date, '+8 hours'), 1, 7) = ?
                ORDER BY o.order_date, o.order_id`, [month]);
            sendJSON(res, 200, { success: true, month, role: user.role, deliveries, orders });
        } catch (error) {
            console.error("Calendar error:", error);
            sendJSON(res, 500, { success: false, message: "Unable to load the calendar." });
        }
    }

    return { ROUTES: ["/calendar", "/api/calendar"], handle };
};
