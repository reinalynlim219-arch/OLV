// Dashboard sidebar: hovering (or keyboard-focusing) a menu item opens a panel
// beside it with quick links for that section. Clicking the item itself still
// opens the section's main page.
(() => {
    const sections = {
        inventory: {
            title: "Inventory",
            links: [
                ["bi-box-seam", "Products & stock", "View and manage every product", "/inventory"],
                ["bi-plus-square", "Add product", "Open the Add Product form", "/inventory?action=add"],
                ["bi-arrow-left-right", "Movement history", "Every Stock In and Out of Stock", "/inventory-movements"]
            ]
        },
        orders: {
            title: "Orders",
            links: [
                ["bi-cart3", "All orders", "Customer orders and stock-out", "/orders"]
            ]
        },
        delivery: {
            title: "Delivery",
            links: [
                ["bi-truck", "Delivery list", "All scheduled deliveries", "/delivery"],
                ["bi-calendar-plus", "Schedule a delivery", "Assign an order to a driver", "/delivery?action=schedule"],
                ["bi-signpost-2", "Out for delivery", "Deliveries on the road now", "/delivery?status=out_for_delivery"],
                ["bi-hourglass-split", "Awaiting customer", "Dropped off, not yet confirmed", "/delivery?status=awaiting_customer"],
                ["bi-calendar3", "Delivery calendar", "Deliveries and orders by day", "/calendar"]
            ]
        },
        customers: {
            title: "Customers",
            links: [
                ["bi-people", "Customer information", "Records and delivery addresses", "/customers"],
                ["bi-person-plus", "Add customer", "Open the Add Customer form", "/customers?action=add"],
                ["bi-archive", "Archived customers", "Customers no longer active", "/customers?status=archived"],
                ["bi-person-badge", "Customer accounts", "Portal logins and emails", "/customer-accounts", "admin"]
            ]
        },
        reports: {
            title: "Reports",
            links: [
                ["bi-clipboard-data", "Inventory report", "Stock on hand and value", "/reports?report=inventory"],
                ["bi-graph-up-arrow", "Sales report", "Completed orders and sales", "/reports?report=sales"],
                ["bi-truck", "Delivery report", "Schedules and delivery status", "/reports?report=delivery"],
                ["bi-people", "Customer report", "Customers and total spent", "/reports?report=customers"],
                ["bi-receipt", "Transaction / receipt report", "Completed transactions", "/reports?report=transactions"]
            ]
        },
        accounts: {
            title: "Manage Accounts",
            links: [
                ["bi-person-gear", "Staff accounts", "Admins, staff, and drivers", "/staff-accounts"],
                ["bi-person-badge", "Customer accounts", "Portal logins and emails", "/customer-accounts"]
            ]
        }
    };

    const items = [...document.querySelectorAll(".sidebar-nav [data-flyout]")];
    if (!items.length) return;
    let role = "";
    fetch("/api/current-user", { cache: "no-store" })
        .then(response => response.ok ? response.json() : null)
        .then(data => { role = data?.user?.role || ""; })
        .catch(() => {});

    const panel = document.createElement("div");
    panel.className = "nav-flyout";
    panel.hidden = true;
    document.body.appendChild(panel);
    let owner = null;
    let hideTimer = null;
    // The panel only makes sense beside a side menu; on phones the menu stacks.
    const wideScreen = () => window.matchMedia("(min-width: 901px)").matches;

    function show(item) {
        if (!wideScreen()) return;
        clearTimeout(hideTimer);
        const section = sections[item.dataset.flyout];
        if (!section) return;
        if (owner !== item) {
            const heading = document.createElement("div");
            heading.className = "nav-flyout-title";
            heading.textContent = section.title;
            const list = document.createElement("div");
            list.className = "nav-flyout-list";
            section.links
                .filter(([, , , , needs]) => !needs || needs === role)
                .forEach(([icon, label, hint, href]) => {
                    const link = document.createElement("a");
                    link.className = "nav-flyout-link";
                    link.href = href;
                    const badge = document.createElement("span");
                    badge.className = "nav-flyout-icon";
                    badge.innerHTML = `<i class="bi ${icon}" aria-hidden="true"></i>`;
                    const text = document.createElement("span");
                    text.className = "nav-flyout-text";
                    const strong = document.createElement("strong");
                    strong.textContent = label;
                    const small = document.createElement("small");
                    small.textContent = hint;
                    text.append(strong, small);
                    link.append(badge, text);
                    list.appendChild(link);
                });
            panel.replaceChildren(heading, list);
            panel.setAttribute("aria-label", `${section.title} quick links`);
            owner?.setAttribute("aria-expanded", "false");
            owner = item;
        }
        item.setAttribute("aria-expanded", "true");
        panel.hidden = false;
        // Line the panel up with the hovered item, keeping it on screen.
        const box = item.getBoundingClientRect();
        const sidebar = item.closest(".sidebar-panel, .olv-sidebar").getBoundingClientRect();
        panel.style.left = `${sidebar.right + 10}px`;
        const top = Math.min(box.top - 10, window.innerHeight - panel.offsetHeight - 12);
        panel.style.top = `${Math.max(12, top)}px`;
    }
    function hideSoon() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 180);
    }
    function hide() {
        panel.hidden = true;
        owner?.setAttribute("aria-expanded", "false");
    }

    items.forEach(item => {
        item.setAttribute("aria-haspopup", "true");
        item.setAttribute("aria-expanded", "false");
        item.addEventListener("mouseenter", () => show(item));
        item.addEventListener("mouseleave", hideSoon);
        item.addEventListener("focus", () => show(item));
        item.addEventListener("keydown", event => {
            if (event.key === "ArrowRight" && !panel.hidden) {
                event.preventDefault();
                panel.querySelector("a")?.focus();
            }
        });
    });
    panel.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    panel.addEventListener("mouseleave", hideSoon);
    panel.addEventListener("keydown", event => {
        const links = [...panel.querySelectorAll("a")];
        const index = links.indexOf(document.activeElement);
        if (event.key === "ArrowDown") { event.preventDefault(); links[(index + 1) % links.length]?.focus(); }
        if (event.key === "ArrowUp") { event.preventDefault(); links[(index - 1 + links.length) % links.length]?.focus(); }
        if (event.key === "Escape" || event.key === "ArrowLeft") { event.preventDefault(); owner?.focus(); hide(); }
    });
    document.addEventListener("focusin", event => {
        if (!panel.contains(event.target) && !items.includes(event.target)) hide();
    });
    document.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
    window.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("resize", hide);
})();
