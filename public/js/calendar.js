// Calendar page: a month grid with deliveries (by scheduled day) and, if chosen,
// orders (by the day they were placed). Clicking a day lists its deliveries and
// orders; each delivery opens the tracking window (status steps + history).
(function () {
    const $ = id => document.getElementById(id);
    const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
    const peso = value => "₱" + Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const statusGroup = { scheduled: "scheduled", out_for_delivery: "out", awaiting_customer: "out", delivered: "done", cancelled: "cancelled" };
    const statusText = { scheduled: "Scheduled", out_for_delivery: "Out for delivery", awaiting_customer: "Dropped off", delivered: "Delivered", cancelled: "Cancelled" };
    const time12 = value => {
        const m = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
        return m ? new Date(2000, 0, 1, +m[1], +m[2]).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : "Any time";
    };

    let month = today().slice(0, 7);
    let data = { deliveries: [], orders: [] };
    let selected = today();
    let role = "staff";
    const view = () => (role === "driver" ? "deliveries" : document.querySelector('input[name="calView"]:checked').value);

    function byDay(list) {
        const map = new Map();
        for (const item of list) { if (!map.has(item.day)) map.set(item.day, []); map.get(item.day).push(item); }
        return map;
    }

    function renderGrid() {
        const [y, m] = month.split("-").map(Number);
        const first = new Date(Date.UTC(y, m - 1, 1));
        const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
        $("calMonth").textContent = first.toLocaleDateString("en-PH", { timeZone: "UTC", month: "long", year: "numeric" });
        const deliveries = byDay(data.deliveries);
        const orders = byDay(view() === "both" ? data.orders : []);
        const cells = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(n => `<div class="cal-name" role="columnheader">${n}</div>`);
        for (let i = 0; i < first.getUTCDay(); i++) cells.push('<div class="cal-cell cal-empty" aria-hidden="true"></div>');
        for (let d = 1; d <= days; d++) {
            const key = `${month}-${String(d).padStart(2, "0")}`;
            const list = deliveries.get(key) || [];
            const counts = {};
            list.forEach(item => { const g = statusGroup[item.status] || "scheduled"; counts[g] = (counts[g] || 0) + 1; });
            const chips = ["scheduled", "out", "done", "cancelled"].filter(g => counts[g])
                .map(g => `<span class="cal-chip cal-${g}">${counts[g]}</span>`).join("");
            const orderCount = (orders.get(key) || []).length;
            const label = `${new Date(key + "T00:00:00Z").toLocaleDateString("en-PH", { timeZone: "UTC", month: "long", day: "numeric" })}: ${list.length} ${list.length === 1 ? "delivery" : "deliveries"}${view() === "both" ? `, ${orderCount} ${orderCount === 1 ? "order" : "orders"}` : ""}`;
            cells.push(`<button type="button" class="cal-cell${key === today() ? " is-today" : ""}${key === selected ? " is-selected" : ""}" data-day="${key}" aria-label="${escapeHTML(label)}" aria-pressed="${key === selected}">
                <span class="cal-date">${d}</span>
                <span class="cal-chips">${chips}${orderCount ? `<span class="cal-chip cal-order"><i class="bi bi-cart3" aria-hidden="true"></i> ${orderCount}</span>` : ""}</span>
            </button>`);
        }
        $("calGrid").innerHTML = cells.join("");
        document.querySelectorAll("[data-orders-only]").forEach(el => { el.hidden = view() !== "both"; });
    }

    function renderDay() {
        const nice = new Date(selected + "T00:00:00Z").toLocaleDateString("en-PH", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
        $("calDayTitle").textContent = nice;
        const deliveries = data.deliveries.filter(d => d.day === selected);
        const orders = view() === "both" ? data.orders.filter(o => o.day === selected) : [];
        let html = `<h4 class="cal-sub">Deliveries (${deliveries.length})</h4>`;
        html += deliveries.length ? `<ul class="cal-items">${deliveries.map(d => `<li>
                <div class="d-flex justify-content-between gap-2"><strong>${escapeHTML(d.customer_name || "Customer")}</strong><span class="cal-chip cal-${statusGroup[d.status] || "scheduled"}">${escapeHTML(statusText[d.status] || d.status)}</span></div>
                <small>${escapeHTML(time12(d.delivery_time))} · ${escapeHTML(d.driver_name || "No driver yet")}</small>
                <small>${escapeHTML(d.delivery_items || "")}</small>
                <small class="text-muted">${escapeHTML(d.delivery_address || "")}</small>
                <button type="button" class="btn btn-sm btn-outline-primary mt-1" data-track="${Number(d.delivery_id)}"><i class="bi bi-geo-alt" aria-hidden="true"></i> Track</button>
            </li>`).join("")}</ul>` : '<p class="text-muted small">No deliveries on this day.</p>';
        if (view() === "both") {
            html += `<h4 class="cal-sub">Orders placed (${orders.length})</h4>`;
            html += orders.length ? `<ul class="cal-items">${orders.map(o => `<li>
                    <div class="d-flex justify-content-between gap-2"><strong>#${Number(o.order_id)} ${escapeHTML(o.customer_name || "Walk-in")}</strong><span>${peso(o.total_amount)}</span></div>
                    <small>${escapeHTML(o.fulfillment_method === "pickup" ? "Pickup" : "Delivery")} · ${escapeHTML(o.status)}${o.preferred_date ? ` · wants it on ${escapeHTML(new Date(o.preferred_date + "T00:00:00Z").toLocaleDateString("en-PH", { timeZone: "UTC", month: "short", day: "numeric" }))}` : ""}</small>
                </li>`).join("")}</ul>` : '<p class="text-muted small">No orders placed on this day.</p>';
        }
        $("calDayList").innerHTML = html;
    }

    async function load() {
        try {
            const response = await fetch(`/api/calendar?month=${month}`, { cache: "no-store" });
            if (response.status === 401) return window.location.href = "/login";
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || "Unable to load the calendar.");
            data = result;
            role = result.role;
            if (role === "driver") {
                $("calViewGroup").hidden = true;
                $("calendarIntro").textContent = "Your deliveries by scheduled day. Click a day to see its list.";
            }
            renderGrid();
            renderDay();
        } catch (error) {
            $("calDayList").innerHTML = `<p class="text-danger small">${escapeHTML(error.message)}</p>`;
        }
    }

    function moveMonth(step) {
        const [y, m] = month.split("-").map(Number);
        month = new Date(Date.UTC(y, m - 1 + step, 1)).toISOString().slice(0, 7);
        selected = month === today().slice(0, 7) ? today() : `${month}-01`;
        load();
    }
    $("calPrev").addEventListener("click", () => moveMonth(-1));
    $("calNext").addEventListener("click", () => moveMonth(1));
    $("calToday").addEventListener("click", () => { month = today().slice(0, 7); selected = today(); load(); });
    document.querySelectorAll('input[name="calView"]').forEach(input => input.addEventListener("change", () => { renderGrid(); renderDay(); }));
    $("calGrid").addEventListener("click", event => {
        const cell = event.target.closest("[data-day]");
        if (!cell) return;
        selected = cell.dataset.day;
        renderGrid();
        renderDay();
        if (window.matchMedia("(max-width: 900px)").matches) $("calDayTitle").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    $("calDayList").addEventListener("click", event => {
        const button = event.target.closest("[data-track]");
        if (button) window.showDeliveryTracking(Number(button.dataset.track));
    });

    load();
    setInterval(load, 30000);
})();
