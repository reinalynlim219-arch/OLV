// Adds the show/hide "eye" button to every password field on the page that
// does not already have one (new, old, confirm, and temporary passwords).
// The icon matches the password: a CLOSED eye while it is hidden, an OPEN eye
// while it is shown. Pages with their own eye button use OLVPasswordEye.icon too.
(() => {
    const svg = inner => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`;
    // Open eye: the password can be read.
    const OPEN = svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle>');
    // Closed eye (eyelid with lashes): the password is hidden.
    const CLOSED = svg('<path d="M2 10c2.5 3.4 5.8 5 10 5s7.5-1.6 10-5"></path><path d="m4.6 13.1-1.9 2.4"></path><path d="m9.2 14.8-.7 2.9"></path><path d="m14.8 14.8.7 2.9"></path><path d="m19.4 13.1 1.9 2.4"></path>');
    const icon = visible => visible ? OPEN : CLOSED;

    // Shows the right icon and words on a toggle button.
    function paint(button, visible) {
        button.innerHTML = icon(visible);
        button.setAttribute("aria-pressed", String(visible));
        button.setAttribute("aria-label", visible ? "Hide password" : "Show password");
        button.title = visible ? "Hide password" : "Show password";
    }
    window.OLVPasswordEye = { icon, paint };

    function addEye(input) {
        if (input.dataset.passwordEye || input.parentElement.querySelector(".password-toggle")) return;
        input.dataset.passwordEye = "1";
        const wrap = document.createElement("div");
        wrap.className = "pw-eye-field";
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "password-toggle";
        if (input.id) button.setAttribute("aria-controls", input.id);
        paint(button, false);
        wrap.appendChild(button);
        const hide = () => { input.type = "password"; paint(button, false); };
        button.addEventListener("click", () => {
            if (input.type === "password") { input.type = "text"; paint(button, true); }
            else hide();
            input.focus();
        });
        // Hide the password again when its form is reset or closed.
        input.form?.addEventListener("reset", hide);
    }

    const run = () => {
        document.querySelectorAll('input[type="password"]').forEach(addEye);
        // Eye buttons written into a page (sign-in, customer accounts) start closed too.
        document.querySelectorAll(".password-toggle").forEach(button => {
            const input = document.getElementById(button.getAttribute("aria-controls") || "");
            if (input && !button.dataset.painted) { button.dataset.painted = "1"; paint(button, input.type !== "password"); }
        });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
    else run();
})();
