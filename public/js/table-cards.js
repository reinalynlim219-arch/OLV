// When a table does not fit its box (phones, tablets, small laptops), it turns into
// one card per row (see .olv-cards-on in theme.css), so nothing needs a sideways
// swipe. Each cell is labeled with its column heading. Rows drawn later by page
// scripts (lists that refresh, pages, filters) are labeled as they appear, and the
// check runs again when the screen turns or the window is resized.
// Add data-no-cards to a <table> to keep it as a table.
// Add data-collapse to show each card folded: only its first cell (e.g. the product
// name) until it is tapped; the other details then drop down. Open cards stay open when
// the page redraws the list (remembered by the row's data-fold-key, e.g. the order
// number, or else by that first cell's text).
(() => {
    const openCards = new WeakMap(); // table -> Set of keys of the open cards
    const keyOf = row => row.dataset.foldKey || row.firstElementChild.textContent.trim();
    function setOpen(table, row, open) {
        const head = row.firstElementChild;
        row.classList.toggle("is-open", open);
        head.setAttribute("aria-expanded", String(open));
        const keys = openCards.get(table);
        open ? keys.add(keyOf(row)) : keys.delete(keyOf(row));
    }
    function makeFoldable(table, row) {
        const head = row.firstElementChild;
        if (!head || head.colSpan > 1 || row.classList.contains("olv-fold")) return;
        if (!openCards.has(table)) openCards.set(table, new Set());
        row.classList.add("olv-fold");
        head.classList.add("olv-fold-head");
        head.tabIndex = 0;
        head.setAttribute("role", "button");
        setOpen(table, row, openCards.get(table).has(keyOf(row)));
        head.addEventListener("click", event => {
            if (!table.classList.contains("olv-cards-on") || event.target.closest("a, button, input, select")) return;
            setOpen(table, row, !row.classList.contains("is-open"));
        });
        head.addEventListener("keydown", event => {
            if (!table.classList.contains("olv-cards-on") || !["Enter", " "].includes(event.key)) return;
            event.preventDefault();
            setOpen(table, row, !row.classList.contains("is-open"));
        });
    }
    function label(table) {
        const headings = [...table.querySelectorAll("thead th")].map(th => th.textContent.trim());
        if (!headings.length) return false;
        table.classList.add("olv-cards");
        table.querySelectorAll("tbody tr, tfoot tr").forEach(row => {
            let column = 0;
            for (const cell of row.children) {
                if (!cell.hasAttribute("data-label")) cell.setAttribute("data-label", cell.colSpan > 1 ? "" : headings[column] || "");
                column += cell.colSpan || 1;
            }
            if (table.hasAttribute("data-collapse") && row.parentElement.tagName === "TBODY") makeFoldable(table, row);
        });
        return true;
    }
    // Measured as a normal table; becomes cards only when wider than its box.
    function fit(table) {
        const box = table.parentElement;
        if (!box || !table.offsetParent) return; // hidden (closed pop-up, other tab)
        const wasCards = table.classList.contains("olv-cards-on");
        table.classList.remove("olv-cards-on");
        box.classList.remove("olv-cards-box");
        const tooWide = table.scrollWidth > box.clientWidth + 2 || table.getBoundingClientRect().right > document.documentElement.clientWidth + 2;
        table.classList.toggle("olv-cards-on", tooWide);
        box.classList.toggle("olv-cards-box", tooWide);
        if (wasCards !== tooWide) table.dispatchEvent(new CustomEvent("olv-cards-change", { bubbles: true }));
    }
    let queued = false;
    function update() {
        queued = false;
        document.querySelectorAll("table:not([data-no-cards])").forEach(table => { if (label(table)) fit(table); });
    }
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
    function start() {
        update();
        // Only added/removed rows matter; class changes made here do not re-trigger it.
        new MutationObserver(queue).observe(document.body, { childList: true, subtree: true });
        window.addEventListener("resize", queue);
        // Pop-ups (reports, dialogs) are measured once they open.
        document.addEventListener("toggle", queue, true);
        document.addEventListener("click", () => setTimeout(queue, 50), true);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
