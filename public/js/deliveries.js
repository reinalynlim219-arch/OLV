let deliveries = [];
let isDriver = false;
let availableOrders = [];
let editingOrderId = null;
let currentDeliveryPage = 1;
const deliveryPageSize = 10;

const $ = id => document.getElementById(id);
const escapeHTML = value => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const DELIVERY_COLUMNS = 7;
const DELIVERY_STATUSES = ["scheduled", "out_for_delivery", "awaiting_customer", "delivered", "cancelled"];
let selectedStatus = "all";

const peso = value => "₱" + Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function statusLabel(status) {
    return String(status || "unknown").replace(/_/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

// "2026-09-21" -> "Sep 21, 2026"; "09:00" -> "9:00 AM" (no time zone shifting).
function formatScheduleDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return value || "-";
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
        .toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
}
// Order dates are stored in UTC; show them in Philippine time ("Sep 21, 2026").
function formatOrderedOn(value) {
    const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : String(value).replace(" ", "T") + "Z");
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric", year: "numeric" });
}
function formatScheduleTime(value) {
    const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
    if (!match) return "Any time";
    return new Date(2000, 0, 1, Number(match[1]), Number(match[2]))
        .toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
}

async function loadDeliveries() {
    const body = $("deliveryTableBody");
    try {
        const response = await fetch("/api/deliveries", { cache: "no-store" });
        if (response.status === 401 || response.status === 403) return window.location.href = "/login";
        if (!response.ok) throw new Error("Unable to load deliveries.");
        deliveries = await response.json();
        updateSummary();
        displayDeliveries();
        // The delivery plan and cash card follow the same list (see delivery-plan.js).
        if (window.refreshDeliveryPlan) window.refreshDeliveryPlan();
    } catch (error) {
        console.error(error);
        // The system may be restarting or the connection dropped: keep the last list
        // on screen and try again on the next refresh (every 5 seconds).
        if (deliveries.length) return;
        body.innerHTML = `<tr><td colspan="${DELIVERY_COLUMNS}" class="empty-message text-danger">Cannot reach the system right now. Retrying every few seconds… If this stays, check that the system is running, then reload the page.</td></tr>`;
    }
}

function updateSummary() {
    $("totalDeliveries").textContent = deliveries.length;
    $("scheduledDeliveries").textContent = deliveries.filter(d => d.status === "scheduled").length;
    $("outForDelivery").textContent = deliveries.filter(d => d.status === "out_for_delivery").length;
    $("awaitingCustomer").textContent = deliveries.filter(d => d.status === "awaiting_customer").length;
    // The cards are counts only. When a sidebar quick link opened the list filtered
    // (e.g. ?status=out_for_delivery), that card is marked and a note offers "Show all".
    document.querySelectorAll(".delivery-stat").forEach(card => {
        card.classList.toggle("is-filtered", selectedStatus !== "all" && card.dataset.status === selectedStatus);
    });
    showFilterNote();
}
function showFilterNote() {
    let note = document.getElementById("deliveryFilterNote");
    if (selectedStatus === "all") { note?.remove(); return; }
    if (!note) {
        note = document.createElement("p");
        note.id = "deliveryFilterNote";
        note.className = "delivery-filter-note";
        note.setAttribute("role", "status");
        $("deliveryTableBody").closest("table").parentElement.before(note);
    }
    const label = document.querySelector(`.delivery-stat[data-status="${selectedStatus}"] .stat-label`)?.textContent || selectedStatus;
    note.innerHTML = `<span>Showing: <strong></strong></span><button type="button">Show all deliveries</button>`;
    note.querySelector("strong").textContent = label;
    note.querySelector("button").addEventListener("click", () => {
        selectedStatus = "all";
        currentDeliveryPage = 1;
        window.history.replaceState(null, "", window.location.pathname);
        displayDeliveries();
        updateSummary();
    });
}

function displayDeliveries() {
    const filtered = getFilteredDeliveries();

    const body = $("deliveryTableBody");
    body.innerHTML = "";
    if (!filtered.length) {
        body.innerHTML = `<tr><td colspan="${DELIVERY_COLUMNS}" class="empty-message">No deliveries found.</td></tr>`;
        renderDeliveryPagination(0);
        return;
    }

    const totalPages = Math.ceil(filtered.length / deliveryPageSize);
    currentDeliveryPage = Math.min(currentDeliveryPage, totalPages);
    const startIndex = (currentDeliveryPage - 1) * deliveryPageSize;
    const pageDeliveries = filtered.slice(startIndex, startIndex + deliveryPageSize);

    pageDeliveries.forEach(delivery => {
        const row = document.createElement("tr");
        row.innerHTML = `
           <td>
                <div class="cell-main">${escapeHTML(delivery.customer_name || "-")}</div>
                <div class="cell-sub">${escapeHTML(olvPhone(delivery.contact_number) || "No contact")}</div>
            </td>
            <td class="cell-items">${escapeHTML(delivery.delivery_items || "-")}</td>
            <td>
                <div class="cell-main">${escapeHTML(formatScheduleDate(delivery.delivery_date))}</div>
                <div class="cell-sub">${escapeHTML(formatScheduleTime(delivery.delivery_time))}</div>
            </td>
            <td class="cell-address">${escapeHTML(delivery.delivery_address || "-")}</td>
            <td>${delivery.assigned_staff ? escapeHTML(delivery.assigned_staff) : `<span class="cell-sub">${isDriver ? "Open — press Start Delivery to take it" : "Unassigned"}</span>`}</td>
            <td>${createStatusBadge(delivery.status)}${Number(delivery.cash_collected) > 0 ? `<div class="cell-sub">Cash ${peso(delivery.cash_collected)} · ${delivery.remitted_at ? "remitted" : "not yet remitted"}</div>` : ""}</td>
            <td><div class="action-buttons">${createActionButtons(delivery)}</div></td>
        `;
        body.appendChild(row);
    });

    renderDeliveryPagination(filtered.length);
}

function renderDeliveryPagination(totalItems) {
    const pagination = $("deliveryPagination");
    if (!pagination) return;

    const totalPages = Math.ceil(totalItems / deliveryPageSize);
    if (totalPages <= 1) {
        pagination.innerHTML = "";
        return;
    }

    let controls = `<button type="button" class="delivery-page-button" ${currentDeliveryPage === 1 ? "disabled" : ""} onclick="changeDeliveryPage(${currentDeliveryPage - 1})" aria-label="Previous page">&lsaquo;</button>`;
    for (let page = 1; page <= totalPages; page += 1) {
        controls += `<button type="button" class="delivery-page-button ${page === currentDeliveryPage ? "active" : ""}" onclick="changeDeliveryPage(${page})" aria-label="Page ${page}" ${page === currentDeliveryPage ? "aria-current=\"page\"" : ""}>${page}</button>`;
    }
    controls += `<button type="button" class="delivery-page-button" ${currentDeliveryPage === totalPages ? "disabled" : ""} onclick="changeDeliveryPage(${currentDeliveryPage + 1})" aria-label="Next page">&rsaquo;</button>`;
    pagination.innerHTML = controls;
}

function changeDeliveryPage(page) {
    const totalPages = Math.max(1, Math.ceil(getFilteredDeliveries().length / deliveryPageSize));
    currentDeliveryPage = Math.max(1, Math.min(page, totalPages));
    displayDeliveries();
}

// The list is filtered by clicking the summary cards (or a dashboard quick link).
function getFilteredDeliveries() {
    return deliveries.filter(delivery => selectedStatus === "all" || delivery.status === selectedStatus);
}

function createStatusBadge(status) {
    const classes = {
        scheduled: "status-scheduled",
        out_for_delivery: "status-out",
        awaiting_customer: "status-awaiting",
        delivered: "status-delivered",
        cancelled: "status-cancelled"
    };
    return `<span class="status-badge ${classes[status] || "status-unknown"}">${escapeHTML(statusLabel(status))}</span>`;
}

function createActionButtons(delivery) {
    const id = Number(delivery.delivery_id);
    if (!id) return "";
    return `<button type="button" class="btn btn-sm btn-outline-secondary" onclick="showDeliveryTracking(${id})">Track</button> ${createStatusActions(delivery, id)}`;
}

function createStatusActions(delivery, id) {
    if (delivery.status === "scheduled") {
        return `${isDriver ? "" : `<button type="button" class="btn btn-sm btn-outline-primary" onclick="editDelivery(${id})">Edit / Assign</button> `}<button type="button" class="btn btn-sm btn-outline-primary" onclick="updateDeliveryStatus(${id}, 'out_for_delivery')">Start Delivery</button>`;
    }
    if (delivery.status === "out_for_delivery") {
        // Staff can still hand a delivery that is out to another driver.
        return `${isDriver ? "" : `<button type="button" class="btn btn-sm btn-outline-primary" onclick="editDelivery(${id})">Edit / Assign</button> `}<button type="button" class="btn btn-sm btn-outline-primary" onclick="confirmDriverDelivered(${id})">Driver Delivered</button>`;
    }
    // Finished or waiting deliveries: the Status column already says which,
    // so only offer the photos that were attached.
    const dropoff = delivery.has_dropoff_photo
        ? `<a class="btn btn-sm btn-outline-primary" href="/api/deliveries/dropoff-photo?delivery_id=${id}" target="_blank" rel="noopener">Drop-off photo</a> `
        : "";
    const receipt = !isDriver && delivery.has_receipt_photo
        ? `<a class="btn btn-sm btn-outline-primary" href="/api/customer/delivery/photo?delivery_id=${id}" target="_blank" rel="noopener">Receipt photo</a>`
        : "";
    if (delivery.status === "delivered" && !dropoff && !receipt && !isDriver) return '<span class="cell-sub">No photos</span>';
    return dropoff + receipt;
}

function buildAddress() {
    const parts = [];
    const house = $("deliveryHouseNumber").value.trim();
    const street = $("deliveryStreet").value.trim();
    const zone = $("deliveryZone").value.trim();
    const barangay = $("deliveryBarangay").value.trim();
    const city = $("deliveryCity").value.trim();
    const landmark = $("deliveryLandmark").value.trim();
    if (house) parts.push(house);
    if (street) parts.push(street);
    if (zone) parts.push(`Zone ${zone.replace(/^zone\s*/i, "")}`);
    if (barangay) parts.push(barangay);
    if (city) parts.push(city);
    if (landmark) parts.push(`Landmark: ${landmark}`);
    return parts.join(", ");
}

// The reverse of buildAddress(): "12, Rizal St, Zone 3, Bitano, Legazpi City, Landmark: …".
function addressParts(text) {
    const parts = String(text || "").split(",").map(part => part.trim()).filter(Boolean);
    const out = {};
    const landmark = parts.findIndex(part => /^landmark:/i.test(part));
    if (landmark >= 0) out.landmark = parts.splice(landmark).join(", ").replace(/^landmark:\s*/i, "");
    const city = parts.findIndex(part => ["Legazpi City", "Daraga"].includes(part));
    if (city >= 0) [out.city] = parts.splice(city, 1);
    const zone = parts.findIndex(part => /^zone\s/i.test(part));
    if (zone >= 0) out.zone = parts.splice(zone, 1)[0].replace(/^zone\s*/i, "");
    out.barangay = parts.length > 2 ? parts.pop() : "";
    out.house_number = parts.length > 1 ? parts.shift() : "";
    out.street = parts.join(", ");
    return out;
}

// Barangay drop-down: only the barangays of the chosen city (Legazpi City or Daraga).
const barangayPicker = window.OLVBarangays?.bind($("deliveryCity"), $("deliveryBarangay"));
function setCityAndBarangay(city, barangay) {
    city = ["Legazpi City", "Daraga"].includes(city) ? city : "Legazpi City";
    const name = window.OLVBarangays?.matchBarangay(city, barangay) || "";
    if (!barangayPicker) { $("deliveryCity").value = city; $("deliveryBarangay").value = name || barangay || ""; return; }
    barangayPicker.set(city, name);
    // An older saved barangay that is not on the list stays selected, so editing does not lose it.
    if (barangay && !name) {
        $("deliveryBarangay").append(new Option(barangay, barangay));
        $("deliveryBarangay").value = barangay;
    }
}

async function openAddDelivery() {
    editingOrderId = null;
    $("deliveryId").value = "";
    $("deliveryOrder").disabled = false;
    await loadDeliveryOptions();
    $("deliveryOrder").value = "";
    $("selectedOrderSummary").hidden = true;
    $("deliveryDate").value = new Date().toISOString().slice(0, 10);
    $("deliveryTime").value = "";
    $("deliveryCustomerName").value = "";
    $("deliveryContactNumber").value = "";
    $("deliveryReason").value = "Customer order delivery";
    $("deliveryItems").value = "";
    setCityAndBarangay("Legazpi City", "");
    $("deliveryZone").value = "";
    $("deliveryStreet").value = "";
    $("deliveryHouseNumber").value = "";
    $("deliveryLandmark").value = "";
    $("deliveryModalTitle").textContent = "Schedule Delivery";
    $("saveDelivery").textContent = "Schedule Delivery";
    $("deliveryModal").style.display = "block";
}

async function loadDeliveryOptions() {
    const select = $("deliveryOrder");
    select.innerHTML = '<option value="">No order — type the details below</option>';
    const response = await fetch("/api/deliveries/options", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.message || "Unable to load available orders.");
    const assignee = $('deliveryAssignee');
    assignee.replaceChildren(new Option('Unassigned', ''));
    (result.staff || []).forEach(person => assignee.add(new Option(person.full_name, person.user_id)));
    availableOrders = result.orders || [];
    availableOrders.forEach(order => {
        const option = document.createElement("option");
        option.value = order.order_id;
        option.textContent = `${order.customer_name} — ${order.order_items || "Items"}${order.order_date ? ` (ordered ${formatOrderedOn(order.order_date)})` : ""}`;
        select.appendChild(option);
    });
    if (!availableOrders.length) select.innerHTML = '<option value="">No order — type the details below (no undelivered orders)</option>';
}

// Choosing an order fills in the details (they can still be changed). Going back to
// "No order" keeps what was typed, so nothing is lost.
function applySelectedOrder() {
    const order = availableOrders.find(item => Number(item.order_id) === Number($("deliveryOrder").value));
    const summary = $("selectedOrderSummary");
    if (!order) {
        editingOrderId = null;
        summary.hidden = true;
        return;
    }
    editingOrderId = Number(order.order_id);
    $("deliveryCustomerName").value = order.customer_name || "";
    $("deliveryContactNumber").value = order.contact_number || "";
    $("deliveryItems").value = order.order_items || "";
    setCityAndBarangay(order.city, order.barangay || "");
    $("deliveryZone").value = order.zone || "";
    $("deliveryStreet").value = order.street || "";
    $("deliveryHouseNumber").value = order.house_number || "";
    $("deliveryLandmark").value = order.landmark || "";
    summary.innerHTML = `<strong>${escapeHTML(order.customer_name)}</strong><br>${escapeHTML(order.order_items || "No item details")}${order.order_date ? ` · ordered ${escapeHTML(formatOrderedOn(order.order_date))}` : ""}`;
    summary.hidden = false;
}

async function loadDeliveryEditor(id) {
    const delivery = deliveries.find(item => Number(item.delivery_id) === Number(id));
    if (!delivery) return;
    await loadDeliveryOptions();
    $("deliveryAssignee").value = delivery.assigned_to || "";
    editingOrderId = Number(delivery.order_id) || null;
    $("deliveryOrder").disabled = true;
    $("deliveryOrder").innerHTML = `<option value="${editingOrderId || ""}">${editingOrderId ? escapeHTML(`${delivery.customer_name || "Customer"} — ${delivery.delivery_items || "Order"}`) : "No order — details typed by staff"}</option>`;
    $("deliveryId").value = delivery.delivery_id;
    $("deliveryDate").value = delivery.delivery_date || "";
    $("deliveryTime").value = delivery.delivery_time || "";
    $("deliveryCustomerName").value = delivery.customer_name || "";
    $("deliveryContactNumber").value = delivery.contact_number || "";
    $("deliveryReason").value = delivery.delivery_reason || "";
    $("deliveryItems").value = delivery.delivery_items || "";
    // A delivery without an order has no customer record: read its saved address back.
    const address = delivery.barangay ? delivery : addressParts(delivery.delivery_address);
    setCityAndBarangay(address.city, address.barangay || "");
    $("deliveryZone").value = address.zone || "";
    $("deliveryStreet").value = address.street || "";
    $("deliveryHouseNumber").value = address.house_number || "";
    $("deliveryLandmark").value = address.landmark || "";
    $("deliveryModalTitle").textContent = "Edit Delivery";
    $("saveDelivery").textContent = "Save Changes";
    $("deliveryModal").style.display = "block";
}
window.editDelivery = id => loadDeliveryEditor(id).catch(error => alert(error.message));

async function saveDelivery() {
    const id = Number($("deliveryId").value);
    const orderId = editingOrderId || Number($("deliveryOrder").value);
    const deliveryAddress = buildAddress();
    const customerName = $("deliveryCustomerName").value.trim();
    const contactNumber = $("deliveryContactNumber").value.trim();
    const deliveryReason = $("deliveryReason").value.trim();
    const deliveryItems = $("deliveryItems").value.trim();
    if (!customerName) return alert("Enter the customer name.");
    if (!/^09\d{9}$/.test(contactNumber)) return alert("Enter the contact number as +63 and 10 digits, for example +63 9171234567.");
    if (!deliveryItems) return alert("Enter the items to deliver.");
    if (!deliveryReason) return alert("Enter the reason of delivery.");
    if (!$("deliveryDate").value) return alert("Select a delivery date.");
    if (!["Daraga", "Legazpi City"].includes($("deliveryCity").value)) return alert("Choose Daraga or Legazpi City.");
    if (!$("deliveryBarangay").value.trim() || !$("deliveryStreet").value.trim() || !$("deliveryHouseNumber").value.trim()) return alert("Barangay, street, and house/lot number are required.");
    const payload = {
        order_id: orderId || null,
        customer_name: customerName,
        contact_number: contactNumber,
        delivery_reason: deliveryReason,
        delivery_items: deliveryItems,
        delivery_date: $("deliveryDate").value,
        delivery_time: $("deliveryTime").value,
        delivery_address: deliveryAddress,
        assigned_to: Number($("deliveryAssignee").value) || null,
        status: "scheduled"
    };
    const response = await fetch(id ? "/api/deliveries/update" : "/api/deliveries/add", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(id ? { ...payload, delivery_id: id } : payload)
    });
    const result = await response.json();
    if (!response.ok || !result.success) return alert(result.message || "Unable to save delivery.");
    closeDeliveryModal();
    await loadDeliveries();
}

async function sendDeliveryStatus(id, status, extra = {}) {
    if (status === "out_for_delivery") {
        const delivery = deliveries.find(item => Number(item.delivery_id) === Number(id));
        const message = isDriver ? "Take this delivery and start it now? It will be assigned to you."
            : delivery && !delivery.assigned_to
                ? "Nobody is assigned to this delivery, so starting it will assign it to YOU.\n\nTo send a driver instead, press Cancel and use Edit / Assign first — or let the driver press Start Delivery on their account.\n\nStart it yourself?"
                : "Start this delivery now?";
        if (!(await olvConfirm(message, { ok: "Start delivery" }))) return;
    }
    const response = await fetch("/api/deliveries/status", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delivery_id: id, status, ...extra })
    });
    const result = await response.json();
    if (!response.ok || !result.success) return alert(result.message || "Unable to update delivery.");
    await loadDeliveries();
}
async function updateDeliveryStatus(id, status, extra = {}) {
    try { await sendDeliveryStatus(id, status, extra); }
    catch { alert('Unable to update delivery. Check your connection and try again.'); }
}
window.updateDeliveryStatus = updateDeliveryStatus;

// ==========================================
// DROP-OFF (with an optional photo)
// Drivers share their location so it can be checked against the customer's
// saved location. Admin and staff record it for the driver from the station,
// so no location is needed. A photo is optional, like the customer's receipt photo.
// ==========================================
let dropoffDeliveryId = null;
let dropoffBusy = false;

// Shrinks the chosen photo to a JPEG (max 1280 px) so it uploads quickly.
async function prepareDropoffPhoto(file) {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Choose a JPEG, PNG, or WebP image.");
    if (file.size > 10 * 1024 * 1024) throw new Error("Choose a photo smaller than 10 MB.");
    const dataURL = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Unable to read photo."));
        reader.readAsDataURL(file);
    });
    const img = new Image();
    img.src = dataURL;
    try { await img.decode(); } catch { throw new Error("Unable to open this image. Choose another photo."); }
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const photo = canvas.toDataURL("image/jpeg", 0.75);
    if (photo.length > 900000) throw new Error("This photo is too detailed. Choose a smaller image.");
    return photo;
}

// The driver's location, or null with a reason when the phone cannot share it.
function getDriverLocation() {
    return new Promise(resolve => {
        if (!navigator.geolocation || !window.isSecureContext) {
            return resolve({ reason: "This phone cannot share its location here (location needs the site to open with https, or location is not supported)." });
        }
        navigator.geolocation.getCurrentPosition(
            position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }),
            error => resolve({ reason: error && error.code === 1 ? "Location permission was not allowed." : "Your location could not be found." }),
            { enableHighAccuracy: true, timeout: 10000 });
    });
}

function confirmDriverDelivered(id) {
    const dialog = $("dropoffDialog");
    dropoffDeliveryId = id;
    $("dropoffForm").reset();
    $("dropoffPreview").hidden = true;
    $("dropoffPreview").removeAttribute("src");
    $("dropoffMessage").textContent = "";
    $("dropoffIntro").textContent = isDriver
        ? "Your location will be checked. Attach a photo of the dropped-off order if you wish. A photo is optional."
        : "Record that this order was dropped off at the customer's address. A photo is optional.";
    // Cash on delivery: checked by default, showing the order total to collect.
    const delivery = deliveries.find(item => Number(item.delivery_id) === Number(id));
    const total = delivery && Number(delivery.total_amount);
    $("dropoffCash").checked = true;
    $("dropoffCashLabel").textContent = total > 0 ? `Cash collected from the customer: ${peso(total)}` : "Cash collected from the customer";
    dialog.showModal();
}
window.confirmDriverDelivered = confirmDriverDelivered;

$("dropoffCameraButton").addEventListener("click", () => $("dropoffCamera").click());
$("dropoffCamera").addEventListener("change", () => {
    if ($("dropoffCamera").files.length) {
        $("dropoffPhoto").files = $("dropoffCamera").files;
        $("dropoffPhoto").dispatchEvent(new Event("change"));
    }
});
$("dropoffPhoto").addEventListener("change", async () => {
    const file = $("dropoffPhoto").files[0];
    $("dropoffPreview").hidden = true;
    $("dropoffMessage").textContent = "";
    if (!file) return;
    try {
        $("dropoffPreview").src = await prepareDropoffPhoto(file);
        $("dropoffPreview").hidden = false;
    } catch (error) { $("dropoffMessage").textContent = error.message; }
});
$("dropoffCancel").addEventListener("click", () => { if (!dropoffBusy) $("dropoffDialog").close(); });
$("dropoffDialog").addEventListener("cancel", event => { if (dropoffBusy) event.preventDefault(); });

$("dropoffForm").addEventListener("submit", async event => {
    event.preventDefault();
    if (dropoffBusy) return;
    const submit = $("dropoffSubmit");
    const message = $("dropoffMessage");
    dropoffBusy = true;
    submit.disabled = true;
    $("dropoffCancel").disabled = true;
    try {
        const body = { delivery_id: dropoffDeliveryId, status: "delivered", cash_collected: $("dropoffCash").checked,
            gallons_lent: Number($("dropoffGallonsLent").value) || 0, gallons_returned: Number($("dropoffGallonsReturned").value) || 0 };
        const file = $("dropoffPhoto").files[0];
        if (file) {
            message.textContent = "Preparing photo...";
            body.photo = await prepareDropoffPhoto(file);
        }
        if (isDriver) {
            message.textContent = "Checking your location...";
            const location = await getDriverLocation();
            if (location.reason) {
                if (!(await olvConfirm(`${location.reason}\n\nRecord the drop-off without a location check? This will be shown in the delivery history.`, { ok: "Record drop-off", danger: true }))) {
                    message.textContent = "Drop-off not recorded yet.";
                    return;
                }
            } else {
                body.driver_latitude = location.latitude;
                body.driver_longitude = location.longitude;
                body.driver_accuracy = location.accuracy;
            }
        }
        message.textContent = "Saving...";
        const send = async () => {
            const response = await fetch("/api/deliveries/status", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            return { response, result: await response.json() };
        };
        let { response, result } = await send();
        // Too far from the customer's saved location: the driver may still record it
        // (for example, when the customer saved the wrong spot); staff see it flagged.
        if (response.status === 409 && result.code === "LOCATION_MISMATCH") {
            if (!(await olvConfirm(`${result.message}\n\nIf you are at the right house, the customer's saved location may be wrong. Record the drop-off anyway? It will be flagged as "location did not match" in the delivery history for staff to review.`, { ok: "Record anyway", danger: true }))) {
                message.textContent = result.message;
                return;
            }
            body.accept_location_mismatch = true;
            message.textContent = "Saving...";
            ({ response, result } = await send());
        }
        if (!response.ok || !result.success) throw new Error(result.message || "Unable to record the drop-off.");
        $("dropoffDialog").close();
        alert(result.message);
        await loadDeliveries();
    } catch (error) {
        message.textContent = error.message || "Unable to record the drop-off. Check your connection and try again.";
    } finally {
        dropoffBusy = false;
        submit.disabled = false;
        $("dropoffCancel").disabled = false;
    }
});

function closeDeliveryModal() { $("deliveryModal").style.display = "none"; }

$("deliveryOrder").addEventListener("change", applySelectedOrder);
$("btnAddDelivery").addEventListener("click", () => openAddDelivery().catch(error => alert(error.message)));
$("saveDelivery").addEventListener("click", () => saveDelivery().catch(error => alert(error.message)));
$("cancelDelivery").addEventListener("click", closeDeliveryModal);
$("deliveryModal").addEventListener("click", event => { if (event.target === $("deliveryModal")) closeDeliveryModal(); });

async function startDeliveryPage() {
    const response = await fetch('/api/current-user');
    if (!response.ok) { window.location.href = '/login'; return; }
    const result = await response.json();
    isDriver = result.user.role === 'driver';
    // Drivers only use this page; the shared top bar hides Back to Dashboard for them.
    if (isDriver) $('btnAddDelivery').hidden = true;
    // Quick links from the dashboard menu: ?status=out_for_delivery, ?action=schedule
    const params = new URLSearchParams(window.location.search);
    if (DELIVERY_STATUSES.includes(params.get('status'))) selectedStatus = params.get('status');
    if (params.get('action') === 'schedule' && !isDriver) {
        window.history.replaceState(null, '', window.location.pathname);
        openAddDelivery().catch(error => alert(error.message));
    }
    await loadDeliveries();
    setInterval(loadDeliveries, 5000);
}
// If the system cannot be reached when the page opens (for example while it restarts),
// say so in plain words and keep trying until it answers.
function startWhenReachable() {
    startDeliveryPage().catch(error => {
        console.error(error);
        $("deliveryTableBody").innerHTML = `<tr><td colspan="${DELIVERY_COLUMNS}" class="empty-message text-danger">Cannot reach the system right now. Retrying every few seconds… If this stays, check that the system is running, then reload the page.</td></tr>`;
        setTimeout(startWhenReachable, 5000);
    });
}
startWhenReachable();
