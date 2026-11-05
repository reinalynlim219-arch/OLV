// ==========================================
// LOAD ORDERS
// ==========================================

// The database stores times in UTC; show them in Philippine time.
const phTime = value => { if (!value) return "-"; const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : String(value).replace(" ", "T") + "Z"); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }); };
let ordersData = [];
let currentOrdersPage = 1;
const ordersPageSize = 10;



const ORDER_COLUMNS = 9;

// "Oct 28, 2026" with the time on a second line, so the column stays narrow.
function orderDateCell(value) {
    const text = phTime(value);
    const parts = /^(.*\d{4}),\s*(.+)$/.exec(text);
    return parts ? `<div class="text-nowrap">${escapeHTML(parts[1])}<br><small class="olv-muted">${escapeHTML(parts[2])}</small></div>` : escapeHTML(text);
}

// Schedule column: the delivery day and time, or pickup at the station.
// "2026-10-30" -> "Oct 30, 2026"; "09:00" -> "9:00 AM" (no time zone shifting).
function scheduleCell(order) {
    if (order.fulfillment_method === "pickup") return '<span class="olv-muted">Pickup at the station</span>';
    const day = value => {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
        return m ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3])).toLocaleDateString("en-PH", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "";
    };
    const time = /^(\d{1,2}):(\d{2})/.exec(String(order.delivery_time || ""));
    const date = day(order.delivery_date) || day(order.preferred_date);
    if (!date) return '<span class="olv-muted">Not scheduled yet</span>';
    const at = time ? new Date(2000, 0, 1, +time[1], +time[2]).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : "Any time";
    // The customer picked this day on the portal's calendar.
    const picked = order.preferred_date && order.preferred_date === order.delivery_date ? '<br><small class="olv-muted">Customer\'s chosen day</small>' : "";
    // One wrapper, so the lines stay together when the table turns into cards on phones.
    return `<div>${escapeHTML(date)}<br><small>${escapeHTML(at)}</small>${picked}</div>`;
}

// A refresh keeps the current page; the first load starts on page 1.
async function loadOrders({ refresh = false } = {}) {
    const tableBody = document.getElementById("orderTableBody");
    if (!tableBody) return;

    if (!refresh) tableBody.innerHTML = `<tr><td colspan="${ORDER_COLUMNS}" class="text-center">Loading orders...</td></tr>`;

    try {
        const response = await fetch("/api/orders", { cache: "no-store" });
        if (response.status === 401) { window.location.href = "/login"; return; }
        if (!response.ok) throw new Error("Server returned status " + response.status);
        const orders = await response.json();
        ordersData = Array.isArray(orders) ? orders : [];
        if (!refresh) currentOrdersPage = 1;
        updateOrderStats();

        if (!ordersData.length) {
            tableBody.innerHTML = `<tr><td colspan="${ORDER_COLUMNS}" class="text-center text-muted">No orders found.</td></tr>`;
            renderOrdersPagination(0);
            return;
        }

        renderOrders();
    } catch (error) {
        console.error("Unable to load orders:", error);
        if (!refresh) tableBody.innerHTML = `<tr><td colspan="${ORDER_COLUMNS}" class="text-center text-danger">Unable to load orders.</td></tr>`;
    }
}

// Delivery column: the same status Delivery Management shows for this order.
const DELIVERY_PILL = {
    scheduled: ["pill-blue", "Scheduled"],
    out_for_delivery: ["pill-amber", "Out for delivery"],
    awaiting_customer: ["pill-teal", "Awaiting customer"],
    delivered: ["pill-green", "Delivered"],
    cancelled: ["pill-red", "Cancelled"]
};
function deliveryCell(order) {
    if (order.fulfillment_method === "pickup") return '<span class="olv-pill pill-slate">Pickup</span>';
    const [color, label] = DELIVERY_PILL[order.delivery_status] || ["pill-slate", "Not scheduled"];
    return `<a class="order-delivery-link" href="/delivery" title="Open Delivery Management"><span class="olv-pill ${color}">${label}</span></a>`;
}

// Summary cards above the orders table.
function updateOrderStats() {
    const byStatus = status => ordersData.filter(order => String(order.status || "").toLowerCase() === status);
    const set = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
    const sales = byStatus("completed").reduce((total, order) => total + Number(order.total_amount || 0), 0);
    set("ordersPending", byStatus("pending").length);
    set("ordersCompleted", byStatus("completed").length);
    set("ordersSales", "₱" + sales.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    set("ordersTotal", ordersData.length);
}

const ORDER_PILL = { pending: "pill-amber", completed: "pill-green", cancelled: "pill-red" };

function renderOrders() {
    const tableBody = document.getElementById("orderTableBody");
    const totalPages = Math.ceil(ordersData.length / ordersPageSize);
    currentOrdersPage = Math.min(currentOrdersPage, totalPages);
    const startIndex = (currentOrdersPage - 1) * ordersPageSize;
    const pageOrders = ordersData.slice(startIndex, startIndex + ordersPageSize);

    tableBody.innerHTML = pageOrders.map(order => {
        const status = String(order.status || "pending").toLowerCase();
        // The Status column shows the state; this column only explains what happens next.
        let actionButton = '<span class="olv-muted">—</span>';
        if (status === "pending") {
            const nextStep = order.fulfillment_method === "pickup" ? "Waiting for customer pickup" : ({
                scheduled: "Waiting to be dispatched",
                out_for_delivery: "On the way to the customer",
                awaiting_customer: "Waiting for customer confirmation",
                cancelled: "Delivery cancelled"
            })[order.delivery_status] || "Needs a delivery schedule";
            const canCancel = !["awaiting_customer", "delivered"].includes(order.delivery_status);
            // At the counter, staff confirm the pickup when the customer collects the order.
            // After the drop-off, staff can confirm for a customer who cannot use the portal.
            const pickupButton = order.fulfillment_method === "pickup"
                ? ` <button type="button" class="btn btn-sm btn-success ms-1" onclick="completeOrder(${Number(order.order_id)})">Mark picked up</button>`
                : order.delivery_status === "awaiting_customer"
                    ? ` <button type="button" class="btn btn-sm btn-success ms-1" onclick="completeOrder(${Number(order.order_id)}, true)">Customer confirmed</button>` : "";
            // Approve (beside Cancel) once staff have checked the items, schedule, and address.
            const approval = order.approved_at
                ? `<span class="order-approved"><i class="bi bi-check-circle-fill" aria-hidden="true"></i> Approved${order.approved_by_name ? ` by ${escapeHTML(order.approved_by_name)}` : ""}</span>`
                : `<button type="button" class="btn btn-sm btn-success ms-1" data-approve-order="${Number(order.order_id)}">Approve</button>`;
            actionButton = `<span class="olv-muted">${nextStep}</span>${order.approved_at ? approval : ""}${pickupButton}<span class="order-buttons">${order.approved_at ? "" : approval}${canCancel ? ` <button type="button" class="btn btn-sm btn-outline-danger ms-1" data-cancel-order="${Number(order.order_id)}">Cancel</button>` : ""}</span>`;
        }
        if (status === "completed") actionButton = '<span class="olv-muted">Stock deducted</span>';
        if (status === "cancelled") actionButton = '<span class="olv-muted">Cancelled — stock was not used</span>';

        return `
            <tr data-fold-key="order-${Number(order.order_id)}">
                <td><strong>${escapeHTML(order.customer_name || "")}</strong></td>
                <td>${orderDateCell(order.order_date)}</td>
                <td>${escapeHTML(order.items || "—")}</td>
                <td>${scheduleCell(order)}</td>
                <td class="order-address">${order.fulfillment_method === "pickup" ? '<span class="olv-muted">—</span>' : escapeHTML(order.delivery_address || "No address saved")}</td>
                <td><strong>₱${Number(order.total_amount || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></td>
                <td><span class="olv-pill ${ORDER_PILL[status] || "pill-slate"}">${escapeHTML(status)}</span></td>
                <td>${deliveryCell(order)}</td>
                <td><div class="order-actions">${actionButton}</div></td>
            </tr>
        `;
    }).join("");

    renderOrdersPagination(ordersData.length);
}

function renderOrdersPagination(totalItems) {
    const pagination = document.getElementById("ordersPagination");
    if (!pagination) return;
    const totalPages = Math.ceil(totalItems / ordersPageSize);
    if (totalPages <= 1) {
        pagination.innerHTML = "";
        return;
    }

    let controls = `<button type="button" class="movement-page-button" ${currentOrdersPage === 1 ? "disabled" : ""} onclick="changeOrdersPage(${currentOrdersPage - 1})" aria-label="Previous page">&lsaquo;</button>`;
    for (let page = 1; page <= totalPages; page += 1) {
        controls += `<button type="button" class="movement-page-button ${page === currentOrdersPage ? "active" : ""}" onclick="changeOrdersPage(${page})" aria-label="Page ${page}" ${page === currentOrdersPage ? "aria-current=\"page\"" : ""}>${page}</button>`;
    }
    controls += `<button type="button" class="movement-page-button" ${currentOrdersPage === totalPages ? "disabled" : ""} onclick="changeOrdersPage(${currentOrdersPage + 1})" aria-label="Next page">&rsaquo;</button>`;
    pagination.innerHTML = controls;
}

function changeOrdersPage(page) {
    const totalPages = Math.max(1, Math.ceil(ordersData.length / ordersPageSize));
    currentOrdersPage = Math.max(1, Math.min(page, totalPages));
    renderOrders();
}

// ==========================================
// LOAD CUSTOMERS
// ==========================================

async function loadCustomers() {

    try {

        const response =
            await fetch(
                "/api/customers",
                {
                    cache: "no-store"
                }
            );

        if (!response.ok) {

            throw new Error(
                "Unable to load customers."
            );

        }

        const customers =
            await response.json();

        const select =
            document.getElementById(
                "orderCustomer"
            );

        if (!select) {
            return;
        }

        select.innerHTML = `
            <option value="">
                Select Customer
            </option>
        `;

        customers.forEach(
            customer => {

                if (
                    customer.status !==
                    "active"
                ) {
                    return;
                }

                select.innerHTML += `

                    <option
                        value="${customer.customer_id}"
                    >
                        ${escapeHTML(
                            customer.customer_name
                        )}
                    </option>

                `;

            }
        );

    }
    catch (error) {

        console.error(
            "Unable to load customers.",
            error
        );

    }

}

// ==========================================
// LOAD PRODUCTS
// ==========================================

async function loadProducts() {

    try {

        const response =
            await fetch(
                "/api/inventory",
                {
                    cache: "no-store"
                }
            );

        if (!response.ok) {

            throw new Error(
                "Unable to load products."
            );

        }

        const products =
            await response.json();

        const select =
            document.getElementById(
                "orderProduct"
            );

        if (!select) {
            return;
        }

        select.innerHTML = `
            <option value="">
                Select Product
            </option>
        `;

        products.forEach(
            product => {

                if (
                    product.status !==
                    "active"
                ) {
                    return;
                }

                select.innerHTML += `

                    <option
                        value="${product.product_id}"
                    >
                        ${escapeHTML(
                            product.product_name
                        )}
                        - ₱${Number(
                            product.price ||
                            0
                        ).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        - Stock:
                        ${Number(
                            product.quantity ||
                            0
                        )}
                    </option>

                `;

            }
        );

    }
    catch (error) {

        console.error(
            "Unable to load products.",
            error
        );

    }

}

// ==========================================
// SAVE ORDER
// ==========================================

async function saveOrder() {

    const customerElement =
        document.getElementById(
            "orderCustomer"
        );

    const productElement =
        document.getElementById(
            "orderProduct"
        );

    const quantityElement =
        document.getElementById(
            "orderQuantity"
        );

    const customerId =
        Number(
            customerElement.value
        );

    const productId =
        Number(
            productElement.value
        );

    const quantity =
        Number(
            quantityElement.value
        );

    // ==========================================
    // VALIDATION
    // ==========================================

    if (!customerId) {

        alert(
            "Please select a customer."
        );

        return;
    }

    if (!productId) {

        alert(
            "Please select a product."
        );

        return;
    }

    if (
        !quantity ||
        quantity <= 0
    ) {

        alert(
            "Quantity must be greater than zero."
        );

        return;
    }

    // ==========================================
    // BUTTON
    // ==========================================

    const saveButton =
        document.getElementById(
            "saveOrder"
        );

    saveButton.disabled = true;

    saveButton.textContent =
        "Saving...";

    try {

        const response =
            await fetch(
                "/api/orders/add",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            customer_id:
                                customerId,

                            items: [
                                {
                                    product_id:
                                        productId,

                                    quantity:
                                        quantity
                                }
                            ]
                        })
                }
            );

        const text =
            await response.text();

        console.log(
            "Server response:",
            text
        );

        let result;

        try {

            result =
                JSON.parse(text);

        }
        catch (error) {

            console.error(
                "Invalid JSON response:",
                text
            );

            alert(
                "The server returned an invalid response."
            );

            return;

        }

        if (
            !response.ok
        ) {

            alert(
                result.message ||
                "Unable to create order."
            );

            return;
        }

        if (
            result.success
        ) {

            alert(
                result.message ||
                "Order created successfully."
            );

            closeOrderModal();

            clearOrderForm();

            await loadOrders();

        }
        else {

            alert(
                result.message ||
                "Order could not be created."
            );

        }

    }
    catch (error) {

        console.error(
            "Unable to save order:",
            error
        );

        alert(
            "Unable to connect to the server."
        );

    }
    finally {

        saveButton.disabled =
            false;

        saveButton.textContent =
            "Save Order";

    }

}

// ==========================================
// COMPLETE ORDER
// ==========================================

async function completeOrder(
    orderId,
    isDelivery = false
) {

    if (!orderId) {

        alert(
            "Invalid order ID."
        );

        return;
    }

    const confirmed =
        await olvConfirm(
            (isDelivery
                ? "Did the customer confirm (for example by phone) that they received this delivery?\n\n"
                : "Mark this order as picked up by the customer?\n\n") +
            "The ordered quantity will be deducted from inventory and the customer gets their e-receipt.",
            { ok: isDelivery ? "Yes, received" : "Mark picked up" }
        );

    if (!confirmed) {
        return;
    }

    try {

        const response =
            await fetch(
                "/api/orders/complete",
                {
                    method: "PUT",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify({
                            order_id:
                                orderId
                        })
                }
            );

        const text =
            await response.text();

        console.log(
            "Complete order response:",
            text
        );

        let result;

        try {

            result =
                JSON.parse(text);

        }
        catch (error) {

            console.error(
                "Invalid completion response:",
                text
            );

            alert(
                "The server returned an invalid response."
            );

            return;
        }

        if (
            !response.ok
        ) {

            alert(
                result.message ||
                "Unable to complete order."
            );

            return;
        }

        if (
            result.success
        ) {

            alert(
                result.message ||
                "Order completed successfully."
            );

            await loadOrders();

        }
        else {

            alert(
                result.message ||
                "Order could not be completed."
            );

        }

    }
    catch (error) {

        console.error(
            "Unable to complete order:",
            error
        );

        alert(
            "Unable to connect to the server."
        );

    }

}

// ==========================================
// CLEAR ORDER FORM
// ==========================================

function clearOrderForm() {

    const customer =
        document.getElementById(
            "orderCustomer"
        );

    const product =
        document.getElementById(
            "orderProduct"
        );

    const quantity =
        document.getElementById(
            "orderQuantity"
        );

    if (customer) {
        customer.value = "";
    }

    if (product) {
        product.value = "";
    }

    if (quantity) {
        quantity.value = 1;
    }

}

// ==========================================
// CLOSE ORDER MODAL
// ==========================================

function closeOrderModal() {

    const modal =
        document.getElementById(
            "orderModal"
        );

    if (modal) {

        modal.style.display =
            "none";

    }

}

// ==========================================
// OPEN ORDER MODAL
// ==========================================

const btnAddOrder =
    document.getElementById(
        "btnAddOrder"
    );

if (btnAddOrder) {

    btnAddOrder.addEventListener(
        "click",
        async () => {

            await loadCustomers();

            await loadProducts();

            const modal =
                document.getElementById(
                    "orderModal"
                );

            if (modal) {

                modal.style.display =
                    "block";

            }

        }
    );

}

// ==========================================
// CLOSE BUTTON
// ==========================================

const closeButton =
    document.getElementById(
        "closeOrderModal"
    );

if (closeButton) {

    closeButton.addEventListener(
        "click",
        closeOrderModal
    );

}

// ==========================================
// CANCEL BUTTON
// ==========================================

const cancelButton =
    document.getElementById(
        "cancelOrder"
    );

if (cancelButton) {

    cancelButton.addEventListener(
        "click",
        closeOrderModal
    );

}

// ==========================================
// SAVE BUTTON
// ==========================================

const saveButton =
    document.getElementById(
        "saveOrder"
    );

if (saveButton) {

    saveButton.addEventListener(
        "click",
        saveOrder
    );

}

// ==========================================
// CLICK OUTSIDE MODAL
// ==========================================

window.addEventListener(
    "click",
    event => {

        const modal =
            document.getElementById(
                "orderModal"
            );

        if (
            modal &&
            event.target === modal
        ) {

            closeOrderModal();

        }

    }
);

// ==========================================
// LOGOUT
// ==========================================

const logoutButton =
    document.getElementById(
        "logoutButton"
    );

if (logoutButton) {

    logoutButton.addEventListener(
        "click",
        async () => {

            try {

                await fetch(
                    "/logout",
                    {
                        method: "POST"
                    }
                );

                window.location.href =
                    "/login";

            }
            catch (error) {

                console.error(
                    "Logout error:",
                    error
                );

            }

        }
    );

}

// ==========================================
// ESCAPE HTML
// ==========================================

function escapeHTML(
    value
) {

    return String(
        value
    )
        .replace(
            /&/g,
            "&amp;"
        )
        .replace(
            /</g,
            "&lt;"
        )
        .replace(
            />/g,
            "&gt;"
        )
        .replace(
            /"/g,
            "&quot;"
        )
        .replace(
            /'/g,
            "&#039;"
        );

}

// ==========================================
// START
// ==========================================

loadOrders();

// Cancel a pending order (and its delivery). The reason is shown in the delivery
// history and in the email to the customer.
document.getElementById("orderTableBody")?.addEventListener("click", async event => {
    const button = event.target.closest("[data-cancel-order]");
    if (!button) return;
    const order = ordersData.find(item => Number(item.order_id) === Number(button.dataset.cancelOrder));
    const reason = await olvPrompt(`Cancel the order of ${order ? order.customer_name : "this customer"}?\n\nType a short reason for the customer (optional).`,
        { title: "Cancel order", ok: "Cancel order", cancel: "Keep order", placeholder: "e.g. Out of stock today", danger: true });
    if (reason === null) return;
    button.disabled = true;
    try {
        const response = await fetch("/api/orders/cancel", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_id: Number(button.dataset.cancelOrder), reason }) });
        const result = await response.json();
        alert(result.message || (response.ok ? "Order cancelled." : "Unable to cancel the order."));
        await loadOrders({ refresh: true });
    } catch {
        alert("Unable to cancel the order. Check your connection and try again.");
        button.disabled = false;
    }
});

// Approve: staff checked the order's items, schedule, and address. The customer gets an email.
document.addEventListener("click", async event => {
    const button = event.target.closest("[data-approve-order]");
    if (!button) return;
    const order = ordersData.find(item => Number(item.order_id) === Number(button.dataset.approveOrder));
    const summary = order ? `\n\nItems: ${order.items || "-"}\nSchedule: ${order.fulfillment_method === "pickup" ? "Pickup at the station" : (order.delivery_date || order.preferred_date || "not set")}\nAddress: ${order.fulfillment_method === "pickup" ? "-" : (order.delivery_address || "-")}` : "";
    if (!(await olvConfirm(`Approve the order of ${order ? order.customer_name : "this customer"}?${summary}`, { ok: "Approve", title: "Approve order" }))) return;
    button.disabled = true;
    try {
        const response = await fetch("/api/orders/approve", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_id: Number(button.dataset.approveOrder) }) });
        const result = await response.json();
        if (!response.ok) alert(result.message || "Unable to approve the order.");
        await loadOrders({ refresh: true });
    } catch {
        alert("Unable to approve the order. Check your connection and try again.");
        button.disabled = false;
    }
});

// Keep the list in step with new portal orders and delivery updates
// (the Delivery page refreshes on the same 5-second cycle).
setInterval(() => loadOrders({ refresh: true }), 5000);

loadCustomers();

loadProducts();
