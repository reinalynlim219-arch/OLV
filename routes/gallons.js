// Station gallons: which customers hold the station's gallons, and how many new
// gallons each customer bought.
//  - Lending: staff (or the driver at a drop-off) record gallons LENT to a customer
//    and gallons RETURNED. "Still out" = lent − returned, per customer.
//  - Bought: new gallons a customer paid for (order items "with new gallon" in
//    completed orders). Those gallons belong to the customer, so they are not owed back.
// (The older tag-per-gallon tables in stationRecords.js are kept but no longer used.)
module.exports = function gallons({ db, requireUser, readBody, sendJSON }) {
    const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, function (error) { error ? reject(error) : resolve(this); }));
    const get = (sql, values = []) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
    const all = (sql, values = []) => new Promise((resolve, reject) => db.all(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));

    const ready = run(`CREATE TABLE IF NOT EXISTS gallon_ledger (
        entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('lent', 'returned')),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        note TEXT NOT NULL DEFAULT '',
        delivery_id INTEGER,
        user_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
    )`).then(() => run("CREATE INDEX IF NOT EXISTS idx_gallon_ledger_customer ON gallon_ledger(customer_id, entry_id)"));

    async function summary(customerId) {
        await ready;
        const row = await get(`SELECT
                COALESCE((SELECT SUM(quantity) FROM gallon_ledger WHERE customer_id = ? AND kind = 'lent'), 0) AS lent,
                COALESCE((SELECT SUM(quantity) FROM gallon_ledger WHERE customer_id = ? AND kind = 'returned'), 0) AS returned,
                COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                          WHERE o.customer_id = ? AND o.status = 'completed' AND oi.with_new_container = 1), 0) AS bought`, [customerId, customerId, customerId]);
        return { ...row, still_out: row.lent - row.returned };
    }

    // Records lent / returned gallons. Returns an error message, or "" when saved.
    // A customer cannot return more station gallons than they are holding.
    async function record({ customerId, kind, quantity, note = "", deliveryId = null, userId = null }) {
        await ready;
        if (!["lent", "returned"].includes(kind)) return "Choose whether the gallons were lent or returned.";
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return "Enter a whole number of gallons from 1 to 100.";
        const customer = await get("SELECT customer_id FROM customers WHERE customer_id = ?", [customerId]);
        if (!customer) return "Customer not found.";
        // The check and the save are one statement, so two returns at once cannot both pass.
        const saved = await run(`INSERT INTO gallon_ledger (customer_id, kind, quantity, note, delivery_id, user_id)
            SELECT ?, ?, ?, ?, ?, ? WHERE ? = 'lent' OR ? <= (
                COALESCE((SELECT SUM(quantity) FROM gallon_ledger WHERE customer_id = ? AND kind = 'lent'), 0)
              - COALESCE((SELECT SUM(quantity) FROM gallon_ledger WHERE customer_id = ? AND kind = 'returned'), 0))`,
            [customerId, kind, quantity, String(note).trim().slice(0, 200), deliveryId, userId, kind, quantity, customerId, customerId]);
        if (!saved.changes) {
            const { still_out } = await summary(customerId);
            return still_out > 0
                ? `This customer is holding only ${still_out} station ${still_out === 1 ? "gallon" : "gallons"}, so ${quantity} cannot be returned.`
                : "This customer is not holding any station gallons, so none can be returned.";
        }
        return "";
    }

    const STAFF = ["admin", "staff"];
    async function handle(req, res, url) {
        const user = requireUser(req, res);
        if (!user) return;
        try {
            await ready;
            const params = new URL(req.url, "http://localhost").searchParams;
            // The customer's own count, for the customer portal.
            if (req.method === "GET" && url === "/api/customer/gallons") {
                if (user.role !== "customer") return sendJSON(res, 403, { success: false, message: "Customer account access is required." });
                return sendJSON(res, 200, { success: true, ...(await summary(user.customer_id)) });
            }
            if (!STAFF.includes(user.role)) return sendJSON(res, 403, { success: false, message: "Only staff or administrators can manage station gallons." });
            if (req.method === "GET" && url === "/api/gallons") {
                const customerId = Number(params.get("customer_id"));
                if (!Number.isSafeInteger(customerId) || customerId < 1) return sendJSON(res, 400, { success: false, message: "Choose a customer." });
                const entries = await all(`SELECT g.entry_id, g.kind, g.quantity, g.note, g.delivery_id, g.created_at, u.full_name AS recorded_by
                    FROM gallon_ledger g LEFT JOIN users u ON u.user_id = g.user_id WHERE g.customer_id = ? ORDER BY g.entry_id DESC`, [customerId]);
                return sendJSON(res, 200, { success: true, ...(await summary(customerId)), entries });
            }
            if (req.method === "POST" && url === "/api/gallons/record") {
                const data = await new Promise((resolve, reject) => readBody(req, (error, body) => error ? reject(error) : resolve(body || {})));
                const problem = await record({ customerId: Number(data.customer_id), kind: String(data.kind || ""), quantity: Number(data.quantity), note: data.note, userId: user.user_id });
                if (problem) return sendJSON(res, problem === "Customer not found." ? 404 : 400, { success: false, message: problem });
                return sendJSON(res, 200, { success: true, message: data.kind === "lent" ? "Lent gallons recorded." : "Returned gallons recorded.", ...(await summary(Number(data.customer_id))) });
            }
            if (req.method === "GET" && url === "/api/reports/gallons") {
                const rows = await all(`SELECT c.customer_id, c.customer_name, c.contact_number, c.status,
                        COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                                  WHERE o.customer_id = c.customer_id AND o.status = 'completed' AND oi.with_new_container = 1), 0) AS bought,
                        COALESCE((SELECT SUM(quantity) FROM gallon_ledger g WHERE g.customer_id = c.customer_id AND g.kind = 'lent'), 0) AS lent,
                        COALESCE((SELECT SUM(quantity) FROM gallon_ledger g WHERE g.customer_id = c.customer_id AND g.kind = 'returned'), 0) AS returned,
                        (SELECT MAX(created_at) FROM gallon_ledger g WHERE g.customer_id = c.customer_id) AS last_change
                    FROM customers c ORDER BY c.customer_name`);
                const report = rows.map(row => ({ ...row, still_out: row.lent - row.returned })).filter(row => row.bought || row.lent || row.returned)
                    .sort((a, b) => b.still_out - a.still_out || a.customer_name.localeCompare(b.customer_name));
                return sendJSON(res, 200, { success: true, report });
            }
            sendJSON(res, 404, { success: false, message: "Not found." });
        } catch (error) {
            console.error("Gallon records error:", error);
            sendJSON(res, error instanceof SyntaxError ? 400 : 500, { success: false, message: error instanceof SyntaxError ? "Invalid request." : "Unable to process gallon records." });
        }
    }

    const ROUTES = ["/api/customer/gallons", "/api/gallons", "/api/gallons/record", "/api/reports/gallons"];
    return { handle, record, summary, ROUTES };
};
