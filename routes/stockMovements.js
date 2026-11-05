// Manual stock changes and their movement record must succeed together.
module.exports = function stockMovements({ db, requireUser, readBody, sendJSON }) {
    const run = (sql, values = []) => new Promise((resolve, reject) => db.run(sql, values, function(error) { error ? reject(error) : resolve(this); }));
    const get = (sql, values) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
    const ready = (async () => {
        try { await run('ALTER TABLE inventory_movements ADD COLUMN apply_stock INTEGER NOT NULL DEFAULT 0'); }
        catch (error) { if (!error.message.includes('duplicate column name')) throw error; }
        // Existing order-completion code already changes stock and leaves apply_stock at zero.
        await run(`CREATE TRIGGER IF NOT EXISTS validate_manual_stock BEFORE INSERT ON inventory_movements
            WHEN NEW.apply_stock = 1 BEGIN
                SELECT RAISE(ABORT, 'Invalid stock movement') WHERE NEW.quantity <= 0 OR NEW.movement_type NOT IN ('stock_in','stock_out');
                SELECT RAISE(ABORT, 'Inventory record not found') WHERE NOT EXISTS(SELECT 1 FROM inventory WHERE product_id=NEW.product_id);
                SELECT RAISE(ABORT, 'Not enough stock') WHERE NEW.movement_type='stock_out' AND (SELECT quantity FROM inventory WHERE product_id=NEW.product_id)<NEW.quantity;
            END`);
        await run(`CREATE TRIGGER IF NOT EXISTS apply_manual_stock AFTER INSERT ON inventory_movements
            WHEN NEW.apply_stock = 1 BEGIN
                UPDATE inventory SET quantity=quantity + CASE WHEN NEW.movement_type='stock_in' THEN NEW.quantity ELSE -NEW.quantity END,
                    stock_status=CASE WHEN quantity + CASE WHEN NEW.movement_type='stock_in' THEN NEW.quantity ELSE -NEW.quantity END <= minimum_stock THEN 'low-stock' ELSE 'available' END,
                    updated_at=CURRENT_TIMESTAMP WHERE product_id=NEW.product_id;
            END`);
    })();
    // Report startup problems without an unhandled rejection before the first request.
    ready.catch(error => console.error('Stock movement setup failed:', error.message));
    return async function handle(req, res) {
        const user = requireUser(req, res);
        if (!user) return;
        if (!['admin', 'staff'].includes(user.role)) return sendJSON(res, 403, { success: false, message: 'Only staff can change stock.' });
        try {
            await ready;
            const data = await new Promise((resolve, reject) => readBody(req, (error, data) => error ? reject(error) : resolve(data || {})));
            const productId = Number(data.product_id);
            const quantity = Number(data.quantity);
            const type = req.url.split('?')[0].endsWith('/stock-in') ? 'stock_in' : 'stock_out';
            const reason = String(data.reason || (type === 'stock_in' ? 'Stock In' : 'Out of Stock')).trim();
            // Stock is counted in whole units (gallons, bottles), never 2.5.
            if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isInteger(quantity) || quantity <= 0 || quantity > 1000000 || !reason || reason.length > 300) return sendJSON(res, 400, { success: false, message: 'Choose a product and a whole-number quantity of at least 1 (for example 5), with a short reason.' });
            const product = await get('SELECT status FROM products WHERE product_id=?', [productId]);
            if (!product || ['removed', 'deleted'].includes(product.status)) return sendJSON(res, 404, { success: false, message: 'This product was removed. Restore it from Recently deleted first.' });
            await run('INSERT INTO inventory_movements(product_id,movement_type,quantity,reason,user_id,apply_stock) VALUES(?,?,?,?,?,1)', [productId, type, quantity, reason, user.user_id]);
            const inventory = await get('SELECT quantity FROM inventory WHERE product_id=?', [productId]);
            sendJSON(res, 200, { success: true, message: 'Stock movement recorded.', new_quantity: inventory.quantity });
        } catch (error) {
            const expected = /Not enough stock|Inventory record not found/.test(error.message);
            sendJSON(res, expected ? 400 : 500, { success: false, message: expected ? 'Product not found or insufficient stock. Refresh the inventory.' : 'Unable to record stock movement.' });
        }
    };
};
