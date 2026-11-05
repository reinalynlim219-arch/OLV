// Dark mode for the whole system, plus the account dropdown on the signed-in
// name ("Admin (admin) ▾" → Dark/Light mode, Logout) and, on phones, the side
// menu (mobile-nav.js). The theme choice is remembered on this device and
// applied before the page draws.

// Phone numbers are shown the same way everywhere: +63 and the 10 digits
// (09171234567 is shown as +63 9171234567). An old number that is not a mobile
// number (e.g. 12345678904) is marked so the admin knows to correct it.
window.olvPhone = value => {
    const compact = String(value ?? "").replace(/[\s-]/g, "");
    if (/^09\d{9}$/.test(compact)) return "+63 " + compact.slice(1);
    if (/^\+?639\d{9}$/.test(compact)) return "+63 " + compact.slice(-10);
    if (/^\d+$/.test(compact)) return `${compact} (invalid, please update)`;
    return String(value ?? "");
};

// Pop-up messages for the whole system: olvPopup(message, type) shows a box in the
// middle of the screen with an icon, a short title, the message and an OK button.
// type: "danger" (something is wrong), "success", "info" or "warning". Several
// messages in a row are shown one after another. It returns a promise that settles
// when the person presses OK. window.alert() uses the same box, so every message
// in the system looks the same.
(() => {
    const KINDS = {
        danger: ["Something went wrong", "bi-x-circle-fill"],
        warning: ["Please check", "bi-exclamation-triangle-fill"],
        info: ["Please note", "bi-info-circle-fill"],
        success: ["Done", "bi-check-circle-fill"]
    };
    const queue = [];
    let dialog = null, showing = false;
    // Kind of a message passed to alert(): a problem is red, something finished is green,
    // anything else (an instruction like "Load a report first.") is amber "Please check".
    const PROBLEM = /\b(unable|cannot|can't|could not|couldn't|not|invalid|incorrect|wrong|failed|error|denied|insufficient|expired|missing|no longer)\b/i;
    const DONE = /\b(saved|created|completed|updated|recorded|submitted|removed|deleted|received|approved|cancelled|sent|started|restored|archived|activated|successfully|done)\b/i;
    const kindOf = text => PROBLEM.test(text) ? "danger" : DONE.test(text) ? "success" : "warning";

    function build() {
        if (!document.querySelector('link[href*="bootstrap-icons"]')) {
            const icons = document.createElement("link");
            icons.rel = "stylesheet";
            icons.href = "/vendor/bootstrap-icons/bootstrap-icons.min.css";
            document.head.appendChild(icons);
        }
        dialog = document.createElement("dialog");
        dialog.className = "olv-popup";
        dialog.setAttribute("aria-labelledby", "olvPopupTitle");
        dialog.setAttribute("aria-describedby", "olvPopupText");
        dialog.innerHTML = `
            <div class="olv-popup-icon" aria-hidden="true"><i class="bi"></i></div>
            <h2 class="olv-popup-title" id="olvPopupTitle"></h2>
            <p class="olv-popup-text" id="olvPopupText"></p>
            <button type="button" class="olv-popup-ok">OK</button>`;
        dialog.querySelector(".olv-popup-ok").addEventListener("click", () => dialog.close());
        dialog.addEventListener("close", next);
        document.body.appendChild(dialog);
    }
    function next() {
        const done = showing;
        showing = false;
        if (done) done.resolve();
        if (done && done.opener && document.contains(done.opener)) { try { done.opener.focus(); } catch { /* not focusable */ } }
        if (queue.length) setTimeout(show, 0);
    }
    function show() {
        if (showing || !queue.length) return;
        if (!document.body) { document.addEventListener("DOMContentLoaded", show, { once: true }); return; }
        if (!dialog) build();
        showing = queue.shift();
        const [title, icon] = KINDS[showing.type] || KINDS.info;
        dialog.dataset.type = KINDS[showing.type] ? showing.type : "info";
        dialog.querySelector(".olv-popup-title").textContent = showing.title || title;
        dialog.querySelector(".olv-popup-text").textContent = showing.message;
        dialog.querySelector(".olv-popup-icon i").className = `bi ${icon}`;
        showing.opener = document.activeElement;
        // Keep it above any other open pop-up window.
        if (dialog.open) dialog.close();
        dialog.showModal();
        dialog.querySelector(".olv-popup-ok").focus();
    }
    window.olvPopup = (message, type, title) => new Promise(resolve => {
        const text = String(message ?? "").trim();
        if (!text) { resolve(); return; }
        queue.push({ message: text, type: type || kindOf(text), title, resolve });
        show();
    });
    window.alert = message => { window.olvPopup(message); };

    // Questions in the same style, in the middle of the screen (instead of the browser's
    // box at the top of the window):
    //   olvConfirm(message, { ok, cancel, danger }) -> Promise<true|false>
    //   olvPrompt(message, { placeholder, value, ok, cancel }) -> Promise<text|null>
    // Escape, the ✕ and Cancel all answer "no" (null for olvPrompt).
    let ask = null;
    function buildAsk() {
        ask = document.createElement("dialog");
        ask.className = "olv-popup olv-ask";
        ask.setAttribute("aria-labelledby", "olvAskTitle");
        ask.setAttribute("aria-describedby", "olvAskText");
        ask.innerHTML = `
            <div class="olv-popup-icon" aria-hidden="true"><i class="bi bi-question-circle-fill"></i></div>
            <h2 class="olv-popup-title" id="olvAskTitle">Please confirm</h2>
            <p class="olv-popup-text" id="olvAskText"></p>
            <input type="text" class="form-control olv-ask-input" aria-labelledby="olvAskText" maxlength="200">
            <div class="olv-ask-buttons">
                <button type="button" class="olv-ask-cancel">Cancel</button>
                <button type="button" class="olv-popup-ok olv-ask-ok">OK</button>
            </div>`;
        document.body.appendChild(ask);
    }
    function question(message, options, withInput) {
        return new Promise(resolve => {
            const open = () => {
                if (!ask) buildAsk();
                if (ask.open) ask.close();
                const input = ask.querySelector(".olv-ask-input"), okButton = ask.querySelector(".olv-ask-ok"), cancelButton = ask.querySelector(".olv-ask-cancel");
                ask.dataset.type = options.danger ? "danger" : "info";
                ask.querySelector(".olv-popup-icon i").className = `bi ${options.danger ? "bi-exclamation-triangle-fill" : "bi-question-circle-fill"}`;
                ask.querySelector(".olv-popup-title").textContent = options.title || "Please confirm";
                ask.querySelector(".olv-popup-text").textContent = String(message ?? "");
                okButton.textContent = options.ok || "OK";
                cancelButton.textContent = options.cancel || "Cancel";
                input.hidden = !withInput;
                input.value = options.value || "";
                input.placeholder = options.placeholder || "";
                const opener = document.activeElement;
                let answered = false;
                const finish = answer => {
                    if (answered) return;
                    answered = true;
                    okButton.onclick = cancelButton.onclick = input.onkeydown = null;
                    ask.removeEventListener("close", onClose);
                    if (ask.open) ask.close();
                    if (opener && document.contains(opener)) { try { opener.focus(); } catch { /* not focusable */ } }
                    resolve(answer);
                };
                const onClose = () => finish(withInput ? null : false); // Escape or ✕
                okButton.onclick = () => finish(withInput ? input.value.trim() : true);
                cancelButton.onclick = () => finish(withInput ? null : false);
                input.onkeydown = event => { if (event.key === "Enter") { event.preventDefault(); okButton.click(); } };
                ask.addEventListener("close", onClose);
                ask.showModal();
                (withInput ? input : okButton).focus();
            };
            if (document.body) open(); else document.addEventListener("DOMContentLoaded", open, { once: true });
        });
    }
    window.olvConfirm = (message, options = {}) => question(message, options, false);
    window.olvPrompt = (message, options = {}) => question(message, options, true);
})();

// Every pop-up window gets an ✕ close button in its top-right corner (it stays in the
// corner while the window scrolls). It presses the window's own Close/Cancel button
// when there is one, so the page's closing steps still run; otherwise it just closes
// the window. A window's older close button (a "×" in its header) is hidden so every
// window looks the same, and the new ✕ presses it. Works for <dialog> windows and the
// older ".modal" windows, including ones added later.
(() => {
    const CLOSE_WORDS = /^(close|cancel|not yet|ok|back|×)$/i;
    function closeWindow(win) {
        const own = win.querySelector("button.olv-x-replaced, .btn-close.olv-x-replaced, .close.olv-x-replaced") || [...win.querySelectorAll("button, [data-bs-dismiss]")].find(button =>
            !button.closest(".olv-x-wrap") && !button.disabled &&
            (button.hasAttribute("data-bs-dismiss") || /(^|[-_])(close|cancel)/i.test(button.id) || CLOSE_WORDS.test(button.textContent.trim())));
        if (own) { own.click(); return; }
        if (win.tagName === "DIALOG") {
            // Same as pressing Escape: a window that is busy (e.g. saving) can refuse.
            const cancel = new Event("cancel", { cancelable: true });
            if (win.dispatchEvent(cancel)) win.close();
            return;
        }
        const overlay = win.closest(".modal");
        if (overlay) overlay.style.display = "none";
    }
    // The ✕ replaces a window's other close buttons: an old "×" and a separate "Close"
    // button (e.g. at the bottom). They stay in the page, hidden, and the ✕ presses
    // them. "Cancel" on a form is kept. A button row left empty is hidden too.
    function hideOldClose(win) {
        win.querySelectorAll(".btn-close, .close, button").forEach(button => {
            if (button.closest(".olv-x-wrap") || button.classList.contains("olv-x-replaced")) return;
            if (!button.matches(".btn-close, .close") && button.textContent.trim().toLowerCase() !== "close") return;
            button.classList.add("olv-x-replaced");
            const row = button.parentElement;
            if (row && row !== win && [...row.children].every(child => child.classList.contains("olv-x-replaced") || child.hidden)) row.classList.add("olv-x-replaced");
        });
    }
    function addButton(win) {
        // Message and question pop-ups (olvPopup / olvConfirm) close with their own OK or
        // Cancel button, so they get no ✕.
        if (win.matches(".olv-popup")) return;
        if (win.dataset.olvX) { hideOldClose(win); return; }
        win.dataset.olvX = "1";
        hideOldClose(win);
        const wrap = document.createElement("div");
        wrap.className = "olv-x-wrap";
        wrap.innerHTML = '<button type="button" class="olv-x" aria-label="Close" title="Close"><i class="bi bi-x-lg" aria-hidden="true"></i></button>';
        wrap.querySelector("button").addEventListener("click", event => { event.preventDefault(); closeWindow(win); });
        win.prepend(wrap);
        // Sit 12px inside the corner whatever the window's own padding is.
        const placeIt = () => {
            const style = getComputedStyle(win);
            wrap.style.setProperty("--olv-x-top", `${12 - (parseFloat(style.paddingTop) || 0)}px`);
            wrap.style.setProperty("--olv-x-right", `${12 - (parseFloat(style.paddingRight) || 0)}px`);
        };
        placeIt();
        // Windows fill in their buttons when they open (e.g. delivery tracking).
        win.addEventListener("toggle", () => { placeIt(); hideOldClose(win); });
    }
    function scan(root = document) {
        root.querySelectorAll?.("dialog, .modal > .modal-content, .modal .modal-dialog > .modal-content").forEach(addButton);
        if (root.matches?.("dialog")) addButton(root);
    }
    function start() {
        scan();
        new MutationObserver(changes => changes.forEach(change => change.addedNodes.forEach(node => { if (node.nodeType === 1) scan(node); })))
            .observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();

(() => {
    const KEY = "olv-theme";
    const root = document.documentElement;
    const read = () => { try { return localStorage.getItem(KEY) === "dark" ? "dark" : "light"; } catch { return "light"; } };
    const save = theme => { try { localStorage.setItem(KEY, theme); } catch { /* private mode: not remembered */ } };
    const isDark = () => root.getAttribute("data-theme") === "dark";
    const apply = theme => {
        root.setAttribute("data-theme", theme);
        root.setAttribute("data-bs-theme", theme); // Bootstrap's built-in dark colors
        document.querySelectorAll("[data-theme-toggle]").forEach(updateToggle);
    };
    function updateToggle(item) {
        item.setAttribute("aria-checked", String(isDark()));
        const label = isDark() ? "Light mode" : "Dark mode";
        // The top-bar button is just an icon (moon / sun); its name is read out and shown on hover.
        if (item.classList.contains("olv-theme-btn")) {
            item.innerHTML = `<i class="bi ${isDark() ? "bi-sun" : "bi-moon"}" aria-hidden="true"></i>`;
            item.setAttribute("aria-label", label);
            item.title = label;
            return;
        }
        item.textContent = (isDark() ? "☀ " : "☾ ") + label;
    }
    function toggleTheme() {
        const next = isDark() ? "light" : "dark";
        save(next);
        apply(next);
    }
    apply(read());

    // Page layout, set before the page draws so it does not jump: staff pages have the
    // left sidebar; drivers do not. The last signed-in user's layout is remembered
    // (sidebar.js updates it), so the right space is kept from the first moment.
    try { if (localStorage.getItem("olv-layout") === "plain") root.setAttribute("data-olv-layout", "plain"); } catch { /* not remembered */ }

    // Top right of signed-in pages: a Dark/Light mode button and the signed-in name
    // (plain text, no dropdown). The page's own Logout button stays where it is; on
    // pages with the sidebar it is hidden, since Logout is at the bottom of the sidebar.
    function buildAccountMenu(logout) {
        // The name is filled in by the page's own script (topbar.js on most pages).
        let label = document.querySelector("[data-current-user], #currentUser");
        if (!label) {
            label = document.createElement("span");
            fetch("/api/current-user", { cache: "no-store" })
                .then(response => response.ok ? response.json() : null)
                .then(data => { if (data?.user) label.textContent = data.user.full_name || data.user.username; })
                .catch(() => {});
        }
        const onBlueBar = Boolean(logout.closest(".olv-topbar, .navbar"));

        const menu = document.createElement("div");
        menu.className = "olv-user-menu" + (onBlueBar ? " olv-user-menu--on-dark" : "");
        const themeButton = document.createElement("button");
        themeButton.type = "button";
        themeButton.className = "olv-theme-btn";
        themeButton.setAttribute("role", "switch");
        themeButton.setAttribute("data-theme-toggle", "");
        updateToggle(themeButton);
        themeButton.addEventListener("click", toggleTheme);
        label.classList.add("olv-user-name");

        label.parentNode ? label.replaceWith(menu) : logout.parentNode.insertBefore(menu, logout);
        menu.append(themeButton, label);
        logout.classList.add("olv-page-logout");
    }

    function addControls() {
        if (document.querySelector("[data-theme-toggle]")) return;
        const logout = document.querySelector(".olv-topbar [data-logout], #logoutButton");
        if (logout) {
            buildAccountMenu(logout);
            // Signed-in pages also get the phone side menu (☰).
            const phoneMenu = document.createElement("script");
            phoneMenu.src = "/js/mobile-nav.js";
            document.body.appendChild(phoneMenu);
            return;
        }
        // Pages without an account (login, offline, customer history): a small corner switch.
        const button = document.createElement("button");
        button.type = "button";
        button.className = "olv-theme-toggle olv-theme-toggle-floating";
        button.setAttribute("data-theme-toggle", "");
        button.setAttribute("role", "switch");
        button.addEventListener("click", toggleTheme);
        updateToggle(button);
        document.body.appendChild(button);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addControls);
    else addControls();
    // Keep other open tabs in step.
    window.addEventListener("storage", event => { if (event.key === KEY) apply(read()); });
})();
