const mailer = require("./mailer");

function isConfigured() {
    return Boolean(mailer.configured() && process.env.REPORT_RECIPIENT);
}

// Station summary sent from the Reports page to REPORT_RECIPIENT (usually the owner).
// `summary` comes from /api/reports/email; amounts are in pesos, times in Philippine time.
async function sendStationSummary(summary, preparedBy) {
    if (!isConfigured()) throw new Error("Gmail report settings are not configured.");
    const lowStock = summary.low_stock || [];
    await mailer.send({
        to: process.env.REPORT_RECIPIENT,
        subject: `OLV Station Summary – ${new Date().toLocaleDateString("en-PH", { timeZone: "Asia/Manila", dateStyle: "long" })}`,
        title: "Station summary",
        preheader: `Stock value ${mailer.peso(summary.stock_value)} · ${lowStock.length} low-stock product(s) · sales ${mailer.peso(summary.sales_30_days)} in 30 days`,
        greeting: "Good day,",
        paragraphs: [
            "Here is the latest summary of inventory, orders, and deliveries at OLV Water Refilling Station.",
            lowStock.length
                ? `Low stock: ${lowStock.map(item => `${item.product_name} (${item.quantity} left, minimum ${item.minimum_stock})`).join("; ")}. Please restock these products soon.`
                : "All active products are above their minimum stock level."
        ],
        details: [
            ["Inventory value", mailer.peso(summary.stock_value)],
            ["Active products", String(summary.active_products)],
            ["Low-stock products", String(lowStock.length)],
            ["Sales (last 30 days)", mailer.peso(summary.sales_30_days)],
            ["Completed orders (last 30 days)", String(summary.completed_30_days)],
            ["Pending orders", String(summary.pending_orders)],
            ["Deliveries in progress", String(summary.deliveries_in_progress)],
            ["Driver cash not yet remitted", mailer.peso(summary.cash_not_remitted)],
            ["Prepared by", preparedBy || "-"],
            ["Generated", mailer.phTime()]
        ],
        note: "Open the Reports page of the system for the complete printable reports."
    });
}

module.exports = { isConfigured, sendStationSummary };
