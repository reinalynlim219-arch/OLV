// Public homepage: live products and prices, delivery hours, and the phone menu.
(function () {
    const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
    const peso = value => "₱" + Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    // "08:00" -> "8:00 AM"
    const clock = hhmm => {
        const [h, m] = String(hhmm || "").split(":").map(Number);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
        return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    };

    document.getElementById("year").textContent = new Date().getFullYear();

    // Phone menu.
    const toggle = document.querySelector(".nav-toggle");
    const links = document.getElementById("siteLinks");
    toggle.addEventListener("click", () => {
        const open = links.classList.toggle("open");
        toggle.setAttribute("aria-expanded", String(open));
        toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    });
    links.addEventListener("click", event => {
        if (event.target.closest("a")) { links.classList.remove("open"); toggle.setAttribute("aria-expanded", "false"); }
    });

    async function loadInfo() {
        const grid = document.getElementById("productGrid");
        try {
            const response = await fetch("/api/public/info", { cache: "no-store" });
            const info = await response.json();
            if (!response.ok || !info.success) throw new Error();
            grid.innerHTML = info.products.length
                ? info.products.map(item => `<article class="product-card">
                        <i class="bi bi-droplet-fill" aria-hidden="true"></i>
                        <h3>${escapeHTML(item.product_name)}</h3>
                        <p class="price">${peso(item.price)} <span>/ ${escapeHTML(item.unit || "refill")}</span></p>
                        ${Number(item.new_container_price) > 0 ? `<p class="muted small">With a new container: ${peso(Number(item.price) + Number(item.new_container_price))}</p>` : ""}
                    </article>`).join("")
                : `<p class="muted">Products will be listed here soon. Call us for today's prices.</p>`;
            const from = clock(info.delivery_hours.first_trip), to = clock(info.delivery_hours.last_trip);
            if (from && to) document.getElementById("deliveryHours").textContent = `${from} – ${to}`;
        } catch {
            grid.innerHTML = `<p class="muted">Products could not be loaded right now. Call us for today's prices.</p>`;
        }
    }
    loadInfo();
})();
