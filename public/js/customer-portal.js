const message = document.getElementById("portalMessage");
const peso = value => "₱" + Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const phTime = value => { if (!value) return "-"; const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : String(value).replace(" ", "T") + "Z"); return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }); };
let products = [];
let savedAddressComplete = false;
// Barangay dropdown follows the chosen city (Legazpi City or Daraga).
const barangayPicker = OLVBarangays.bind(document.getElementById("city"), document.getElementById("barangay"));

const escapeHTML = value => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

// Messages pop up in the middle of the screen (olvPopup, theme.js), so a problem
// like "Select a product." is never missed at the top of the page.
function showMessage(text, type = "success") {
    message.className = "alert d-none";
    window.olvPopup(text, type);
}

async function getJSON(url) {
    const response = await fetch(url, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "Unable to load information.");
    return data;
}

function selectedProduct() {
    const id = Number(document.getElementById("product").value);
    return products.find(item => Number(item.product_id) === id);
}

// Refill (own gallon) or new gallon + water, for products that offer a new gallon.
const offersNewGallon = product => Boolean(product) && Number(product.new_container_price) > 0;
const wantsNewGallon = () => offersNewGallon(selectedProduct()) && document.getElementById("optionNewGallon").checked;
function unitPrice(product) {
    return Number(product.price || 0) + (wantsNewGallon() ? Number(product.new_container_price) : 0);
}

function updateOrderTotal() {
    const product = selectedProduct();
    const quantity = Number(document.getElementById("quantity").value) || 0;
    const choice = document.getElementById("containerChoice");
    choice.hidden = !offersNewGallon(product);
    if (offersNewGallon(product)) {
        document.getElementById("optionRefillLabel").textContent = `Refill — I have my own gallon (${peso(product.price)} each)`;
        document.getElementById("optionNewGallonLabel").textContent = `New gallon + water (${peso(Number(product.price) + Number(product.new_container_price))} each)`;
    }
    const productTotal = product ? unitPrice(product) * quantity : 0;
    const method = document.getElementById("fulfillmentMethod")?.value || "delivery";
    // Delivery and pickup are both free: the total is the products only.
    document.getElementById("serviceFee").textContent = method === "delivery" ? "Free delivery" : "Pickup at the station";
    document.getElementById("orderTotal").textContent = peso(productTotal);
    const stockMessage = document.getElementById("stockMessage");
    if (!product) {
        stockMessage.textContent = "Select a product.";
        stockMessage.className = "form-text text-muted";
        return;
    }
    stockMessage.textContent = `Available stock: ${Number(product.stock_quantity || 0)} ${product.unit || "unit(s)"}`;
    stockMessage.className = Number(product.stock_quantity) > 0 ? "form-text text-success" : "form-text text-danger";
}

function renderProducts() {
    const container = document.getElementById("productChoices");
    const selectedId = Number(document.getElementById("product").value);
    const availableSelection = products.find(product => Number(product.product_id) === selectedId && Number(product.stock_quantity) > 0);
    if (!availableSelection) document.getElementById("product").value = "";
    document.getElementById("quantity").max = availableSelection ? Number(availableSelection.stock_quantity) : 100;
    container.innerHTML = "";
    if (!products.length) {
        container.innerHTML = '<p class="text-muted mb-0">No products are available right now. Please check again soon.</p>';
    }
    products.forEach(product => {
        const stock = Number(product.stock_quantity || 0);
        const isSelected = availableSelection && Number(product.product_id) === selectedId;
        const card = document.createElement("button");
        card.type = "button";
        card.className = `product-choice ${stock > 0 ? "" : "disabled"} ${isSelected ? "selected" : ""}`;
        card.setAttribute("aria-pressed", String(Boolean(isSelected)));
        card.disabled = stock <= 0;
        const priceLine = offersNewGallon(product)
            ? `${peso(product.price)} refill · ${peso(Number(product.price) + Number(product.new_container_price))} with new gallon`
            : `${peso(product.price)} / ${escapeHTML(product.unit || "unit")}`;
        card.innerHTML = `<strong>${escapeHTML(product.product_name)}</strong><span>${priceLine}</span><small>${stock > 0 ? `${stock} available` : "Out of stock"}</small>`;
        card.addEventListener("click", () => {
            const deselect = Number(document.getElementById("product").value) === Number(product.product_id);
            document.querySelectorAll(".product-choice").forEach(item => {
                item.classList.remove("selected");
                item.setAttribute("aria-pressed", "false");
            });
            if (deselect) {
                document.getElementById("product").value = "";
                document.getElementById("quantity").max = 100;
                updateOrderTotal();
                return;
            }
            card.classList.add("selected");
            card.setAttribute("aria-pressed", "true");
            document.getElementById("product").value = product.product_id;
            const quantity = document.getElementById("quantity");
            quantity.max = Math.max(1, stock);
            if (Number(quantity.value) > stock) quantity.value = stock || 1;
            updateOrderTotal();
        });
        container.appendChild(card);
    });
    updateOrderTotal();
}

async function loadProfile() {
    const data = await getJSON("/api/customer/profile");
    const customer = data.customer;
    document.getElementById("customerName").textContent = customer.customer_name;
    document.getElementById("fullName").value = customer.customer_name || "";
    barangayPicker.set(customer.city || "Legazpi City", customer.barangay || "");
    // Delivery orders use the address saved on the account (the same check the server makes).
    savedAddressComplete = Boolean(customer.barangay && customer.street && customer.house_number);
    // An older saved barangay that is not on the official list: orders still work,
    // but ask the customer to pick the correct barangay and save again.
    const notice = document.getElementById("barangayNotice");
    const offList = customer.barangay && !OLVBarangays.isKnownBarangay(customer.city || "Legazpi City", customer.barangay);
    notice.textContent = offList ? `Your saved barangay "${customer.barangay}" is not on the list. Please choose your barangay and save your delivery details.` : "";
    notice.hidden = !offList;
    document.getElementById("zone").value = customer.zone || "";
    document.getElementById("street").value = customer.street || "";
    document.getElementById("houseNumber").value = customer.house_number || "";
    document.getElementById("landmark").value = customer.landmark || "";
    document.getElementById("locationStatus").textContent = customer.latitude && customer.longitude ? "Delivery location is saved." : "Location is not saved yet.";
}

async function loadProducts() {
    const data = await getJSON("/api/customer/products");
    products = Array.isArray(data.products) ? data.products : [];
    renderProducts();
}

// Expected delivery from the station's delivery batches (one trip carries a set
// number of gallons, so a busy morning moves later orders to the next trip).
function etaText(eta) {
    const time = iso => new Date(iso).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
    const day = iso => {
        const key = date => new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
        if (key(iso) === key(Date.now())) return "today";
        if (key(iso) === key(Date.now() + 86400000)) return "tomorrow";
        return new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" });
    };
    if (eta.kind === "on_the_way") return `On the way — you are stop ${eta.stop_number} of ${eta.stops}`;
    if (eta.kind === "batch") return `Expected ${day(eta.from)}, about ${time(eta.from)}–${time(eta.to)} (trip ${eta.batch})`;
    if (eta.kind === "nearby") return `Expected ${day(eta.from)}, from about ${time(eta.from)} (you are near the station)`;
    if (eta.kind === "scheduled_time") {
        const date = new Date(`${eta.date}T${/^\d{2}:\d{2}/.test(eta.time || "") ? eta.time.slice(0, 5) : "00:00"}:00+08:00`);
        return `Scheduled for ${day(date)}${eta.time ? `, ${time(date)}` : ""}`;
    }
    return "";
}

// How many of the station's gallons the customer is holding (lent minus returned).
async function loadGallonStatus() {
    try {
        const data = await getJSON("/api/customer/gallons");
        const line = document.getElementById("gallonStatus");
        const parts = [];
        if (data.still_out > 0) parts.push(`You are holding ${data.still_out} of the station's ${data.still_out === 1 ? "gallon" : "gallons"}. Please return ${data.still_out === 1 ? "it" : "them"} with your next refill.`);
        if (data.bought > 0) parts.push(`You bought ${data.bought} new ${data.bought === 1 ? "gallon" : "gallons"} from us — ${data.bought === 1 ? "it is" : "they are"} yours to keep.`);
        line.textContent = parts.join(" ");
        line.hidden = !parts.length;
    } catch { /* optional information */ }
}

async function loadOrders() {
    loadGallonStatus();
    const data = await getJSON("/api/customer/orders");
    const body = document.getElementById("orders");
    if (!data.orders.length) {
        body.innerHTML = '<tr><td colspan="6" class="text-center text-muted py-4">You have not placed any orders yet.</td></tr>';
        return;
    }
    body.innerHTML = data.orders.map(order => {
        const deliveryStatus = order.delivery_status || "Not scheduled";
        const fulfillment = order.fulfillment_method === "pickup" ? "Pickup" : "Delivery";
        const cancelled = order.status === "cancelled";
        const deliveryId = Number(order.delivery_id);
        // All of an order's buttons sit side by side on one row (Track first);
        // a short note, if any, goes underneath.
        const buttons = [];
        let note = "";
        if (!cancelled && order.fulfillment_method !== "pickup" && deliveryId)
            buttons.push(`<button class="btn btn-sm btn-outline-primary" onclick="showDeliveryTracking(${deliveryId})">Track delivery</button>`);
        // A pending order can be cancelled until the driver leaves with it.
        if (order.status === "pending" && !["out_for_delivery", "awaiting_customer", "delivered"].includes(deliveryStatus))
            buttons.push(`<button class="btn btn-sm btn-outline-danger" onclick="cancelMyOrder(${Number(order.order_id)})">Cancel order</button>`);
        if (cancelled) {
            note = '<span class="small text-muted">This order was cancelled.</span>';
        } else if (order.fulfillment_method === "pickup" && order.status !== "completed") {
            // Staff confirm the pickup at the station counter.
            note = `<span class="small text-muted">Ready for pickup — show this order at the station. Staff will mark it as picked up.</span>`;
        } else if (["scheduled", "out_for_delivery"].includes(deliveryStatus)) {
            note = `<span class="small text-muted">You can confirm receipt once the driver marks it dropped off.</span>`;
        } else if (deliveryStatus === "awaiting_customer") {
            buttons.push(`<button class="btn btn-sm btn-success" onclick="openReceiptDialog(${deliveryId}, false, ${Boolean(order.has_receipt_photo)})">Order Received</button>`);
        } else if (deliveryStatus === "delivered") {
            note = '<span class="text-success small fw-semibold">Received</span>';
            if (!order.has_receipt_photo) buttons.push(`<button class="btn btn-sm btn-outline-primary" onclick="openReceiptDialog(${deliveryId}, true)">Add receipt photo</button>`);
            if (order.status === "pending") buttons.push(`<button class="btn btn-sm btn-success" onclick="openReceiptDialog(${deliveryId}, false, ${Boolean(order.has_receipt_photo)})">Finish confirmation</button>`);
        }
        if (order.has_dropoff_photo) buttons.push(`<a class="btn btn-sm btn-outline-secondary" href="/api/deliveries/dropoff-photo?delivery_id=${deliveryId}" target="_blank" rel="noopener">View drop-off photo</a>`);
        if (order.has_receipt_photo) buttons.push(`<a class="btn btn-sm btn-outline-secondary" href="/api/customer/delivery/photo?delivery_id=${deliveryId}" target="_blank" rel="noopener">View receipt photo</a>`);
        const action = `${buttons.length ? `<div class="order-main-buttons">${buttons.join("")}</div>` : ""}${note ? `<div class="${buttons.length ? "mt-1" : ""}">${note}</div>` : ""}`;
        const deliveryBadge = cancelled ? "Cancelled" : order.fulfillment_method === "pickup" ? fulfillment : (deliveryStatus === "awaiting_customer" ? "Awaiting your confirmation" : deliveryStatus === "delivered" ? "Received" : deliveryStatus.replaceAll("_", " "));
        return `<tr>
            <td>${escapeHTML(phTime(order.order_date))}</td>
            <td>${peso(order.total_amount)}</td>
            <td><span class="badge text-bg-${order.status === "completed" ? "success" : cancelled ? "secondary" : "warning"}">${escapeHTML(order.status)}</span>${order.approved_at && order.status === "pending" ? '<div class="small text-success fw-semibold mt-1">Approved by the station</div>' : ""}${order.eta ? `<div class="small text-primary fw-semibold mt-1 order-eta" style="min-width:150px">${escapeHTML(etaText(order.eta))}</div>` : ""}</td>
            <td>${escapeHTML(fulfillment)} · ${escapeHTML(deliveryBadge)}</td>
            <td>${escapeHTML(order.order_items || "Item details unavailable")}</td>
            <td>${action}</td>
        </tr>`;
    }).join("");
    promptDroppedOff(data.orders);
}

// Order confirmation pop-up: once per page visit for each dropped-off delivery,
// and not on top of another open window (it waits for the next refresh).
const promptedDeliveries = new Set();
let arrivedDelivery = null;
function promptDroppedOff(orders) {
    if (document.querySelector("dialog[open]")) return;
    const order = orders.find(o => o.status !== "cancelled" && o.delivery_status === "awaiting_customer" && !promptedDeliveries.has(Number(o.delivery_id)));
    if (!order) return;
    arrivedDelivery = order;
    promptedDeliveries.add(Number(order.delivery_id));
    document.getElementById("arrivedText").textContent = `The driver dropped off your order: ${order.order_items || "your order"} (${peso(order.total_amount)}). Did you receive it?`;
    document.getElementById("arrivedDialog").showModal();
}
document.getElementById("arrivedLater").addEventListener("click", () => document.getElementById("arrivedDialog").close());
document.getElementById("arrivedConfirm").addEventListener("click", () => {
    document.getElementById("arrivedDialog").close();
    if (arrivedDelivery) openReceiptDialog(Number(arrivedDelivery.delivery_id), false, Boolean(arrivedDelivery.has_receipt_photo));
});



async function cancelMyOrder(orderId) {
    if (!(await olvConfirm("Cancel this order? This cannot be undone, but you can place a new order anytime.", { ok: "Cancel order", cancel: "Keep order", danger: true }))) return;
    try {
        const response = await fetch("/api/customer/orders/cancel", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ order_id: orderId }) });
        const result = await response.json();
        alert(result.message || (response.ok ? "Order cancelled." : "Unable to cancel the order."));
        await loadOrders();
    } catch {
        alert("Unable to cancel the order. Check your connection and try again.");
    }
}

document.getElementById("orderForm").addEventListener("submit", async event => {
    event.preventDefault();
    const product = selectedProduct();
    const quantity = Number(document.getElementById("quantity").value);
    const fulfillmentMethod = document.getElementById("fulfillmentMethod").value;
    if (!product) return showMessage("Select a product.", "danger");
    if (!Number.isInteger(quantity) || quantity < 1) return showMessage("Quantity must be at least 1.", "danger");
    if (!["delivery", "pickup"].includes(fulfillmentMethod)) return showMessage("Choose delivery or pickup.", "danger");
    if (fulfillmentMethod === "delivery" && !savedAddressComplete) return showMessage("Save your delivery address in Delivery details first, or choose pickup.", "danger");
    if (quantity > Number(product.stock_quantity || 0)) return showMessage(`Insufficient stock. Only ${product.stock_quantity} is available.`, "danger");
    try {
        const response = await fetch("/api/customer/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ product_id: product.product_id, quantity, fulfillment_method: fulfillmentMethod, with_new_container: wantsNewGallon(),
                ...(fulfillmentMethod === "delivery" ? { preferred_date: preferredDate } : {}) })
        });
        const data = await response.json();
        if (!response.ok) return showMessage(data.message || "Unable to submit order.", "danger");
        showMessage(`Order request submitted. Total: ${peso(data.total_amount)}.`);
        event.target.reset();
        document.getElementById("product").value = "";
        document.querySelectorAll(".product-choice").forEach(item => item.classList.remove("selected"));
        document.getElementById("quantity").value = 1;
        await loadProducts();
        await loadOrders();
    } catch (error) {
        showMessage("Unable to connect to the server.", "danger");
    }
});

// ---------- preferred delivery date (small calendar) ----------
// Today up to 30 days ahead, in Philippine time. Today is chosen at the start.
const phDay = (offset = 0) => new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
let preferredDate = phDay();
let calendarMonth = preferredDate.slice(0, 7);
function prettyDay(key) {
    return new Date(key + "T00:00:00Z").toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" });
}
function renderPreferredCalendar() {
    const box = document.getElementById("preferredCalendar");
    if (!box) return;
    const first = phDay(), last = phDay(30);
    const [y, m] = calendarMonth.split("-").map(Number);
    const start = new Date(Date.UTC(y, m - 1, 1));
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = Array.from({ length: start.getUTCDay() }, () => '<span class="mini-cal-blank"></span>');
    for (let d = 1; d <= days; d++) {
        const key = `${calendarMonth}-${String(d).padStart(2, "0")}`;
        const allowed = key >= first && key <= last;
        cells.push(`<button type="button" class="mini-cal-day${key === preferredDate ? " selected" : ""}${key === first ? " today" : ""}" data-day="${key}" ${allowed ? "" : "disabled"}
            aria-pressed="${key === preferredDate}" aria-label="${escapeHTML(prettyDay(key))}">${d}</button>`);
    }
    const monthName = start.toLocaleDateString("en-PH", { timeZone: "UTC", month: "long", year: "numeric" });
    box.innerHTML = `<div class="mini-cal-head">
            <button type="button" class="mini-cal-nav" data-move="-1" ${calendarMonth <= first.slice(0, 7) ? "disabled" : ""} aria-label="Previous month">‹</button>
            <strong>${escapeHTML(monthName)}</strong>
            <button type="button" class="mini-cal-nav" data-move="1" ${calendarMonth >= last.slice(0, 7) ? "disabled" : ""} aria-label="Next month">›</button>
        </div>
        <div class="mini-cal-grid">${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map(n => `<span class="mini-cal-name">${n}</span>`).join("")}${cells.join("")}</div>`;
    document.getElementById("preferredDateText").textContent = `Deliver on ${prettyDay(preferredDate)}${preferredDate === first ? " (today)" : preferredDate === phDay(1) ? " (tomorrow)" : ""}.`;
}
document.getElementById("preferredCalendar")?.addEventListener("click", event => {
    const day = event.target.closest("[data-day]");
    const move = event.target.closest("[data-move]");
    if (day && !day.disabled) preferredDate = day.dataset.day;
    if (move && !move.disabled) {
        const [y, m] = calendarMonth.split("-").map(Number);
        calendarMonth = new Date(Date.UTC(y, m - 1 + Number(move.dataset.move), 1)).toISOString().slice(0, 7);
    }
    if (day || move) renderPreferredCalendar();
});
function showPreferredDate() {
    document.getElementById("preferredDateField").hidden = document.getElementById("fulfillmentMethod").value !== "delivery";
}
renderPreferredCalendar();
showPreferredDate();
document.getElementById("fulfillmentMethod")?.addEventListener("change", showPreferredDate);

document.getElementById("fulfillmentMethod")?.addEventListener("change", updateOrderTotal);
document.querySelectorAll('input[name="containerOption"]').forEach(option => option.addEventListener("change", updateOrderTotal));

document.getElementById("quantity").addEventListener("input", updateOrderTotal);

document.getElementById("profileForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (!document.getElementById("barangay").value) return showMessage("Choose your barangay.", "danger");
    const response = await fetch("/api/customer/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            full_name: document.getElementById("fullName").value.trim(),
            city: document.getElementById("city").value,
            barangay: document.getElementById("barangay").value,
            zone: document.getElementById("zone").value.trim(),
            street: document.getElementById("street").value.trim(),
            house_number: document.getElementById("houseNumber").value.trim(),
            landmark: document.getElementById("landmark").value.trim()
        })
    });
    const data = await response.json();
    if (!response.ok) return showMessage(data.message || "Unable to save details.", "danger");
    document.getElementById("customerName").textContent = document.getElementById("fullName").value;
    showMessage(data.message);
    await loadProfile().catch(error => console.error(error));
});

document.getElementById("saveLocationButton").addEventListener("click", () => {
    const status = document.getElementById("locationStatus");
    if (!navigator.geolocation) return showMessage("This browser does not support location services.", "danger");
    status.textContent = "Getting your current location...";
    navigator.geolocation.getCurrentPosition(async position => {
        const response = await fetch("/api/customer/location", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy })
        });
        const data = await response.json();
        if (!response.ok) {
            status.textContent = "Location was not saved.";
            return showMessage(data.message || "Unable to save location.", "danger");
        }
        status.textContent = "Delivery location is saved.";
        showMessage(data.message);
    }, () => {
        status.textContent = "Location permission was not granted.";
        showMessage("Please allow location access so delivery confirmation can be validated.", "danger");
    }, { enableHighAccuracy: true, timeout: 10000 });
});

document.getElementById("logoutButton").addEventListener("click", async () => {
    await fetch("/logout", { method: "POST" });
    window.location.href = "/login";
});

Promise.all([loadProfile(), loadProducts(), loadOrders()]).catch(error => {
    console.error(error);
    showMessage(error.message, "danger");
    if (/login|access/i.test(error.message)) window.location.href = "/login";
});

setInterval(() => loadProducts().catch(() => {}), 5000);
setInterval(() => loadOrders().catch(() => {}), 5000);
