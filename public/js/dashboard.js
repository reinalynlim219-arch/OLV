const escapeHTML = value => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

// The database stores times in UTC; show them in Philippine time.
const formatPhilippineTime = value => {
    if (!value) return "-";
    const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : String(value).replace(" ", "T") + "Z");
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
};

let recentTransactions = [];
let currentRecentTransactionsPage = 1;
const recentTransactionsPageSize = 10;

async function loadCurrentUser() {
    const response = await fetch("/api/current-user", { cache: "no-store" });
    if (!response.ok) return window.location.href = "/login";
    const data = await response.json();
    // The name in the top bar and the menu items per role are filled in by the shared
    // top bar and sidebar (topbar.js, sidebar.js), as on the other pages.
    if (data.user && data.user.role === "admin") {
        loadSetupReminder().catch(() => {});
        loadBackupPanel().catch(() => {});
    }
}

// Automatic daily backups: when the last one was made, plus Back up now / Download.
async function loadBackupPanel() {
    const response = await fetch("/api/backups", { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const panel = document.getElementById("backupPanel");
    const status = document.getElementById("backupStatus");
    const when = value => new Date(value).toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
    const sizeText = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    status.textContent = data.latest
        ? `Last backup: ${when(data.latest.created_at)} (${sizeText(data.latest.size)}). A new copy is saved automatically every day; the last ${data.keep} are kept in database\\backups${data.second_copy_folder ? ` and copied to ${data.second_copy_folder}` : ""}.`
        : "No backup yet. The first one is made a few seconds after the system starts, then once a day.";
    if (data.last_error) status.textContent += ` Problem with the last backup: ${data.last_error}`;
    status.className = `small mb-0 ${data.last_error ? "text-danger" : "text-muted"}`;
    document.getElementById("backupDownload").hidden = !data.latest;
    panel.classList.remove("d-none");
}
document.getElementById("backupNow")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const response = await fetch("/api/backups/now", { method: "POST" });
        const result = await response.json();
        alert(result.message || (response.ok ? "Backup saved." : "The backup could not be made."));
        await loadBackupPanel();
    } catch { alert("The backup could not be made. Check that the system is running."); }
    finally { button.disabled = false; }
});

const escapeSetup = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);

// One-time setup the admin still has to finish (default passwords, email, station location).
async function loadSetupReminder() {
    const response = await fetch("/api/setup-status", { cache: "no-store" });
    if (!response.ok) return;
    const status = await response.json();
    const steps = [];
    const weak = status.default_passwords || [];
    if (weak.length) steps.push(`<strong>${weak.map(name => escapeSetup(name)).join(", ")} still ${weak.length === 1 ? "uses" : "use"} an easy default password</strong> such as admin123. Change it in <a href="/users">Manage Accounts</a> before the system is put online.`);
    if (!status.email) steps.push("<strong>Email is not set up</strong>, so activation links, password resets, and order emails are not sent. Fill in the Gmail lines in the <code>.env</code> file, restart the system, and run <code>npm run email:test</code>.");
    if (!status.station_location) steps.push("<strong>The station's location is not saved</strong>, so delivery routes start from the first stop. Save it in <a href=\"/delivery\">Delivery → Delivery settings</a>.");
    const box = document.getElementById("setupReminder");
    if (!steps.length) { box.classList.add("d-none"); return; }
    box.innerHTML = `<h2 class="h6 mb-2">Finish setting up the system</h2><ul class="mb-0">${steps.map(step => `<li>${step}</li>`).join("")}</ul>`;
    box.classList.remove("d-none");
}

async function loadDashboard() {
    try {
        const response = await fetch("/api/dashboard", { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "Unable to load dashboard.");
        document.getElementById("totalInventory").textContent = Number(data.summary.total_inventory || 0);
        document.getElementById("lowStock").textContent = Number(data.summary.low_stock_count || 0);
        document.getElementById("activeProducts").textContent = Number(data.summary.active_products || 0);
        document.getElementById("pendingOrders").textContent = Number(data.summary.pending_orders || 0);

        // Status from the live numbers (not a saved flag): 0 = out of stock,
        // at or below the minimum = low stock (red), otherwise available.
        const levels = data.inventory_levels || [];
        const stockState = item => {
            const quantity = Number(item.quantity || 0), minimum = Number(item.minimum_stock || 0);
            if (quantity <= 0) return ["Out of stock", "text-bg-danger", true];
            if (quantity <= minimum) return ["Low stock", "text-bg-danger", true];
            return ["Available", "text-bg-success", false];
        };
        const inventory = document.getElementById("inventoryLevels");
        inventory.innerHTML = levels.length ? levels.map(item => {
            const [label, badge, low] = stockState(item);
            return `<tr class="${low ? "stock-low-row" : ""}">
                <td>${escapeHTML(item.product_name)}</td>
                <td>${escapeHTML(item.unit)}</td>
                <td class="${low ? "text-danger fw-bold" : ""}">${Number(item.quantity || 0)}</td>
                <td>${Number(item.minimum_stock || 0)}</td>
                <td><span class="badge ${badge}">${low ? '<i class="bi bi-exclamation-triangle-fill" aria-hidden="true"></i> ' : ""}${label}</span></td>
            </tr>`;
        }).join("") : '<tr><td colspan="5" class="text-center text-muted">No inventory records found.</td></tr>';
        const lowCount = levels.filter(item => stockState(item)[2]).length;
        const lowSummary = document.getElementById("inventoryLowSummary");
        // Shown only when something needs restocking.
        lowSummary.textContent = lowCount ? `${lowCount} ${lowCount === 1 ? "product needs" : "products need"} restocking` : "";
        lowSummary.className = "small fw-semibold text-danger";
        document.getElementById("dashboardMessage").classList.add("d-none");
        loadDashboardMetrics();
    } catch (error) {
        console.error(error);
        const message = document.getElementById("dashboardMessage");
        message.textContent = error.message;
        message.classList.remove("d-none");
    }
}

// Month picked on the chart's calendar ("2026-09"), or "" for the last 30 days.
let chartMonth = "";
let lastTrendKey = "";
const pesoText = value => `₱${Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function chartPeriodLabel() {
    if (!chartMonth) return "Last 30 days";
    return new Date(`${chartMonth}-01T00:00:00+08:00`).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "Asia/Manila" });
}

async function loadDashboardMetrics() {
    try {
        const response = await fetch("/api/dashboard/metrics" + (chartMonth ? `?month=${encodeURIComponent(chartMonth)}` : ""), { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.message || "Unable to load metrics.");
        const requested = chartMonth || "last30";
        if (data.period !== requested) return; // the calendar changed while this was loading
        document.getElementById("salesTotal").textContent = pesoText(data.sales_30_days);
        document.getElementById("salesVelocity").textContent = Number(data.sales_velocity || 0);
        const periodTotal = (data.trend || []).reduce((total, point) => total + Number(point.sales || 0), 0);
        document.getElementById("chartPeriod").textContent = chartPeriodLabel();
        document.getElementById("chartTotal").textContent = pesoText(periodTotal);
        recentTransactions = Array.isArray(data.recent_transactions) ? data.recent_transactions : [];
        // Redraw only when the numbers change, so the refresh does not interrupt someone reading the chart.
        const trendKey = requested + JSON.stringify(data.trend || []);
        if (trendKey !== lastTrendKey) {
            lastTrendKey = trendKey;
            renderValueTrend(data.trend || []);
        }
        renderRecentTransactions();
        const updated = document.getElementById("dashboardUpdated");
        if (updated) updated.innerHTML = `<span class="live-dot" aria-hidden="true"></span> Updated ${new Date().toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" })}`;
    } catch (error) {
        console.error("Unable to load dashboard metrics.", error);
        document.getElementById("valueTrend").textContent = "Unable to load the chart. It will retry on the next refresh.";
    }
}

// Calendar: a pop-up with a year and its 12 months (looks the same in every
// browser and on phones). Picking a month shows its daily sales; "Last 30 days"
// goes back to the default. Months after the current one cannot be picked.
(() => {
    const button = document.getElementById("chartMonthButton");
    const popup = document.getElementById("chartMonthPopup");
    const grid = document.getElementById("chartMonthGrid");
    const yearText = document.getElementById("chartYear");
    const prev = document.getElementById("chartYearPrev");
    const next = document.getElementById("chartYearNext");
    const last30 = document.getElementById("chartLast30");
    if (!button || !popup) return;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
    const thisYear = Number(today.slice(0, 4)), thisMonth = today.slice(0, 7);
    const FIRST_YEAR = 2020;
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let year = thisYear;

    function drawMonths() {
        yearText.textContent = year;
        prev.disabled = year <= FIRST_YEAR;
        next.disabled = year >= thisYear;
        grid.replaceChildren(...names.map((name, index) => {
            const value = `${year}-${String(index + 1).padStart(2, "0")}`;
            const item = document.createElement("button");
            item.type = "button";
            item.textContent = name;
            item.dataset.month = value;
            item.disabled = value > thisMonth;
            item.setAttribute("aria-current", String(value === chartMonth));
            item.setAttribute("aria-label", new Date(`${value}-01T00:00:00+08:00`).toLocaleDateString("en-PH", { month: "long", year: "numeric", timeZone: "Asia/Manila" }));
            item.addEventListener("click", () => { choose(value); close(true); });
            return item;
        }));
    }
    function open() {
        year = chartMonth ? Number(chartMonth.slice(0, 4)) : thisYear;
        drawMonths();
        popup.hidden = false;
        button.setAttribute("aria-expanded", "true");
        (grid.querySelector('[aria-current="true"]') || grid.querySelector("button:not(:disabled):last-of-type") || grid.querySelector("button:not(:disabled)"))?.focus();
    }
    function close(returnFocus) {
        popup.hidden = true;
        button.setAttribute("aria-expanded", "false");
        if (returnFocus) button.focus();
    }
    function choose(month) {
        chartMonth = month;
        document.getElementById("chartMonthText").textContent = month ? chartPeriodLabel() : "Choose month";
        last30.classList.toggle("active", !month);
        last30.setAttribute("aria-pressed", String(!month));
        document.getElementById("chartPeriod").textContent = chartPeriodLabel();
        chartActiveIndex = null;
        chartView = null; // a new period starts at its latest days
        lastTrendKey = "";
        document.getElementById("chartTooltip").hidden = true;
        document.getElementById("valueTrend").textContent = "Loading chart...";
        loadDashboardMetrics();
    }
    button.addEventListener("click", () => (popup.hidden ? open() : close(false)));
    prev.addEventListener("click", () => { year = Math.max(FIRST_YEAR, year - 1); drawMonths(); });
    next.addEventListener("click", () => { year = Math.min(thisYear, year + 1); drawMonths(); });
    popup.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); close(true); } });
    document.addEventListener("click", event => { if (!popup.hidden && !event.target.closest(".month-picker")) close(false); });
    last30.addEventListener("click", () => choose(""));
    last30.classList.add("active");
    last30.setAttribute("aria-pressed", "true");
})();

// ---------- Daily sales graph: zoom, drag to move, and a draw-in animation ----------
// The graph shows a window of days (14 at first). Drag the graph, or the window in
// the overview strip, to move it; the zoom buttons show fewer or more days.
let chartTrend = [];
let chartView = null;          // { start, end } indices of the visible days
const CHART_DEFAULT_DAYS = 14;
const CHART_MIN_DAYS = 5;
const dayLabel = (day, options) => new Date(`${day}T00:00:00+08:00`).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", ...options });

// Smooth line through the points that never swings above or below its neighbours
// (monotone curve), so a day with ₱0 is never drawn below zero.
function smoothPath(points) {
    if (points.length < 3) return points.map(([px, py], i) => `${i ? "L" : "M"}${px},${py}`).join(" ");
    const n = points.length, slopes = [], tangents = [];
    for (let i = 0; i < n - 1; i++) slopes.push((points[i + 1][1] - points[i][1]) / (points[i + 1][0] - points[i][0]));
    tangents.push(slopes[0]);
    for (let i = 1; i < n - 1; i++) tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
    tangents.push(slopes[n - 2]);
    for (let i = 0; i < n - 1; i++) {
        if (slopes[i] === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
        const a = tangents[i] / slopes[i], b = tangents[i + 1] / slopes[i], h = a * a + b * b;
        if (h > 9) { const t = 3 / Math.sqrt(h); tangents[i] = t * a * slopes[i]; tangents[i + 1] = t * b * slopes[i]; }
    }
    let d = `M${points[0][0]},${points[0][1]}`;
    for (let i = 0; i < n - 1; i++) {
        const [x0, y0] = points[i], [x1, y1] = points[i + 1], dx = (x1 - x0) / 3;
        d += ` C${x0 + dx},${y0 + tangents[i] * dx} ${x1 - dx},${y1 - tangents[i + 1] * dx} ${x1},${y1}`;
    }
    return d;
}

function renderValueTrend(trend) {
    const container = document.getElementById("valueTrend");
    chartTrend = trend;
    if (!trend.length) { container.textContent = "No trend data available yet."; document.getElementById("chartOverview").replaceChildren(); return; }
    // New data for the same period keeps the window where the person moved it.
    const last = trend.length - 1;
    if (!chartView || chartView.end > last) {
        // Phones start with a week, so the dates stay readable.
        const days = Math.min(trend.length, window.matchMedia("(max-width: 600px)").matches ? 7 : CHART_DEFAULT_DAYS);
        chartView = { start: last - days + 1, end: last };
    }
    drawChart({ animate: true });
}

// Draws the visible window. `animate` makes the line draw itself in.
function drawChart({ animate = false } = {}) {
    const trend = chartTrend, container = document.getElementById("valueTrend");
    const { start, end } = chartView;
    // Drawn at the box's real width, so the text stays the same size on phones.
    const width = Math.max(300, Math.round((container.clientWidth || 960) - 8));
    const narrow = width < 600;
    const height = Math.round(Math.min(460, Math.max(240, width * 0.48)));
    const left = narrow ? 58 : 95, right = narrow ? 14 : 30, top = 30, bottom = narrow ? 48 : 60;
    const plotWidth = width - left - right, plotHeight = height - top - bottom;
    const visible = trend.slice(start, end + 1);
    // The scale follows the visible days, so zooming in shows small days clearly.
    const maximum = Math.max(1, ...visible.map(point => Number(point.sales || 0)));
    const roughStep = maximum / 5;
    const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const step = [1, 2, 2.5, 5, 10].find(multiplier => multiplier * magnitude >= roughStep) * magnitude;
    const ceiling = step * 5;
    const span = Math.max(1, end - start);
    const x = index => left + (index - start) * plotWidth / span;
    const y = value => top + plotHeight * (1 - Number(value) / ceiling);
    const money = value => `₱${Number(value).toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;
    const color = "#0b7ec7";
    let markup = `<svg viewBox="0 0 ${width} ${height}" class="sales-chart${animate ? " is-new" : ""}" tabindex="0" role="img" aria-labelledby="trendTitle trendDescription">
        <title id="trendTitle">Daily sales, ${escapeHTML(chartPeriodLabel())}</title>
        <desc id="trendDescription">Curved line: total of completed orders for each day, in Philippine pesos. Drag to move through the days. Use the left and right arrow keys to read each day.</desc>
        <defs>
            <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${color}" stop-opacity="0.35"/><stop offset="100%" stop-color="${color}" stop-opacity="0.02"/></linearGradient>
            <clipPath id="plotClip"><rect x="${left}" y="${top - 10}" width="${plotWidth}" height="${plotHeight + 20}"/></clipPath>
        </defs>
        <text x="${left}" y="18" font-size="12" fill="#526170">Sales (₱)</text>`;
    for (let tick = 0; tick <= 5; tick++) {
        const value = ceiling * tick / 5;
        markup += `<line x1="${left}" x2="${width - right}" y1="${y(value)}" y2="${y(value)}" stroke="${tick ? "#e6ebf0" : "#9ca8b3"}"/>`;
        markup += `<text x="${left - 10}" y="${y(value) + 4}" text-anchor="end" font-size="12" fill="#526170">${money(value)}</text>`;
    }
    // Date labels: about one per 60 pixels, so they never overlap.
    const every = Math.max(1, Math.ceil((span + 1) / Math.max(1, Math.floor(plotWidth / 60))));
    for (let index = start; index <= end; index++) {
        if ((index - start) % every && index !== end) continue;
        markup += `<line x1="${x(index)}" x2="${x(index)}" y1="${top}" y2="${height - bottom}" stroke="#f0f3f6"/>`;
        // The first and last labels lean inward so they are not cut off at the edges.
        const anchor = index === start ? "start" : index === end ? "end" : "middle";
        markup += `<text x="${x(index)}" y="${height - bottom + 20}" text-anchor="${anchor}" font-size="12" fill="#526170">${escapeHTML(dayLabel(trend[index].day, { month: "short", day: "numeric" }))}</text>`;
    }
    // One day either side of the window is drawn too, so the line continues to the edges.
    const from = Math.max(0, start - 1), to = Math.min(trend.length - 1, end + 1);
    const points = [];
    for (let index = from; index <= to; index++) points.push([x(index), y(trend[index].sales || 0)]);
    const line = smoothPath(points);
    markup += `<g clip-path="url(#plotClip)">
        <path class="sales-area" d="${line} L${points.at(-1)[0]},${y(0)} L${points[0][0]},${y(0)} Z" fill="url(#salesFill)" pointer-events="none"/>
        <path class="sales-line" pathLength="1" d="${line}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" pointer-events="none"/>`;
    for (let index = start; index <= end; index++) {
        const sales = Number(trend[index].sales || 0);
        markup += `<circle class="sales-point" cx="${x(index)}" cy="${y(sales)}" r="${sales > 0 ? 4.5 : 3}" fill="${sales > 0 ? color : "#fff"}" stroke="${color}" stroke-width="2" pointer-events="none" style="animation-delay:${animate ? (index - start) / span * 0.9 : 0}s"/>`;
    }
    markup += `</g>
        <g id="chartHover" visibility="hidden" pointer-events="none"><line id="chartGuide" y1="${top}" y2="${height - bottom}" stroke="#0b7ec7" stroke-width="1.5" stroke-dasharray="4 4"/><circle id="chartDot" r="8" fill="${color}" stroke="#fff" stroke-width="3"/></g>
        <rect id="chartHit" x="${left - 10}" y="${top}" width="${plotWidth + 20}" height="${plotHeight}" fill="transparent"/>
        </svg>`;
    container.innerHTML = markup;

    document.getElementById("chartRange").textContent = `Showing ${dayLabel(trend[start].day, { month: "short", day: "numeric" })} – ${dayLabel(trend[end].day, { month: "short", day: "numeric", year: "numeric" })} (${end - start + 1} of ${trend.length} days)`;
    document.getElementById("chartZoomIn").disabled = end - start + 1 <= CHART_MIN_DAYS;
    document.getElementById("chartZoomOut").disabled = document.getElementById("chartShowAll").disabled = start === 0 && end === trend.length - 1;
    drawOverview();
    attachChartInteraction(container, trend, { x, y, left, plotWidth, start, end });
}

// Moves or resizes the window, kept inside the period. Redraws without animation.
function setChartView(start, end) {
    // Whole days only: the overview strip passes in-between positions (e.g. 9.4 to 22.4),
    // and their difference can come out as 13.999…, which left the window on a day that
    // does not exist, so nothing was redrawn while dragging the strip.
    const last = chartTrend.length - 1, days = Math.min(chartTrend.length, Math.max(CHART_MIN_DAYS, Math.round(end - start + 1)));
    start = Math.round(Math.max(0, Math.min(last - days + 1, start)));
    if (start === chartView.start && start + days - 1 === chartView.end) return;
    chartView = { start, end: start + days - 1 };
    drawChart();
}

// Overview strip: the whole period as a small line, with a window you can drag.
function drawOverview() {
    const box = document.getElementById("chartOverview");
    const trend = chartTrend, n = trend.length;
    const maximum = Math.max(1, ...trend.map(point => Number(point.sales || 0)));
    const w = 960, h = 56;
    const ox = index => 8 + index * (w - 16) / Math.max(1, n - 1);
    const oy = value => h - 6 - (h - 14) * Number(value) / maximum;
    const line = smoothPath(trend.map((point, index) => [ox(index), oy(point.sales || 0)]));
    const x0 = ox(chartView.start) - 4, x1 = ox(chartView.end) + 4;
    box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        <path d="${line} L${ox(n - 1)},${h} L${ox(0)},${h} Z" fill="rgba(11,126,199,.12)"/>
        <path d="${line}" fill="none" stroke="#0b7ec7" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
        <rect class="overview-window" x="${x0}" y="1" width="${x1 - x0}" height="${h - 2}" rx="6"/>
        </svg>`;
    if (!drawOverview.ready) {
        drawOverview.ready = true;
        // Drag the window (or click the strip) to move the visible days.
        let dragging = false, grab = 0;
        const indexAt = event => { const r = box.getBoundingClientRect(); return (event.clientX - r.left) / r.width * (chartTrend.length - 1); };
        box.addEventListener("pointerdown", event => {
            const at = indexAt(event), days = chartView.end - chartView.start;
            grab = at >= chartView.start && at <= chartView.end ? at - chartView.start : days / 2;
            dragging = true;
            box.setPointerCapture(event.pointerId);
            setChartView(at - grab, at - grab + days);
        });
        box.addEventListener("pointermove", event => { if (dragging) { const at = indexAt(event); setChartView(at - grab, at - grab + chartView.end - chartView.start); } });
        box.addEventListener("pointerup", () => { dragging = false; });
        box.addEventListener("pointercancel", () => { dragging = false; });
    }
}

// Redraw at the new width when the window is resized or a phone is turned.
let chartResizeTimer = null;
window.addEventListener("resize", () => {
    clearTimeout(chartResizeTimer);
    chartResizeTimer = setTimeout(() => { if (chartTrend.length && chartView) drawChart(); }, 150);
});

// Zoom buttons: fewer or more days around the middle of the window.
(() => {
    const zoom = factor => {
        if (!chartTrend.length) return;
        const middle = (chartView.start + chartView.end) / 2;
        const days = Math.round((chartView.end - chartView.start + 1) * factor);
        setChartView(middle - days / 2 + 0.5, middle + days / 2 - 0.5);
    };
    document.getElementById("chartZoomIn")?.addEventListener("click", () => zoom(0.6));
    document.getElementById("chartZoomOut")?.addEventListener("click", () => zoom(1.6));
    document.getElementById("chartShowAll")?.addEventListener("click", () => { if (chartTrend.length) setChartView(0, chartTrend.length - 1); });
})();

// Index of the highlighted day (kept across the 5-second refresh), or null.
let chartActiveIndex = null;

// Makes the whole chart respond: drag to move through the days; point, tap, or
// use the arrow keys to highlight a day with its date and sales.
function attachChartInteraction(container, trend, { x, y, left, plotWidth, start, end }) {
    const svg = container.querySelector("svg");
    const frame = container.parentElement;
    const tooltip = document.getElementById("chartTooltip");
    const detail = document.getElementById("trendDetail");
    const hover = svg.querySelector("#chartHover");
    const guide = svg.querySelector("#chartGuide");
    const dot = svg.querySelector("#chartDot");
    const step = plotWidth / Math.max(1, end - start);

    function show(index) {
        index = Math.max(start, Math.min(end, index));
        chartActiveIndex = index;
        const point = trend[index];
        const sales = Number(point.sales || 0);
        const cx = x(index), cy = y(sales);
        guide.setAttribute("x1", cx);
        guide.setAttribute("x2", cx);
        dot.setAttribute("cx", cx);
        dot.setAttribute("cy", cy);
        hover.setAttribute("visibility", "visible");
        const day = new Date(`${point.day}T00:00:00+08:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila" });
        const orders = Number(point.orders || 0);
        const ordersText = `${orders} completed ${orders === 1 ? "order" : "orders"}`;
        tooltip.innerHTML = `<span>${escapeHTML(day)}</span><strong>${escapeHTML(pesoText(sales))}</strong><span>${escapeHTML(ordersText)}</span>`;
        detail.textContent = `${day}: ${pesoText(sales)} from ${ordersText}.`;
        // Place the box above the dot, kept inside the chart's edges.
        const matrix = svg.getScreenCTM();
        if (!matrix) return;
        const spot = new DOMPoint(cx, cy).matrixTransform(matrix);
        const box = frame.getBoundingClientRect();
        tooltip.hidden = false;
        const half = tooltip.offsetWidth / 2;
        tooltip.style.left = `${Math.max(half + 4, Math.min(box.width - half - 4, spot.x - box.left))}px`;
        tooltip.style.top = `${Math.max(tooltip.offsetHeight + 16, spot.y - box.top)}px`;
    }
    function hide() {
        chartActiveIndex = null;
        hover.setAttribute("visibility", "hidden");
        tooltip.hidden = true;
    }
    function nearest(event) {
        const matrix = svg.getScreenCTM();
        if (!matrix) return 0;
        const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
        return start + Math.round((local.x - left) / step);
    }
    // Days per screen pixel, for dragging.
    const daysPerPixel = () => { const matrix = svg.getScreenCTM(); return matrix ? 1 / (step * matrix.a) : 0; };

    // Drag: the window follows the pointer. A press without moving is a tap.
    let drag = null;
    svg.addEventListener("pointerdown", event => {
        drag = { x: event.clientX, start: chartView.start, moved: false, id: event.pointerId };
        show(nearest(event));
    });
    svg.addEventListener("pointermove", event => {
        // The mouse button was let go outside the graph.
        if (drag && event.pointerType === "mouse" && !event.buttons) endDrag();
        if (drag && event.pointerId === drag.id && (event.buttons || event.pointerType !== "mouse")) {
            const dx = event.clientX - drag.x;
            if (!drag.moved && Math.abs(dx) > 5) { drag.moved = true; svg.setPointerCapture(event.pointerId); svg.classList.add("is-dragging"); hide(); }
            if (drag.moved) {
                const days = chartView.end - chartView.start;
                const newStart = drag.start - dx * daysPerPixel();
                // The redraw replaces the graph; the drag continues on the new one.
                attachChartInteraction.continueDrag = drag;
                setChartView(newStart, newStart + days);
                if (container.querySelector("svg") === svg) attachChartInteraction.continueDrag = null;
                return;
            }
        }
        if (!drag) show(nearest(event));
    });
    const endDrag = () => { drag = null; attachChartInteraction.continueDrag = null; svg.classList.remove("is-dragging"); };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);
    // A drag that started on the previous drawing continues here.
    if (attachChartInteraction.continueDrag) { drag = attachChartInteraction.continueDrag; attachChartInteraction.continueDrag = null; svg.classList.add("is-dragging"); }
    svg.addEventListener("pointerleave", event => { if (event.pointerType === "mouse" && !drag && document.activeElement !== svg) hide(); });
    svg.addEventListener("focus", () => show(chartActiveIndex ?? end));
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", event => {
        const current = chartActiveIndex ?? end;
        const moves = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: trend.length - 1 };
        if (event.key in moves) {
            event.preventDefault();
            const target = Math.max(0, Math.min(trend.length - 1, moves[event.key]));
            // Moving past the edge of the window slides the window along.
            if (target < chartView.start || target > chartView.end) {
                const days = chartView.end - chartView.start;
                chartActiveIndex = target;
                setChartView(target < chartView.start ? target : target - days, target < chartView.start ? target + days : target);
                container.querySelector("svg")?.focus();
                return;
            }
            show(target);
        }
        if (event.key === "Escape") hide();
    });
    // Tapping outside the chart on a phone hides the value box.
    if (!attachChartInteraction.outsideListener) {
        attachChartInteraction.outsideListener = true;
        document.addEventListener("pointerdown", event => {
            if (!event.target.closest(".chart-frame")) {
                document.getElementById("chartHover")?.setAttribute("visibility", "hidden");
                document.getElementById("chartTooltip").hidden = true;
                chartActiveIndex = null;
            }
        });
    }
    // Keep the same day highlighted after the automatic refresh redraws the chart.
    if (!drag && chartActiveIndex !== null && chartActiveIndex >= start && chartActiveIndex <= end) show(chartActiveIndex);
    else if (!drag) tooltip.hidden = true;
}

// "just now", "5 min ago", "3 hr ago"; older entries show only the date and time.
function timeAgo(value) {
    const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : String(value).replace(" ", "T") + "Z");
    const minutes = Math.floor((Date.now() - date.getTime()) / 60000);
    if (Number.isNaN(minutes) || minutes >= 24 * 60) return "";
    if (minutes < 1) return "just now";
    return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} hr ago`;
}
// Entries already shown, so new ones can be highlighted when they arrive.
let seenTransactions = null;
const transactionKey = item => `${item.created_at}|${item.product_name}|${item.movement_type}|${item.quantity}|${item.reason}`;

function renderRecentTransactions() {
    const body = document.getElementById("recentTransactions");
    const totalPages = Math.ceil(recentTransactions.length / recentTransactionsPageSize);
    currentRecentTransactionsPage = totalPages ? Math.min(currentRecentTransactionsPage, totalPages) : 1;
    const startIndex = (currentRecentTransactionsPage - 1) * recentTransactionsPageSize;
    const pageTransactions = recentTransactions.slice(startIndex, startIndex + recentTransactionsPageSize);
    const firstLoad = seenTransactions === null;
    const seen = seenTransactions || new Set();

    body.innerHTML = pageTransactions.length
        ? pageTransactions.map(item => {
            const ago = timeAgo(item.created_at);
            const isNew = !firstLoad && !seen.has(transactionKey(item));
            const stockIn = item.movement_type === "stock_in";
            return `<tr class="${isNew ? "transaction-new" : ""}">
                <td>${escapeHTML(formatPhilippineTime(item.created_at))}${ago ? `<small class="d-block text-muted">${escapeHTML(ago)}</small>` : ""}</td>
                <td>${escapeHTML(item.product_name)}</td>
                <td><span class="badge ${stockIn ? "text-bg-success" : "text-bg-danger"}">${stockIn ? "Stock In" : "Out of Stock"}</span></td>
                <td class="${stockIn ? "text-success" : "text-danger"} fw-semibold">${stockIn ? "+" : "−"}${Number(item.quantity || 0).toLocaleString("en-PH")}</td>
                <td>${escapeHTML(item.reason || "-")}</td></tr>`;
        }).join("")
        : '<tr><td colspan="5" class="text-center text-muted">No inventory transactions yet.</td></tr>';
    seenTransactions = new Set(recentTransactions.map(transactionKey));
    const updated = document.getElementById("transactionsUpdated");
    if (updated) updated.innerHTML = `<span class="live-dot" aria-hidden="true"></span> Live · updated ${new Date().toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" })}`;

    renderRecentTransactionsPagination(recentTransactions.length);
}

function renderRecentTransactionsPagination(totalItems) {
    const pagination = document.getElementById("recentTransactionsPagination");
    if (!pagination) return;

    const totalPages = Math.ceil(totalItems / recentTransactionsPageSize);
    if (totalPages <= 1) {
        pagination.innerHTML = "";
        return;
    }

    let controls = `<button type="button" class="movement-page-button" ${currentRecentTransactionsPage === 1 ? "disabled" : ""} onclick="changeRecentTransactionsPage(${currentRecentTransactionsPage - 1})" aria-label="Previous page">&lsaquo;</button>`;
    for (let page = 1; page <= totalPages; page += 1) {
        controls += `<button type="button" class="movement-page-button ${page === currentRecentTransactionsPage ? "active" : ""}" onclick="changeRecentTransactionsPage(${page})" aria-label="Page ${page}" ${page === currentRecentTransactionsPage ? "aria-current=\"page\"" : ""}>${page}</button>`;
    }
    controls += `<button type="button" class="movement-page-button" ${currentRecentTransactionsPage === totalPages ? "disabled" : ""} onclick="changeRecentTransactionsPage(${currentRecentTransactionsPage + 1})" aria-label="Next page">&rsaquo;</button>`;
    pagination.innerHTML = controls;
}

function changeRecentTransactionsPage(page) {
    const totalPages = Math.max(1, Math.ceil(recentTransactions.length / recentTransactionsPageSize));
    currentRecentTransactionsPage = Math.max(1, Math.min(page, totalPages));
    renderRecentTransactions();
}

loadCurrentUser();
loadDashboard();
setInterval(loadDashboard, 5000);
