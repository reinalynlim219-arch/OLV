// Activity Log page (admin): readable list of who did what, with search, filters,
// and pages of 50.
(() => {
    const $ = id => document.getElementById(id);
    const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
    const when = value => {
        const date = new Date(String(value).replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? "" : "Z"));
        return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
    };
    const ROLE = { admin: "Admin", staff: "Staff", driver: "Driver", customer: "Customer" };
    let page = 1, total = 0, pageSize = 50, timer = null;

    async function load() {
        const params = new URLSearchParams({ page, q: $("activitySearch").value.trim(), role: $("activityRole").value, period: $("activityPeriod").value });
        try {
            const response = await fetch("/api/activity-logs?" + params, { cache: "no-store" });
            if (response.status === 401) { window.location.href = "/login"; return; }
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Unable to load the activity log.");
            total = data.total; pageSize = data.page_size;
            $("activityRows").innerHTML = data.entries.length ? data.entries.map(entry => `<tr>
                    <td class="text-nowrap">${escapeHTML(when(entry.created_at))}</td>
                    <td><strong>${escapeHTML(entry.actor_name)}</strong></td>
                    <td>${escapeHTML(ROLE[entry.actor_role] || entry.actor_role || "—")}</td>
                    <td>${escapeHTML(entry.action)}</td>
                    <td class="small text-muted">${escapeHTML(entry.details || "—")}</td>
                </tr>`).join("")
                : '<tr><td colspan="5" class="text-center text-muted py-4">No activity matches these filters.</td></tr>';
            const pages = Math.max(1, Math.ceil(total / pageSize));
            $("activityCount").textContent = `${total.toLocaleString("en-PH")} ${total === 1 ? "entry" : "entries"}`;
            $("activityPage").textContent = `Page ${page} of ${pages}`;
            $("activityPrev").disabled = page <= 1;
            $("activityNext").disabled = page >= pages;
        } catch (error) {
            $("activityRows").innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">${escapeHTML(error.message)}</td></tr>`;
        }
    }
    const restart = () => { page = 1; load(); };
    $("activitySearch").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(restart, 300); });
    $("activityRole").addEventListener("change", restart);
    $("activityPeriod").addEventListener("change", restart);
    $("activityPrev").addEventListener("click", () => { page = Math.max(1, page - 1); load(); });
    $("activityNext").addEventListener("click", () => { page += 1; load(); });
    load();
})();
