// "Recently deleted" for products, like the bin in a phone's gallery:
//  - Remove (admin or staff) moves a product here. It disappears from the inventory,
//    the customer portal and the reports, but nothing is lost yet.
//  - It stays here, with no time limit, until it is restored to how it was (active or
//    archived) or deleted permanently.
//  - Delete permanently (admin or staff) works only on products in Recently deleted.
//  - A product that was never ordered is erased with its stock and stock history.
//    A product that was ordered is kept hidden (status 'deleted') so old receipts,
//    order history and sales reports still show its name.
// The list has its own page, /recently-deleted, in the side menu.
module.exports = function recentlyRemoved({ db, txDb, requireUser, readBody, sendJSON, servePage }) {
    const run = (conn, sql, values = []) => new Promise((resolve, reject) => conn.run(sql, values, function (error) { error ? reject(error) : resolve(this); }));
    const get = (sql, values = []) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
    const all = (sql, values = []) => new Promise((resolve, reject) => db.all(sql, values, (error, rows) => error ? reject(error) : resolve(rows)));
    const body = req => new Promise((resolve, reject) => readBody(req, (error, value) => error ? reject(error) : resolve(value || {})));

    async function addColumn(column, definition) {
        const columns = await all("PRAGMA table_info(products)");
        if (!columns.some(c => c.name === column)) await run(db, `ALTER TABLE products ADD COLUMN ${column} ${definition}`);
    }

    // Erases a product for good, or hides it for good when old orders still use it.
    async function deleteForGood(productId) {
        const used = await get("SELECT COUNT(*) AS orders FROM order_items WHERE product_id = ?", [productId]);
        if (used.orders > 0) {
            await run(db, "UPDATE products SET status = 'deleted' WHERE product_id = ? AND status = 'removed'", [productId]);
            return "kept";
        }
        await run(txDb, "BEGIN IMMEDIATE");
        try {
            await run(txDb, "DELETE FROM inventory_movements WHERE product_id = ?", [productId]);
            await run(txDb, "DELETE FROM inventory WHERE product_id = ?", [productId]);
            await run(txDb, "DELETE FROM products WHERE product_id = ? AND status = 'removed'", [productId]);
            await run(txDb, "COMMIT");
        } catch (error) {
            await run(txDb, "ROLLBACK").catch(() => {});
            throw error;
        }
        return "erased";
    }

    async function setup() {
        await addColumn("removed_at", "DATETIME");
        await addColumn("removed_by", "INTEGER");
        await addColumn("status_before_removal", "TEXT");
    }

    const STAFF = ["admin", "staff"];
    const ROUTES = ["/recently-deleted", "/api/inventory/remove", "/api/inventory/removed", "/api/inventory/restore", "/api/inventory/delete"];

    async function handle(req, res, url) {
        const user = requireUser(req, res);
        if (!user) return;
        if (!STAFF.includes(user.role)) return sendJSON(res, 403, { success: false, message: "Only staff or the admin can remove products." });
        if (req.method === "GET" && url === "/recently-deleted") return servePage("recently-deleted.html", res);
        try {
            if (req.method === "GET" && url === "/api/inventory/removed") {
                const products = await all(`
                    SELECT p.product_id, p.product_name, p.unit, p.price, p.supplier_name, p.removed_at,
                           COALESCE(p.status_before_removal, 'active') AS status_before_removal,
                           u.full_name AS removed_by_name, COALESCE(i.quantity, 0) AS quantity,
                           (SELECT COUNT(*) FROM order_items oi WHERE oi.product_id = p.product_id) AS orders
                    FROM products p
                    LEFT JOIN inventory i ON i.product_id = p.product_id
                    LEFT JOIN users u ON u.user_id = p.removed_by
                    WHERE p.status = 'removed'
                    ORDER BY p.removed_at DESC`);
                return sendJSON(res, 200, { success: true, products });
            }

            const data = await body(req);
            const productId = Number(data.product_id);
            if (!Number.isSafeInteger(productId) || productId < 1) return sendJSON(res, 400, { success: false, message: "Choose a product." });
            const product = await get("SELECT product_name, status FROM products WHERE product_id = ?", [productId]);
            if (!product || product.status === "deleted") return sendJSON(res, 404, { success: false, message: "Product not found." });

            if (req.method === "PUT" && url === "/api/inventory/remove") {
                if (product.status === "removed") return sendJSON(res, 409, { success: false, message: "This product is already in Recently deleted." });
                // Orders still waiting would need this product's stock when they are completed.
                const waiting = await get(`SELECT COUNT(DISTINCT o.order_id) AS orders FROM order_items oi JOIN orders o ON o.order_id = oi.order_id
                    WHERE oi.product_id = ? AND o.status = 'pending'`, [productId]);
                if (waiting.orders > 0) return sendJSON(res, 409, { success: false, message: `${waiting.orders} pending ${waiting.orders === 1 ? "order still includes" : "orders still include"} "${product.product_name}". Complete or cancel ${waiting.orders === 1 ? "it" : "them"} first.` });
                await run(db, `UPDATE products SET status_before_removal = status, status = 'removed', removed_at = CURRENT_TIMESTAMP, removed_by = ?
                    WHERE product_id = ? AND status NOT IN ('removed', 'deleted')`, [user.user_id, productId]);
                return sendJSON(res, 200, { success: true, message: `"${product.product_name}" moved to Recently deleted. You can restore it from there, or delete it permanently.` });
            }

            if (req.method === "PUT" && url === "/api/inventory/restore") {
                if (product.status !== "removed") return sendJSON(res, 409, { success: false, message: "This product is not in Recently deleted." });
                await run(db, `UPDATE products SET status = CASE WHEN status_before_removal IN ('active', 'archived') THEN status_before_removal ELSE 'archived' END,
                    removed_at = NULL, removed_by = NULL, status_before_removal = NULL WHERE product_id = ? AND status = 'removed'`, [productId]);
                return sendJSON(res, 200, { success: true, message: `"${product.product_name}" restored to the inventory.` });
            }

            if (req.method === "DELETE" && url === "/api/inventory/delete") {
                if (product.status !== "removed") return sendJSON(res, 409, { success: false, message: "Only products in Recently deleted can be deleted permanently. Press Remove first." });
                const result = await deleteForGood(productId);
                return sendJSON(res, 200, { success: true, message: result === "erased"
                    ? `"${product.product_name}" was deleted permanently.`
                    : `"${product.product_name}" was deleted permanently. Its name stays only on old receipts and order history.` });
            }

            sendJSON(res, 404, { success: false, message: "Not found." });
        } catch (error) {
            console.error("Recently deleted error:", error);
            sendJSON(res, error instanceof SyntaxError ? 400 : 500, { success: false, message: error instanceof SyntaxError ? "Invalid request." : "Unable to update Recently deleted. Try again." });
        }
    }

    return { setup, handle, ROUTES };
};
