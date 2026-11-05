// Shared top bar: Logout button, signed-in user label, and hiding
// "Back to Dashboard" for drivers (their home page is Deliveries).
(() => {
    const bar = document.querySelector(".olv-topbar");
    if (!bar) return;
    bar.querySelectorAll("[data-logout]").forEach(button => button.addEventListener("click", async () => {
        button.disabled = true;
        try { await fetch("/logout", { method: "POST" }); } catch (error) { console.error(error); }
        window.location.href = "/login";
    }));
    fetch("/api/current-user", { cache: "no-store" })
        .then(response => response.ok ? response.json() : null)
        .then(data => {
            const user = data && data.user;
            if (!user) return;
            const label = bar.querySelector("[data-current-user]");
            if (label) label.textContent = user.full_name || user.username;
            if (user.role === "driver") bar.querySelector("[data-back]")?.setAttribute("hidden", "");
        })
        .catch(() => {});
})();
