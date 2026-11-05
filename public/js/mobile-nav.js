// Phone menu: a ☰ button in the top bar opens a side menu that slides in from
// the left. Every signed-in user gets it (admin, staff, driver, customer).
// Admin and staff see the same pages as the desktop sidebar (copied from it
// when opened, so it follows the same role rules); drivers see their pages;
// customers jump to the parts of their account page. The bottom of the menu
// has the signed-in name, Dark mode and Sign out.
(() => {
    if (document.querySelector(".olv-mnav")) return;
    const bar = document.querySelector(".olv-topbar, .topbar-glass, body > nav.navbar .container");
    const logout = document.querySelector(".olv-topbar [data-logout], #logoutButton");
    if (!bar || !logout) return;

    const page = window.location.pathname;
    const icon = name => `<span class="nav-icon"><i class="bi ${name}" aria-hidden="true"></i></span>`;
    const ROLE_PAGES = {
        driver: [["Delivery", "bi-truck", "/delivery"], ["Calendar", "bi-calendar3", "/calendar"]],
        customer: [["Place an order", "bi-cart3", "#placeOrder"], ["Delivery details", "bi-geo-alt", "#deliveryDetails"], ["My orders", "bi-receipt", "#myOrders"]]
    };

    if (!document.querySelector('link[href*="bootstrap-icons"]')) {
        const icons = document.createElement("link");
        icons.rel = "stylesheet";
        icons.href = "/vendor/bootstrap-icons/bootstrap-icons.min.css";
        document.head.appendChild(icons);
    }

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "olv-mnav-toggle";
    toggle.setAttribute("aria-label", "Open menu");
    toggle.setAttribute("aria-controls", "olvMobileMenu");
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = '<i class="bi bi-list" aria-hidden="true"></i>';
    bar.prepend(toggle);
    document.body.classList.add("olv-has-mnav");

    const backdrop = document.createElement("div");
    backdrop.className = "olv-mnav-backdrop";
    backdrop.hidden = true;
    const drawer = document.createElement("aside");
    drawer.className = "olv-mnav";
    drawer.id = "olvMobileMenu";
    drawer.setAttribute("aria-label", "Menu");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.hidden = true;
    drawer.innerHTML = `
        <div class="olv-mnav-head">
            <span class="olv-sidebar-mark"><img src="/images/olv-logo.png" alt="OLV"></span>
            <span class="olv-mnav-brand"><strong>OLV Water</strong><small>Refilling Station</small></span>
            <button type="button" class="olv-mnav-close" aria-label="Close menu"><i class="bi bi-x-lg" aria-hidden="true"></i></button>
        </div>
        <nav class="olv-mnav-links" aria-label="Main navigation"></nav>
        <div class="olv-mnav-foot">
            <div class="olv-mnav-user"></div>
            <button type="button" class="olv-mnav-item" data-mnav-theme></button>
            <button type="button" class="olv-mnav-item olv-mnav-signout">${icon("bi-box-arrow-right")}Sign out</button>
        </div>`;
    document.body.append(backdrop, drawer);
    const links = drawer.querySelector(".olv-mnav-links");
    const themeButton = drawer.querySelector("[data-mnav-theme]");
    let role = null;

    function link(label, iconName, href) {
        const a = document.createElement("a");
        a.className = "olv-mnav-item";
        a.href = href;
        a.innerHTML = icon(iconName);
        a.append(label);
        if (href === page) { a.classList.add("active"); a.setAttribute("aria-current", "page"); }
        return a;
    }
    // Built each time it opens, so it always matches what this user may open.
    function fillLinks() {
        links.replaceChildren();
        if (ROLE_PAGES[role]) {
            ROLE_PAGES[role].forEach(([label, iconName, href]) => links.append(link(label, iconName, href)));
            return;
        }
        document.querySelectorAll(".olv-sidebar .sidebar-nav .nav-item, .sidebar-panel .sidebar-nav .nav-item").forEach(item => {
            if (item.hidden || item.classList.contains("d-none")) return;
            const copy = link(item.textContent.trim(), item.querySelector(".bi")?.classList[1] || "bi-dot", item.getAttribute("href"));
            if (item.classList.contains("active")) { copy.classList.add("active"); copy.setAttribute("aria-current", "page"); }
            links.append(copy);
        });
    }
    function showTheme() {
        const dark = document.documentElement.getAttribute("data-theme") === "dark";
        themeButton.innerHTML = icon(dark ? "bi-sun" : "bi-moon");
        themeButton.append(dark ? "Light mode" : "Dark mode");
    }

    function open() {
        fillLinks();
        showTheme();
        backdrop.hidden = drawer.hidden = false;
        requestAnimationFrame(() => document.body.classList.add("olv-mnav-open"));
        toggle.setAttribute("aria-expanded", "true");
        drawer.querySelector(".olv-mnav-close").focus();
    }
    function close(returnFocus = true) {
        document.body.classList.remove("olv-mnav-open");
        toggle.setAttribute("aria-expanded", "false");
        setTimeout(() => { if (!document.body.classList.contains("olv-mnav-open")) backdrop.hidden = drawer.hidden = true; }, 220);
        if (returnFocus) toggle.focus();
    }
    toggle.addEventListener("click", open);
    backdrop.addEventListener("click", () => close());
    drawer.querySelector(".olv-mnav-close").addEventListener("click", () => close());
    drawer.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if (event.key !== "Tab") return;
        // Keep the keyboard inside the open menu.
        const items = [...drawer.querySelectorAll("a, button")];
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    // A link to a part of this page just scrolls there; the menu closes either way.
    links.addEventListener("click", event => {
        const a = event.target.closest("a");
        if (!a) return;
        close(false);
        const target = a.hash && a.getAttribute("href").startsWith("#") && document.querySelector(a.hash);
        if (!target) return;
        // The page is unlocked first (close), then scrolled.
        event.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    themeButton.addEventListener("click", () => {
        document.querySelector(".olv-user-menu [data-theme-toggle]")?.click();
        showTheme();
    });
    drawer.querySelector(".olv-mnav-signout").addEventListener("click", () => logout.click());
    // Turning the phone sideways (or widening the window) brings back the normal menu.
    window.matchMedia("(min-width: 901px)").addEventListener("change", event => { if (event.matches) close(false); });

    fetch("/api/current-user", { cache: "no-store" })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
            const user = data && data.user;
            if (!user) return;
            role = user.role;
            const who = drawer.querySelector(".olv-mnav-user");
            const name = document.createElement("strong");
            name.textContent = user.full_name || user.username;
            const roleLabel = document.createElement("small");
            roleLabel.textContent = user.role;
            who.append(name, roleLabel);
        })
        .catch(() => {});
})();
