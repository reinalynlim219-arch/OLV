// Activity log: who changed what, and when (shown to the admin on the Activity Log page).
// Every successful change is saved with a readable action ("Cancelled an order"), the
// person's name and role, and which record it was about (order #12, status: delivered).
// Passwords, verification codes, photos, names, and addresses are never saved: only
// record numbers and a few safe fields are kept from the request.
const ACTIONS = {
    "POST /logout": "Signed out",
    "POST /api/customer/orders": "Placed an order",
    "PUT /api/customer/orders/cancel": "Cancelled their own order",
    "PUT /api/customer/delivery/received": "Confirmed an order was received",
    "POST /api/customer/delivery/photo": "Attached a receipt photo",
    "PUT /api/customer/profile": "Updated their delivery details",
    "PUT /api/customer/location": "Saved their home location",
    "PUT /api/customer/account": "Changed their login",
    "POST /api/customer/account/deactivate": "Closed their account",
    "POST /api/customers/add": "Added a customer",
    "PUT /api/customers/update": "Edited a customer",
    "PUT /api/customers/archive": "Archived a customer",
    "PUT /api/customers/restore": "Restored a customer",
    "DELETE /api/customers/delete": "Deleted a customer",
    "POST /api/customers/account/create": "Created a customer login",
    "PUT /api/customers/account": "Changed a customer login",
    "POST /api/customers/email/request": "Sent a customer email change link",
    "POST /api/orders/add": "Created an order",
    "PUT /api/orders/complete": "Completed an order",
    "PUT /api/orders/cancel": "Cancelled an order",
    "POST /api/inventory/add": "Added a product",
    "PUT /api/inventory/update": "Edited a product",
    "PUT /api/inventory/status": "Archived or restored a product",
    "PUT /api/inventory/remove": "Moved a product to Recently removed",
    "PUT /api/inventory/restore": "Restored a product from Recently removed",
    "DELETE /api/inventory/delete": "Deleted a product permanently",
    "POST /api/inventory/stock-in": "Recorded stock in",
    "POST /api/inventory/stock-out": "Recorded stock out",
    "POST /api/deliveries/add": "Scheduled a delivery",
    "PUT /api/deliveries/update": "Edited or assigned a delivery",
    "PUT /api/deliveries/status": "Updated a delivery",
    "POST /api/deliveries/plan/start-batch": "Sent out a delivery trip",
    "PUT /api/deliveries/settings": "Changed the delivery settings",
    "PUT /api/remittance/remit": "Received a driver's cash remittance",
    "POST /api/gallons/record": "Recorded station gallons",
    "POST /api/users/create": "Created a staff account",
    "PUT /api/users/update": "Edited a staff account",
    "POST /api/users/change-password": "Changed their password",
    "POST /api/reports/email": "Emailed the station summary",
    "POST /api/reports/generate": "Saved a report",
    "POST /api/backups/now": "Made a database backup",
    "PUT /api/orders/approve": "Approved an order"
};
// Safe request fields that say which record a change was about.
const DETAIL_FIELDS = [["order_id", "order #"], ["delivery_id", "delivery #"], ["product_id", "product #"], ["customer_id", "customer #"], ["user_id", "account #"],
    ["status", "status: "], ["kind", ""], ["quantity", "quantity: "], ["fulfillment_method", ""], ["role", "role: "]];
const STATUS_WORDS = { out_for_delivery: "started (out for delivery)", delivered: "dropped off", cancelled: "cancelled", scheduled: "scheduled", active: "active", archived: "archived", inactive: "inactive" };

function describe(body) {
    if (!body || typeof body !== "object") return "";
    const parts = [];
    for (const [field, prefix] of DETAIL_FIELDS) {
        const value = body[field];
        if (value === undefined || value === null || value === "" || typeof value === "object") continue;
        const text = field === "status" ? (STATUS_WORDS[value] || String(value)) : String(value);
        if (/^[\w .#:-]{1,40}$/.test(text)) parts.push(prefix + text);
    }
    if (Array.isArray(body.delivery_ids) && body.delivery_ids.length) parts.push(`${body.delivery_ids.length} ${body.delivery_ids.length === 1 ? "delivery" : "deliveries"}`);
    return parts.join(", ");
}

module.exports = function activityLog(db) {
    const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, error => error ? reject(error) : resolve()));
    const ready = run(`CREATE TABLE IF NOT EXISTS activity_logs (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action TEXT NOT NULL,
        description TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).then(async () => {
        // Readable columns (older logs only have action/description).
        for (const [column, type] of [["actor_name", "TEXT"], ["actor_role", "TEXT"], ["customer_id", "INTEGER"], ["route", "TEXT"], ["details", "TEXT"]]) {
            await run(`ALTER TABLE activity_logs ADD COLUMN ${column} ${type}`).catch(() => { /* already there */ });
        }
    });

    function save(user, label, route, details = "") {
        ready.then(() => db.run(
            "INSERT INTO activity_logs(user_id, action, description, actor_name, actor_role, customer_id, route, details) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            [user.role === "customer" ? null : user.user_id, label, `${label}${details ? ` (${details})` : ""}`,
                String(user.full_name || user.username || "").slice(0, 80), user.role, user.role === "customer" ? user.customer_id : null, route, details],
            error => { if (error) console.error("Unable to save activity log:", error.message); }))
            .catch(error => console.error("Unable to initialize activity log:", error.message));
    }

    function watch(req, res, user) {
        if (!user || !["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) return;
        const route = req.url.split("?")[0];
        const key = `${req.method} ${route}`;
        // The request body as the route parsed it (getRequestBody keeps it on req.olvBody);
        // only the safe fields listed above are kept from it.
        res.once("finish", () => {
            if (res.statusCode < 200 || res.statusCode >= 300) return;
            save(user, ACTIONS[key] || key, route, describe(req.olvBody));
        });
    }
    // Sign-ins happen before there is a session, so the login route records them itself.
    watch.signedIn = user => save(user, "Signed in", "/login");
    return watch;
};
// Older log lines saved "PUT /api/orders/cancel"; the viewer turns them into words too.
module.exports.ACTIONS = ACTIONS;
