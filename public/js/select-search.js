// Searchable drop-down: turns a <select> into a button that opens a list with a
// search box at the top. Typing narrows the list (e.g. "raw" -> Rawis). The original
// <select> stays in the page (hidden) and keeps the chosen value, so forms and other
// scripts work as before; when its options change (another city), the list follows.
// Keyboard: arrows move, Enter picks, Escape closes.
(function () {
    function searchable(select, { placeholder = "Type to search…", empty = "No match. Check the spelling." } = {}) {
        if (!select || select.dataset.searchable) return null;
        select.dataset.searchable = "1";
        const id = select.id || `select${Math.random().toString(36).slice(2)}`;
        const wrap = document.createElement("div");
        wrap.className = "select-search";
        wrap.innerHTML = `
            <button type="button" class="form-select select-search-button" id="${id}Button" aria-haspopup="listbox" aria-expanded="false"></button>
            <div class="select-search-panel" hidden>
                <input type="text" class="form-control form-control-sm select-search-input" id="${id}Search" placeholder="${placeholder}"
                    role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="${id}Options" autocomplete="off">
                <ul class="select-search-list" id="${id}Options" role="listbox"></ul>
            </div>`;
        select.insertAdjacentElement("afterend", wrap);
        select.classList.add("select-search-native");
        select.tabIndex = -1;
        select.setAttribute("aria-hidden", "true");
        const button = wrap.querySelector("button"), panel = wrap.querySelector(".select-search-panel");
        const search = wrap.querySelector("input"), list = wrap.querySelector("ul");
        // The page's <label for="…"> now points at the button.
        document.querySelector(`label[for="${select.id}"]`)?.setAttribute("for", button.id);
        let active = -1, shown = [];

        const options = () => [...select.options].filter(option => option.value);
        function showButton() {
            const chosen = select.options[select.selectedIndex];
            button.textContent = chosen && chosen.value ? chosen.textContent : (select.options[0]?.textContent || "Choose");
            button.classList.toggle("is-placeholder", !select.value);
        }
        function draw() {
            const words = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
            shown = options().filter(option => words.every(word => option.textContent.toLowerCase().includes(word)));
            list.innerHTML = shown.length
                ? shown.map((option, index) => `<li role="option" id="${id}Option${index}" data-index="${index}" aria-selected="${option.value === select.value}">${option.textContent.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c])}</li>`).join("")
                : `<li class="select-search-empty" aria-disabled="true">${empty}</li>`;
            highlight(shown.length ? Math.max(0, shown.findIndex(option => option.value === select.value)) : -1);
        }
        function highlight(index) {
            active = index;
            list.querySelectorAll("[role=option]").forEach((item, i) => item.classList.toggle("is-active", i === index));
            const item = list.querySelector(`[data-index="${index}"]`);
            if (item) { search.setAttribute("aria-activedescendant", item.id); item.scrollIntoView({ block: "nearest" }); }
            else search.removeAttribute("aria-activedescendant");
        }
        function open() {
            if (!options().length) return;
            panel.hidden = false;
            button.setAttribute("aria-expanded", "true");
            search.value = "";
            draw();
            search.focus();
        }
        function close(focusButton = true) {
            panel.hidden = true;
            button.setAttribute("aria-expanded", "false");
            if (focusButton) button.focus();
        }
        function choose(index) {
            const option = shown[index];
            if (!option) return;
            select.value = option.value;
            select.dispatchEvent(new Event("input", { bubbles: true }));
            select.dispatchEvent(new Event("change", { bubbles: true }));
            showButton();
            close();
        }

        button.addEventListener("click", () => (panel.hidden ? open() : close()));
        button.addEventListener("keydown", event => {
            if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) { event.preventDefault(); open(); }
            // Start typing on the closed button: open with that letter in the search box.
            else if (event.key.length === 1 && /\S/.test(event.key)) { event.preventDefault(); open(); search.value = event.key; draw(); }
        });
        search.addEventListener("input", draw);
        search.addEventListener("keydown", event => {
            if (event.key === "ArrowDown") { event.preventDefault(); highlight(Math.min(shown.length - 1, active + 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); highlight(Math.max(0, active - 1)); }
            else if (event.key === "Enter") { event.preventDefault(); choose(active); }
            else if (event.key === "Escape") { event.preventDefault(); close(); }
            else if (event.key === "Tab") close(false);
        });
        list.addEventListener("mousedown", event => event.preventDefault()); // keep focus in the search box
        list.addEventListener("click", event => { const item = event.target.closest("[role=option]"); if (item) choose(Number(item.dataset.index)); });
        document.addEventListener("click", event => { if (!panel.hidden && !wrap.contains(event.target)) close(false); });
        // The <select> was refilled (another city) or changed by a script or a form reset.
        new MutationObserver(() => { showButton(); if (!panel.hidden) draw(); }).observe(select, { childList: true });
        select.addEventListener("change", showButton);
        select.form?.addEventListener("reset", () => setTimeout(showButton));
        // Errors point people at the button, the part they can see.
        select.focus = () => button.focus();
        showButton();
        return { refresh: showButton, open, close };
    }
    window.OLVSelectSearch = { searchable };
})();
