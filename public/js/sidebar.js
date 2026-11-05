// Shared left sidebar for the staff pages (same menu as the dashboard, with
// the hover quick-link panels). The current section is highlighted.
(() => {
    if (!document.body.classList.contains("olv-page") || document.querySelector(".olv-sidebar")) return;

    // [key, label, icon, link, who can see it]
    const menu = [
        ["dashboard", "Dashboard", "bi-grid-1x2-fill", "/dashboard"],
        ["inventory", "Inventory", "bi-box-seam", "/inventory"],
        ["orders", "Orders", "bi-cart3", "/orders"],
        ["delivery", "Delivery", "bi-truck", "/delivery"],
        ["calendar", "Calendar", "bi-calendar3", "/calendar"],
        ["customers", "Customers", "bi-people", "/customers"],
        ["reports", "Reports", "bi-bar-chart", "/reports"],
        ["accounts", "Manage Accounts", "bi-person-gear", "/staff-accounts", ["admin"]],
        ["activity", "Activity Log", "bi-clock-history", "/activity-log", ["admin"]],
        ["deleted", "Recently Deleted", "bi-trash3", "/recently-deleted", ["admin", "staff"]]
    ];
    const sectionOfPage = {
        "/dashboard": "dashboard",
        "/inventory": "inventory", "/inventory-movements": "inventory",
        "/orders": "orders", "/delivery": "delivery", "/customers": "customers", "/customer-history": "customers",
        "/reports": "reports", "/staff-accounts": "accounts", "/users": "accounts", "/customer-accounts": "accounts",
        "/activity-log": "activity", "/calendar": "calendar", "/recently-deleted": "deleted"
    };
    const current = sectionOfPage[window.location.pathname];

    // Icons font (the dashboard already loads it; other pages may not).
    if (!document.querySelector('link[href*="bootstrap-icons"]')) {
        const icons = document.createElement("link");
        icons.rel = "stylesheet";
        icons.href = "/vendor/bootstrap-icons/bootstrap-icons.min.css";
        document.head.appendChild(icons);
    }

    const aside = document.createElement("aside");
    aside.className = "olv-sidebar";
    aside.setAttribute("aria-label", "Main menu");
    aside.innerHTML = `
        <a class="olv-sidebar-brand" href="/dashboard">
            <span class="olv-sidebar-mark"><img src="/images/olv-logo.png" alt="OLV"></span>
            <span><span class="olv-sidebar-name">OLV Water</span><small>Operations Suite</small></span>
        </a>
        <nav class="sidebar-nav" aria-label="Main navigation"></nav>
        <button type="button" class="nav-item olv-sidebar-logout"><span class="nav-icon"><i class="bi bi-box-arrow-right" aria-hidden="true"></i></span>Logout</button>`;
    // Logout sits at the bottom of the menu (not in the name menu); it uses the page's own sign-out.
    aside.querySelector(".olv-sidebar-logout").addEventListener("click", () => document.querySelector(".olv-topbar [data-logout]")?.click());
    const nav = aside.querySelector("nav");
    const links = menu.map(([key, label, icon, href, roles]) => {
        const link = document.createElement("a");
        link.className = "nav-item" + (key === current ? " active" : "");
        link.href = href;
        if (!["dashboard", "calendar", "deleted"].includes(key)) link.dataset.flyout = key;
        if (key === current) link.setAttribute("aria-current", "page");
        if (roles) { link.hidden = true; link.dataset.roles = roles.join(","); }
        link.innerHTML = `<span class="nav-icon"><i class="bi ${icon}" aria-hidden="true"></i></span>`;
        link.append(label);
        nav.appendChild(link);
        return link;
    });
    // theme.js marks the page "plain" when the last user here was a driver; the sidebar
    // then waits for the role instead of showing and disappearing again.
    const root = document.documentElement;
    const rememberLayout = layout => {
        try { localStorage.setItem("olv-layout", layout); } catch { /* not remembered */ }
        if (layout === "plain") root.setAttribute("data-olv-layout", "plain"); else root.removeAttribute("data-olv-layout");
    };
    const showSidebar = () => { aside.hidden = false; document.body.classList.add("olv-with-sidebar"); };
    // Show the last user's menu items straight away (corrected below once the role is known),
    // so Manage Accounts and the rest do not pop in a moment later.
    const showItemsFor = role => links.forEach(link => { if (link.dataset.roles) link.hidden = !link.dataset.roles.split(",").includes(role); });
    try { showItemsFor(localStorage.getItem("olv-role") || ""); } catch { /* not remembered */ }
    document.body.prepend(aside);
    if (root.getAttribute("data-olv-layout") === "plain") aside.hidden = true; else showSidebar();

    fetch("/api/current-user", { cache: "no-store" })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
            const role = data?.user?.role;
            if (!role) return;
            // Drivers only use the delivery page, so they get no sidebar.
            if (role === "driver") {
                aside.remove();
                document.body.classList.remove("olv-with-sidebar");
                rememberLayout("plain");
                return;
            }
            showItemsFor(role);
            try { localStorage.setItem("olv-role", role); } catch { /* not remembered */ }
            showSidebar();
            rememberLayout("sidebar");
        })
        .catch(() => {});

    // Hover panels with quick links (same script as the dashboard).
    const flyout = document.createElement("script");
    flyout.src = "/js/nav-flyout.js";
    document.body.appendChild(flyout);
})();
