// Delivery plan (batches + route order) and cash remittance on the Delivery page.
// Uses $, escapeHTML, peso, and isDriver from deliveries.js.
let planData = null;
let planRole = "";
let planStaff = null;
let lastPlanJSON = "";
let lastRemitJSON = "";
let planBusy = false;

const phTimeOf = iso => new Date(iso).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
const phDayKey = date => new Date(date).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
function dayWord(iso) {
    const today = phDayKey(Date.now());
    const day = phDayKey(iso);
    if (day === today) return "today";
    if (day === phDayKey(Date.now() + 86400000)) return "tomorrow";
    return new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" });
}
const distanceText = m => m == null ? "" : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
const gallonText = n => `${n} ${Number(n) === 1 ? "gallon" : "gallons"}`;

// "1.2 km by road, about 4 min" when road distances are available, else a straight line.
function legText(stop) {
    if (planData.distance_source !== "road") return `${distanceText(stop.leg_m)} (straight line)`;
    return `${distanceText(stop.leg_m)} by road${stop.leg_s != null ? `, about ${Math.max(1, Math.round(stop.leg_s / 60))} min` : ""}`;
}
// "4.3 km round trip by road, about 14 min driving" for a whole trip.
function tripText(trip) {
    if (trip.route_m == null) return "";
    const round = planData.settings.station_saved ? " round trip" : "";
    return planData.distance_source === "road"
        ? ` · ${distanceText(trip.route_m)}${round} by road${trip.drive_minutes != null ? `, about ${trip.drive_minutes} min driving` : ""}`
        : ` · ${distanceText(trip.route_m)}${round} (straight line)`;
}

function stopItem(stop, index, fromStation) {
    const where = !stop.has_location
        ? `<span class="plan-warn">No saved location — call ${escapeHTML(olvPhone(stop.contact_number) || "the customer")}</span>`
        : `${legText(stop)} ${index === 0 && fromStation ? "from the station" : "from the previous stop"}`
          + ` · <a href="https://www.google.com/maps/dir/?api=1&destination=${stop.latitude},${stop.longitude}" target="_blank" rel="noopener">Map</a>`;
    const time = stop.delivery_time ? ` · <strong>requested ${escapeHTML(formatScheduleTime(stop.delivery_time))}</strong>` : "";
    const cameIn = stop.ordered_at ? `<span class="plan-in">ordered ${phTimeOf(stop.ordered_at)} ${dayWord(stop.ordered_at)}</span>` : "";
    const approval = stop.approved || stop.status !== "scheduled" ? "" : `<span class="plan-new">New · not yet approved</span>`;
    return `<li class="plan-stop">
        <div class="cell-main">${escapeHTML(stop.customer_name || "Customer")} <span class="plan-gallons">${gallonText(stop.gallons)}</span>${cameIn}${approval}</div>
        <div class="cell-sub plan-wrap">${escapeHTML(stop.address || "No address")}</div>
        <div class="cell-sub plan-wrap">${where}${time}</div>
    </li>`;
}

function batchActions(batch) {
    if (planRole === "driver") return `<button type="button" class="btn btn-sm btn-primary" data-start-batch="${batch.number}">Take this batch</button>`;
    const options = (planStaff || []).map(person => `<option value="${Number(person.user_id)}">${escapeHTML(person.full_name)}</option>`).join("");
    return `<label class="visually-hidden" for="batchDriver${batch.number}">Driver for batch ${batch.number}</label>
        <select id="batchDriver${batch.number}" class="form-select form-select-sm plan-driver"><option value="">Choose driver</option>${options}</select>
        <button type="button" class="btn btn-sm btn-primary" data-start-batch="${batch.number}">Send out batch</button>`;
}

// The delivery algorithm, step by step: each step's rule and what it gives right now.
// Customer orders come in at step 1 and go out at step 5.
function algorithmSteps(plan) {
    const s = plan.settings;
    const queued = [...plan.batches.flatMap(b => b.stops), ...plan.nearby.stops];
    const f = plan.flow || {
        came_in: null, waiting: queued.length, waiting_gallons: queued.reduce((sum, stop) => sum + stop.gallons, 0),
        not_approved: queued.filter(stop => stop.approved === false).length,
        on_the_road: plan.trips_out.reduce((sum, trip) => sum + trip.stops.length, 0), dropped_off: null, later: plan.later.length
    };
    const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const batchList = plan.batches.map(b => `Batch ${b.number}: ${b.gallons}/${b.capacity} gal`).join(" · ");
    const routeList = plan.batches.map(b => `Batch ${b.number}: ${count(b.stops.length, "stop", "stops")}${b.route_m != null ? `, ${distanceText(b.route_m)}` : ""}`).join(" · ");
    const leaveList = plan.batches.map(b => `Batch ${b.number} leaves ${phTimeOf(b.leaves_at)} ${dayWord(b.leaves_at)}`).join(" · ");
    const step = (n, title, rule, result) => `<li class="algo-step"><span class="algo-num" aria-hidden="true">${n}</span>
        <div class="algo-text"><strong>${title}</strong><span class="algo-rule">${rule}</span></div>
        <div class="algo-result">${result}</div></li>`;
    return `<ol class="algo-steps" aria-label="Delivery Sequence">
        ${step(1, "Queue the orders (in)",
            "Each delivery order joins the queue in the order it came in, on the date the customer chose.",
            `${f.came_in != null ? `${count(f.came_in, "order", "orders")} came in today · ` : ""}${count(f.waiting, "delivery", "deliveries")} waiting, ${gallonText(f.waiting_gallons)}${f.not_approved ? ` · ${f.not_approved} not yet approved` : ""}${f.later ? ` · ${f.later} on later dates` : ""}`)}
        ${step(2, "Group into batches",
            `Fill each trip up to ${gallonText(s.vehicle_capacity)} (the vehicle's capacity), first come, first served, so no order waits forever.`,
            plan.batches.length ? `${count(plan.batches.length, "batch", "batches")}: ${batchList}` : "No batch needed right now")}
        ${step(3, "Order the stops",
            `Nearest stop first, starting from the station${plan.distance_source === "road" ? " (by road)" : ""}${Number(s.walk_radius_m) > 0 ? `. Customers within ${s.walk_radius_m} m are walked over and take no vehicle space` : ""}.`,
            `${plan.batches.length ? routeList : "No route to plan"}${plan.nearby.stops.length ? ` · ${count(plan.nearby.stops.length, "walk-over", "walk-overs")}` : ""}`)}
        ${step(4, "Schedule the trips",
            `A trip leaves when the vehicle is back from the last one (about ${s.trip_minutes} min), between ${formatScheduleTime(s.first_trip)} and ${formatScheduleTime(s.last_trip)}; later trips move to the next day.`,
            plan.batches.length ? leaveList : "Nothing to schedule")}
        ${step(5, "Send out and drop off (out)",
            "A batch sent out leaves the queue and steps 1–4 run again. A dropped-off delivery leaves the plan, and its cash goes to Cash to remit.",
            `${count(f.on_the_road, "delivery", "deliveries")} on the road${f.dropped_off != null ? ` · ${f.dropped_off} dropped off today` : ""}`)}
    </ol>`;
}

function renderPlan(plan) {
    const s = plan.settings;
    $("planRules").textContent = `One trip carries up to ${gallonText(s.vehicle_capacity)} · trips leave ${formatScheduleTime(s.first_trip)}–${formatScheduleTime(s.last_trip)}, about ${s.trip_minutes} min each`
        + (Number(s.walk_radius_m) > 0 ? ` · walk-over within ${s.walk_radius_m} m` : "")
        + (plan.distance_source === "road" ? " · distances are by road" : " · road distances are unavailable right now, so distances are straight-line");
    const fromStation = s.station_saved;
    let html = algorithmSteps(plan);
    if (!s.station_saved) {
        html += `<div class="alert alert-warning py-2 small">${planRole === "admin"
            ? "Save the station's location in <strong>Delivery settings</strong> so each trip starts from the station and walk-over customers are found."
            : "The admin has not saved the station's location yet, so routes start from the first stop and walk-over customers are not found."}</div>`;
    }
    plan.trips_out.forEach(trip => {
        html += `<div class="plan-group plan-out">
            <div class="plan-head"><div><strong>${escapeHTML(planRole === "driver" ? "Your trip" : trip.driver)}</strong> · on the road · ${gallonText(trip.gallons)}, ${trip.stops.length} ${trip.stops.length === 1 ? "stop" : "stops"}${tripText(trip)}</div>
            <div class="plan-actions"><span class="plan-note">Deliver in this order</span></div></div>
            <ol class="plan-stops">${trip.stops.map((stop, i) => stopItem(stop, i, fromStation)).join("")}</ol></div>`;
    });
    if (plan.nearby.stops.length) {
        html += `<div class="plan-group plan-walk">
            <div class="plan-head"><div><strong>Walk-over</strong> · within ${plan.nearby.radius_m} m of the station · carry or push cart, no vehicle needed</div></div>
            <ol class="plan-stops">${plan.nearby.stops.map((stop, i) => stopItem(stop, i, fromStation)).join("")}</ol></div>`;
    }
    plan.batches.forEach(batch => {
        html += `<div class="plan-group">
            <div class="plan-head">
                <div><strong>Batch ${batch.number}</strong> · ${batch.gallons} of ${batch.capacity} gallons · leaves ${phTimeOf(batch.leaves_at)} ${dayWord(batch.leaves_at)}, back by about ${phTimeOf(batch.back_by)}${tripText(batch)}
                ${batch.over_capacity ? `<div class="plan-warn">One order is bigger than a full trip — it needs more than one trip.</div>` : ""}</div>
                <div class="plan-actions">${batchActions(batch)}</div>
            </div>
            <ol class="plan-stops">${batch.stops.map((stop, i) => stopItem(stop, i, fromStation)).join("")}</ol></div>`;
    });
    if (!plan.trips_out.length && !plan.batches.length && !plan.nearby.stops.length) html += `<p class="empty-message mb-0">No deliveries are waiting.</p>`;
    if (plan.later.length) html += `<p class="cell-sub mt-2 mb-0">${plan.later.length} more ${plan.later.length === 1 ? "delivery is" : "deliveries are"} scheduled for a later date.</p>`;
    $("planBody").innerHTML = html;
}

let remitData = null;
function renderRemittance(data) {
    remitData = data;
    let html = "";
    if (data.role === "driver") {
        const mine = data.drivers[0];
        html += mine
            ? `<p class="mb-2"><span class="remit-amount">${peso(mine.amount)}</span> to hand over to the station, from ${mine.deliveries.length} ${mine.deliveries.length === 1 ? "delivery" : "deliveries"}.</p>
               <ul class="remit-list">${mine.deliveries.map(d => `<li>${escapeHTML(d.customer_name || "Customer")} — ${peso(d.amount)}</li>`).join("")}</ul>`
            : `<p class="empty-message mb-0">You have no cash to remit.</p>`;
    } else if (data.drivers.length) {
        html += `<div class="table-responsive"><table class="table align-middle mb-0"><thead><tr><th>Driver</th><th>Deliveries</th><th>Cash to remit</th><th></th></tr></thead><tbody>
            ${data.drivers.map(driver => `<tr><td class="cell-main">${escapeHTML(driver.driver)}</td><td>${driver.deliveries.length}</td><td class="remit-amount">${peso(driver.amount)}</td>
            <td>${driver.driver_id ? `<button type="button" class="btn btn-sm btn-success" data-remit-driver="${Number(driver.driver_id)}">Received ${peso(driver.amount)}</button>` : ""}</td></tr>`).join("")}
            </tbody></table></div>`;
    } else {
        html += `<p class="empty-message mb-0">No cash is waiting to be remitted.</p>`;
    }
    if (data.recent.length) {
        html += `<details class="mt-3"><summary class="cell-sub">Remitted in the last 7 days</summary><ul class="remit-list mt-2">
            ${data.recent.map(r => `<li>${escapeHTML(r.driver || "Driver")} — ${peso(r.amount)} (${r.deliveries} ${Number(r.deliveries) === 1 ? "delivery" : "deliveries"}), received by ${escapeHTML(r.received_by || "staff")} on ${escapeHTML(new Date(String(r.remitted_at).replace(" ", "T") + "Z").toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" }))}</li>`).join("")}
        </ul></details>`;
    }
    $("remitBody").innerHTML = html;
}

async function refreshDeliveryPlan() {
    if (planBusy) return;
    planBusy = true;
    try {
        const [planResponse, remitResponse] = await Promise.all([
            fetch("/api/deliveries/plan", { cache: "no-store" }),
            fetch("/api/remittance", { cache: "no-store" })
        ]);
        const plan = await planResponse.json();
        if (!planResponse.ok || !plan.success) throw new Error(plan.message || "Unable to load the delivery sequence.");
        planRole = plan.role;
        $("btnPlanSettings").hidden = planRole !== "admin";
        if (planRole !== "driver" && !planStaff) {
            const options = await (await fetch("/api/deliveries/options", { cache: "no-store" })).json();
            planStaff = options.staff || [];
        }
        planData = plan;
        // Re-draw only when something changed, so a chosen driver is not reset every refresh.
        const { generated_at, ...comparable } = plan;
        const json = JSON.stringify(comparable);
        if (json !== lastPlanJSON) { lastPlanJSON = json; renderPlan(plan); }
        const remit = await remitResponse.json();
        if (remitResponse.ok && remit.success) {
            const remitJSON = JSON.stringify(remit);
            if (remitJSON !== lastRemitJSON) { lastRemitJSON = remitJSON; renderRemittance(remit); }
        }
    } catch (error) {
        console.error(error);
        if (!planData) $("planBody").innerHTML = `<p class="empty-message text-danger mb-0">${escapeHTML(error.message || "Unable to load the delivery sequence.")}</p>`;
    } finally {
        planBusy = false;
    }
}
window.refreshDeliveryPlan = refreshDeliveryPlan;

// Buttons drawn by renderPlan / renderRemittance.
$("planBody").addEventListener("click", event => {
    const button = event.target.closest("[data-start-batch]");
    const batch = button && planData && planData.batches.find(b => b.number === Number(button.dataset.startBatch));
    if (batch) startBatch(batch.stops.map(stop => stop.delivery_id), batch.number);
});
$("remitBody").addEventListener("click", event => {
    const button = event.target.closest("[data-remit-driver]");
    const driver = button && remitData && remitData.drivers.find(d => Number(d.driver_id) === Number(button.dataset.remitDriver));
    if (driver) receiveRemittance(Number(driver.driver_id), driver.deliveries.map(d => d.delivery_id), driver.driver, Number(driver.amount));
});

async function startBatch(ids, number) {
    const body = { delivery_ids: ids };
    if (planRole === "driver") {
        if (!(await olvConfirm(`Take this batch of ${ids.length} ${ids.length === 1 ? "delivery" : "deliveries"} and start it now? They will be assigned to you.`, { ok: "Start batch" }))) return;
    } else {
        const driver = $(`batchDriver${number}`).value;
        if (!driver) return alert("Choose the driver who will take this batch.");
        // (The list refreshes every few seconds; the driver was read above, before asking.)
        if (!(await olvConfirm(`Send out batch ${number} (${ids.length} ${ids.length === 1 ? "delivery" : "deliveries"}) with ${$(`batchDriver${number}`).selectedOptions[0].textContent}?`, { ok: "Send out batch" }))) return;
        body.assigned_to = Number(driver);
    }
    try {
        const response = await fetch("/api/deliveries/plan/start-batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const result = await response.json();
        alert(result.message || (response.ok ? "Batch started." : "Unable to start the batch."));
        await loadDeliveries();
    } catch { alert("Unable to start the batch. Check your connection and try again."); }
}
window.startBatch = startBatch;

async function receiveRemittance(driverId, deliveryIds, driverName, amount) {
    if (!(await olvConfirm(`Confirm that you received ${peso(amount)} in cash from ${driverName}?`, { ok: "Yes, received", title: "Confirm cash received" }))) return;
    try {
        const response = await fetch("/api/remittance/remit", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ driver_id: driverId, delivery_ids: deliveryIds }) });
        const result = await response.json();
        alert(result.message || (response.ok ? "Remittance received." : "Unable to record the remittance."));
        lastRemitJSON = "";
        await refreshDeliveryPlan();
    } catch { alert("Unable to record the remittance. Check your connection and try again."); }
}
window.receiveRemittance = receiveRemittance;

// ---------- Delivery settings (admin) ----------
// The station location as typed numbers ("13.1514, 123.7444") or a pasted Google Maps
// link. In a link, "@lat,lng" is where the map or Street View camera is (the spot the
// admin was looking at); "!3d…!4d…" is the place's pin, which for an area (a barangay)
// is only its middle, so it is used only when there is no "@".
function stationFromText(text) {
    const number = "(-?\\d{1,3}(?:\\.\\d+)?)";
    const patterns = [new RegExp(`^${number}\\s*,\\s*${number}$`), new RegExp(`@${number},${number}`), new RegExp(`[?&](?:q|query|ll|destination)=${number}(?:,|%2C)${number}`), new RegExp(`!3d${number}!4d${number}`)];
    for (const pattern of patterns) {
        const found = pattern.exec(text);
        if (found) return [found[0], found[1], found[2]];
    }
    return null;
}
$("btnPlanSettings").addEventListener("click", () => {
    if (!planData) return;
    const s = planData.settings;
    $("setCapacity").value = s.vehicle_capacity;
    $("setFirstTrip").value = s.first_trip;
    $("setLastTrip").value = s.last_trip;
    $("setTripMinutes").value = s.trip_minutes;
    $("setWalkRadius").value = s.walk_radius_m;
    $("setStation").value = s.station_saved ? `${s.station_latitude}, ${s.station_longitude}` : "";
    $("planSettingsMessage").textContent = "";
    $("planSettingsDialog").showModal();
});
$("planSettingsCancel").addEventListener("click", () => $("planSettingsDialog").close());
$("planSettingsForm").addEventListener("submit", async event => {
    event.preventDefault();
    const message = $("planSettingsMessage");
    const station = $("setStation").value.trim();
    const match = stationFromText(station);
    if (station && !match) { message.textContent = "Enter the station location as two numbers, like 13.1514, 123.7444, or paste a Google Maps link of the station."; return; }
    const body = {
        vehicle_capacity: Number($("setCapacity").value), first_trip: $("setFirstTrip").value, last_trip: $("setLastTrip").value,
        trip_minutes: Number($("setTripMinutes").value), walk_radius_m: Number($("setWalkRadius").value),
        station_latitude: match ? Number(match[1]) : null, station_longitude: match ? Number(match[2]) : null
    };
    try {
        const response = await fetch("/api/deliveries/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const result = await response.json();
        if (!response.ok || !result.success) { message.textContent = result.message || "Unable to save the settings."; return; }
        $("planSettingsDialog").close();
        lastPlanJSON = "";
        await refreshDeliveryPlan();
    } catch { message.textContent = "Unable to save the settings. Check your connection and try again."; }
});
