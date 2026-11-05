// Shared delivery tracking window used by the staff delivery page, the driver page
// and the customer portal. Call showDeliveryTracking(deliveryId).
// It shows the status steps and the history. While open, it refreshes by itself
// every 10 seconds.
(function () {
    const steps = [
        ["scheduled", "Scheduled"],
        ["out_for_delivery", "Out for delivery"],
        ["awaiting_customer", "Dropped off"],
        ["delivered", "Received"]
    ];
    const labels = {
        scheduled: "Delivery scheduled",
        out_for_delivery: "Out for delivery",
        awaiting_customer: "Dropped off, waiting for customer confirmation",
        delivered: "Received by customer",
        cancelled: "Delivery cancelled",
        rescheduled: "Schedule updated"
    };
    const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
    // SQLite stores CURRENT_TIMESTAMP in UTC without a zone marker.
    const formatTime = value => {
        if (!value) return "";
        const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : String(value).replace(" ", "T") + "Z");
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Manila" });
    };

    // "2026-09-30" → "Sep 30, 2026" (a calendar day, so no time zone shift).
    const formatDay = value => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return value || "-";
        return new Date(`${value}T00:00:00+08:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric", timeZone: "Asia/Manila" });
    };

    const style = document.createElement("style");
    style.textContent = `
        #deliveryTrackingDialog{width:min(640px,calc(100% - 24px));max-height:92vh;overflow:auto;border:1px solid #cbd9e8;border-radius:16px;padding:22px}
        #deliveryTrackingDialog::backdrop{background:rgba(15,23,42,.45)}
        .track-steps{display:flex;gap:4px;margin:18px 0;list-style:none;padding:0}
        .track-steps li{flex:1;text-align:center;font-size:12px;color:#64748b;position:relative;padding-top:30px}
        .track-steps li::before{content:"";position:absolute;top:0;left:50%;transform:translateX(-50%);width:22px;height:22px;border-radius:50%;border:2px solid #cbd5e1;background:#fff;z-index:1}
        .track-steps li:not(:first-child)::after{content:"";position:absolute;top:10px;right:50%;width:100%;height:3px;background:#cbd5e1}
        .track-steps li.done:not(:first-child)::after{background:#198754}
        .track-steps.cancelled li.done:not(:first-child)::after{background:#adb5bd}
        .track-steps li.done{color:#0f5132;font-weight:600}
        .track-steps li.done::before{background:#198754;border-color:#198754}
        .track-steps li.current::before{box-shadow:0 0 0 4px rgba(25,135,84,.25)}
        .track-steps.cancelled li.done::before{background:#adb5bd;border-color:#adb5bd}
        .track-log{list-style:none;padding:0;margin:0;border-left:2px solid #dbe4ee}
        .track-log li{position:relative;padding:0 0 14px 18px}
        .track-log li::before{content:"";position:absolute;left:-6px;top:4px;width:10px;height:10px;border-radius:50%;background:#0d6efd}
        .track-log time{display:block;font-size:12px;color:#64748b}
        .track-log small{display:block;color:#475569}
        .track-summary{font-size:14px;color:#334155;background:#f1f5f9;border-radius:10px;padding:10px 12px}
        .track-section{margin-top:18px}
        html[data-theme="dark"] .track-summary{background:#1e293b;color:#cbd5e1}`;
    document.head.appendChild(style);

    const dialog = document.createElement("dialog");
    dialog.id = "deliveryTrackingDialog";
    dialog.setAttribute("aria-labelledby", "deliveryTrackingTitle");
    dialog.innerHTML = `<h2 id="deliveryTrackingTitle" class="h5 mb-2">Delivery tracking</h2>
        <p id="deliveryTrackingMessage" role="status" class="mb-0"></p>
        <div id="deliveryTrackingBody" hidden>
            <div id="trackSummary"></div>
            <ol id="trackSteps" class="track-steps"></ol>
            <section class="track-section">
                <h3 class="h6">History</h3>
                <ul id="trackLog" class="track-log"></ul>
            </section>
        </div>
        <div class="text-end mt-3"><button type="button" class="btn btn-secondary" id="closeDeliveryTracking">Close</button></div>`;
    document.body.appendChild(dialog);

    let current = null;    // delivery id shown
    let timer = null;
    const $ = id => dialog.querySelector("#" + id);

    function stop() {
        clearInterval(timer);
        timer = null;
        current = null;
    }
    $("closeDeliveryTracking").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", stop);

    function renderTracking({ delivery, events }) {
        const cancelled = delivery.status === "cancelled";
        // For cancelled deliveries, show how far it got before cancelling.
        const reached = cancelled
            ? Math.max(0, ...events.map(event => steps.findIndex(([status]) => status === event.status)))
            : steps.findIndex(([status]) => status === delivery.status);
        $("trackSteps").className = `track-steps ${cancelled ? "cancelled" : ""}`;
        $("trackSteps").innerHTML = steps.map(([, label], index) => `<li class="${index <= reached ? "done" : ""} ${index === reached && !cancelled ? "current" : ""}">${escapeHTML(label)}</li>`).join("");
        $("trackSummary").innerHTML = `<div class="track-summary">
                <strong>${escapeHTML(delivery.customer_name || "")}</strong><br>
                ${escapeHTML(delivery.delivery_items || "")}<br>
                Scheduled: ${escapeHTML(formatDay(delivery.delivery_date))}${delivery.delivery_time ? ` at ${escapeHTML(delivery.delivery_time)}` : ""} ·
                Driver: ${escapeHTML(delivery.assigned_staff || "Not yet assigned")}<br>
                ${escapeHTML(delivery.delivery_address || "")}
            </div>
            ${cancelled ? '<div class="alert alert-danger py-2 mt-3 mb-0">This delivery was cancelled.</div>' : ""}`;
        $("trackLog").innerHTML = events.slice().reverse().map(event => `<li><strong>${escapeHTML(labels[event.status] || event.status)}</strong>
            ${event.note ? `<small>${escapeHTML(String(event.note).replace(/\b\d{4}-\d{2}-\d{2}\b/g, formatDay))}</small>` : ""}<time>${escapeHTML(formatTime(event.created_at))}</time></li>`).join("") || "<li>No tracking updates yet.</li>";
    }

    async function refreshTracking() {
        const id = current;
        const response = await fetch(`/api/deliveries/tracking?delivery_id=${encodeURIComponent(id)}`, { cache: "no-store" });
        const result = await response.json();
        if (id !== current) return;
        if (!response.ok || !result.success) throw new Error(result.message || "Unable to load delivery tracking.");
        renderTracking(result);
    }

    window.showDeliveryTracking = async deliveryId => {
        stop();
        current = deliveryId;
        $("deliveryTrackingMessage").textContent = "Loading...";
        $("deliveryTrackingBody").hidden = false;
        if (!dialog.open) dialog.showModal();
        try {
            await refreshTracking();
            $("deliveryTrackingMessage").textContent = "";
            timer = setInterval(() => refreshTracking().catch(() => {}), 10000);
        } catch (error) {
            $("deliveryTrackingBody").hidden = true;
            $("deliveryTrackingMessage").textContent = error.message || "Unable to load delivery tracking.";
        }
    };
})();
