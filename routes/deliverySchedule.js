// Scheduling changes details only. Dispatch and receipt use separate status routes.
// A delivery is usually for a customer order (name, number and items come from the
// order, and staff may change them for this delivery). Staff can also schedule one
// without an order by typing the name, number and items; such a delivery has no
// order, receipt, payment or stock change.
module.exports = function deliverySchedule({ db, requireUser, readBody, sendJSON }) {
    const get = (sql, values) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));
    const run = (sql, values) => new Promise((resolve, reject) => db.run(sql, values, function(error) { error ? reject(error) : resolve(this); }));
    return async function handle(req, res) {
        const user = requireUser(req, res);
        if (!user) return;
        if (!['admin', 'staff'].includes(user.role)) return sendJSON(res, 403, { success: false, message: 'Only staff can schedule deliveries.' });
        try {
            const data = await new Promise((resolve, reject) => readBody(req, (error, value) => error ? reject(error) : resolve(value || {})));
            const editing = req.method === 'PUT';
            const hasOrder = data.order_id !== null && data.order_id !== undefined && data.order_id !== '' && Number(data.order_id) !== 0;
            const orderId = hasOrder ? Number(data.order_id) : null;
            const deliveryId = Number(data.delivery_id);
            // Typed by staff (optional with an order, required without one).
            const typedName = String(data.customer_name || '').trim().replace(/\s+/g, ' ');
            const typedContact = String(data.contact_number || '').replace(/[\s-]/g, '').replace(/^\+?63(?=9\d{9}$)/, '0');
            const typedItems = String(data.delivery_items || '').trim();
            const assignedTo = data.assigned_to ? Number(data.assigned_to) : null;
            const date = String(data.delivery_date || '');
            const time = String(data.delivery_time || '');
            const address = String(data.delivery_address || '').trim();
            const reason = String(data.delivery_reason || '').trim();
            if ((hasOrder && (!Number.isSafeInteger(orderId) || orderId < 1)) || (editing && (!Number.isSafeInteger(deliveryId) || deliveryId < 1))) throw new Error('Choose a valid order and delivery.');
            if (typedName.length > 80 || typedItems.length > 300) throw new Error('Keep the name under 80 characters and the items under 300.');
            if (typedContact && !/^09\d{9}$/.test(typedContact)) throw new Error('Enter the contact number as +63 and 10 digits, for example +63 9171234567.');
            if (!hasOrder && (!typedName || !typedContact || !typedItems)) throw new Error('Without a customer order, type the customer name, contact number, and items to deliver.');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid delivery date.');
            if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Enter a valid delivery time.');
            if (!address || address.length > 1000 || !reason || reason.length > 300) throw new Error('Provide an address and a short delivery reason.');
            if (data.status && data.status !== 'scheduled') throw new Error('Use the delivery action buttons to change status.');
            if (assignedTo !== null && (!Number.isSafeInteger(assignedTo) || !await get("SELECT user_id FROM users WHERE user_id = ? AND status = 'active' AND role IN ('admin','staff','driver')", [assignedTo]))) throw new Error('Choose an active staff member or driver.');
            let saved;
            if (!hasOrder) {
                // Delivery without a customer order: the typed details are used as they are.
                const values = [typedName, typedContact, reason, typedItems, date, time, address, assignedTo];
                saved = editing
                    ? await run(`UPDATE delivery_schedules SET customer_name=?, contact_number=?, delivery_reason=?, delivery_items=?, delivery_date=?, delivery_time=?, delivery_address=?, assigned_to=?
                        WHERE delivery_id=? AND order_id IS NULL AND (status='scheduled' OR (status='out_for_delivery' AND ? IS NOT NULL))`, [...values, deliveryId, assignedTo])
                    : await run(`INSERT INTO delivery_schedules(customer_name,contact_number,delivery_reason,delivery_items,delivery_date,delivery_time,delivery_address,assigned_to,order_id,status)
                        VALUES (?,?,?,?,?,?,?,?,NULL,'scheduled')`, values);
                if (!saved.changes && editing && assignedTo === null && await get(`SELECT 1 FROM delivery_schedules WHERE delivery_id=? AND status='out_for_delivery'`, [deliveryId]))
                    throw new Error('A delivery that is already out must stay assigned to someone. Choose who is delivering it.');
                if (!saved.changes) return sendJSON(res, 409, { success: false, message: 'Delivery changed or is already scheduled. Refresh the list. Only scheduled or out-for-delivery deliveries can be edited.' });
                return sendJSON(res, 200, { success: true, message: editing ? 'Delivery details updated.' : 'Delivery scheduled.' });
            }
            const order = await get(`SELECT o.order_id, c.customer_name, c.contact_number,
                (SELECT GROUP_CONCAT(p.product_name || ' × ' || i.quantity || CASE WHEN i.with_new_container = 1 THEN ' (with new gallon)' ELSE '' END, ', ') FROM order_items i JOIN products p ON p.product_id=i.product_id WHERE i.order_id=o.order_id) AS items
                FROM orders o JOIN customers c ON c.customer_id=o.customer_id
                WHERE o.order_id=? AND o.status='pending' AND o.fulfillment_method='delivery'`, [orderId]);
            if (!order) throw new Error('Only pending delivery orders can be scheduled.');
            // With an order: what staff typed for this delivery, or else the order's details.
            const values = [typedName || order.customer_name, typedContact || order.contact_number, reason, typedItems || order.items || '', date, time, address, assignedTo];
            if (editing) {
                // Scheduled deliveries can be edited freely. A delivery that is already out can
                // be handed to another driver, but must stay assigned to someone.
                saved = await run(`UPDATE delivery_schedules SET customer_name=?, contact_number=?, delivery_reason=?, delivery_items=?, delivery_date=?, delivery_time=?, delivery_address=?, assigned_to=?
                    WHERE delivery_id=? AND order_id=? AND (status='scheduled' OR (status='out_for_delivery' AND ? IS NOT NULL))
                    AND EXISTS(SELECT 1 FROM orders WHERE order_id=? AND status='pending')`, [...values, deliveryId, orderId, assignedTo, orderId]);
                if (!saved.changes && assignedTo === null && await get(`SELECT 1 FROM delivery_schedules WHERE delivery_id=? AND status='out_for_delivery'`, [deliveryId]))
                    throw new Error('A delivery that is already out must stay assigned to someone. Choose who is delivering it.');
            } else {
                saved = await run(`INSERT INTO delivery_schedules(customer_name,contact_number,delivery_reason,delivery_items,delivery_date,delivery_time,delivery_address,assigned_to,order_id,status)
                    SELECT ?,?,?,?,?,?,?,?,?,'scheduled'
                    WHERE EXISTS(SELECT 1 FROM orders WHERE order_id=? AND status='pending')
                    AND NOT EXISTS(SELECT 1 FROM delivery_schedules WHERE order_id=? AND status<>'cancelled')`, [...values, orderId, orderId, orderId]);
            }
            if (!saved.changes) return sendJSON(res, 409, { success: false, message: 'Delivery changed or is already scheduled. Refresh the list. Only scheduled or out-for-delivery deliveries can be edited.' });
            sendJSON(res, 200, { success: true, message: editing ? 'Delivery details updated.' : 'Delivery scheduled.' });
        } catch (error) {
            sendJSON(res, 400, { success: false, message: error.code ? 'Unable to save delivery.' : error.message });
        }
    };
};
