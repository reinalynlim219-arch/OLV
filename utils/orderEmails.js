const mailer = require("./mailer");
const verification = require("./verification");

// Order and delivery updates emailed to the customer. Sent only when email is
// configured and the customer has a confirmed email address. Failures are logged
// and never affect the order itself.
module.exports = function orderEmails(db) {
    const get = (sql, values) => new Promise((resolve, reject) => db.get(sql, values, (error, row) => error ? reject(error) : resolve(row)));

    async function loadOrder(orderId) {
        return get(`SELECT o.order_id, o.order_date, o.total_amount, COALESCE(o.service_fee, 0) AS service_fee,
                COALESCE(o.fulfillment_method, 'delivery') AS fulfillment_method, c.customer_name, c.address,
                (SELECT GROUP_CONCAT(COALESCE(p.product_name, 'Item') || ' × ' || oi.quantity || CASE WHEN oi.with_new_container = 1 THEN ' (with new gallon)' ELSE '' END, ', ') FROM order_items oi
                    LEFT JOIN products p ON p.product_id = oi.product_id WHERE oi.order_id = o.order_id) AS items,
                (SELECT v.destination FROM customer_accounts a JOIN verified_contacts v ON v.account_type = 'customer'
                    AND v.account_id = a.account_id AND v.channel = 'email' WHERE a.customer_id = o.customer_id) AS email,
                ds.delivery_id, ds.delivery_date, ds.delivery_time, ds.delivery_address,
                (SELECT full_name FROM users WHERE user_id = ds.assigned_to) AS driver
            FROM orders o JOIN customers c ON c.customer_id = o.customer_id
            LEFT JOIN delivery_schedules ds ON ds.delivery_id = (SELECT d.delivery_id FROM delivery_schedules d WHERE d.order_id = o.order_id
                ORDER BY (d.status = 'cancelled'), d.delivery_id DESC LIMIT 1)
            WHERE o.order_id = ?`, [orderId]);
    }

    const day = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))
        ? new Date(`${value}T00:00:00+08:00`).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", dateStyle: "long" }) : "-";
    const orderedOn = value => {
        const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? value : String(value).replace(" ", "T") + "Z");
        return Number.isNaN(date.getTime()) ? "-" : mailer.phTime(date);
    };

    function content(kind, o) {
        const portal = { label: "View my orders", url: `${verification.baseUrl()}/customer-portal` };
        const isPickup = o.fulfillment_method === "pickup";
        const base = [["Items", o.items || "-"], ["Total", mailer.peso(o.total_amount)]];
        switch (kind) {
            case "placed": return {
                subject: "We received your OLV order",
                title: "Thank you for your order!",
                paragraphs: [isPickup
                    ? "We received your order. We will prepare it, and you can pick it up at the station."
                    : "We received your order. We will schedule the delivery and email you when it is on the way."],
                details: [...base, ...(o.service_fee > 0 ? [["Delivery fee (included)", mailer.peso(o.service_fee)]] : []),
                    ["How you will get it", isPickup ? "Pickup at the station" : "Home delivery"],
                    ...(isPickup ? [] : [["Deliver to", o.delivery_address || o.address || "-"]]),
                    ["Ordered on", orderedOn(o.order_date)]],
                button: portal
            };
            case "approved": return {
                subject: "Your OLV order was approved",
                title: "Your order was approved",
                paragraphs: [isPickup
                    ? "The station checked and approved your order. We are preparing it; you can pick it up at the station."
                    : "The station checked and approved your order. We will email you again when it is on the way."],
                details: [...base,
                    ["How you will get it", isPickup ? "Pickup at the station" : "Home delivery"],
                    ...(isPickup ? [] : [["Delivery day", day(o.delivery_date)], ["Deliver to", o.delivery_address || o.address || "-"]])],
                button: portal
            };
            case "out_for_delivery": return {
                subject: "Your OLV order is on the way",
                title: "Your order is on the way",
                paragraphs: ["Your order has left the station and is now out for delivery. Please make sure someone is available to receive it."],
                details: [...base, ["Driver", o.driver || "OLV delivery staff"], ["Deliver to", o.delivery_address || o.address || "-"]],
                button: { label: "Track my delivery", url: portal.url }
            };
            case "dropped_off": return {
                subject: "Your OLV order was delivered – please confirm",
                title: "Your order was dropped off",
                paragraphs: ["The driver has dropped off your order. Please open your account and click Order Received to confirm that you got it. You may attach a photo if you wish."],
                details: [...base, ["Delivered to", o.delivery_address || o.address || "-"]],
                button: { label: "Confirm order received", url: portal.url },
                note: "If you did not receive your order, please call or message the station right away."
            };
            case "completed": return {
                subject: `Your OLV receipt – Order ${o.order_id}`,
                title: "Order completed – thank you!",
                paragraphs: ["Your order is complete. Here is your receipt for your records. Thank you for choosing OLV Water Refilling Station!"],
                details: [["Receipt for order", `#${o.order_id}`], ...base,
                    ...(o.service_fee > 0 ? [["Delivery fee (included)", mailer.peso(o.service_fee)]] : []),
                    ["Received by", isPickup ? "Pickup at the station" : "Home delivery"],
                    ["Ordered on", orderedOn(o.order_date)], ["Completed on", mailer.phTime()]],
                button: portal,
                note: "This email is an acknowledgment of your completed order. It is not an official receipt (BIR)."
            };
            case "cancelled": return {
                subject: `Your OLV order was cancelled – Order ${o.order_id}`,
                title: "Your order was cancelled",
                paragraphs: [o.cancel_reason
                    ? `The station cancelled your order. Reason: ${o.cancel_reason}`
                    : "The station cancelled your order.",
                    "Nothing was charged. If this is a mistake, or you still need water, please place a new order or call the station."],
                details: [...base, ["Ordered on", orderedOn(o.order_date)], ["Cancelled on", mailer.phTime()]],
                button: portal
            };
            default: return null;
        }
    }

    // kind: "placed" | "approved" | "out_for_delivery" | "dropped_off" | "completed" | "cancelled". Returns without waiting.
    function send(kind, { orderId, deliveryId, reason }) {
        if (!mailer.configured()) return;
        (async () => {
            const id = orderId || (await get("SELECT order_id FROM delivery_schedules WHERE delivery_id = ?", [deliveryId]))?.order_id;
            if (!id) return;
            const order = await loadOrder(id);
            if (!order || !order.email) return;
            const message = content(kind, { ...order, cancel_reason: reason });
            if (!message) return;
            await mailer.send({ to: order.email, greeting: `Hi ${order.customer_name},`, ...message });
        })().catch(error => console.error(`Order email (${kind}) not sent:`, error.message));
    }

    return { send };
};
