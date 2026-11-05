// Recently Deleted page (admin and staff): products removed from the inventory.
// Each can be restored to how it was (active or archived) or deleted permanently.
// There is no time limit; products stay until someone acts on them.
(function () {
    const $ = id => document.getElementById(id);
    const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
    const peso = value => "₱" + Number(value || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let products = [];

    function render() {
        const search = $("deletedSearch").value.trim().toLowerCase();
        const shown = products.filter(item => [item.product_name, item.supplier_name, item.unit].some(v => String(v || "").toLowerCase().includes(search)));
        $("deletedCount").textContent = products.length;
        if (!shown.length) {
            $("deletedList").innerHTML = `<p class="text-muted mb-0">${products.length ? "No removed products match your search." : "Nothing here. Products you remove from the Inventory page appear here."}</p>`;
            return;
        }
        $("deletedList").innerHTML = shown.map(item => {
            const removedOn = new Date(String(item.removed_at).replace(" ", "T") + "Z")
                .toLocaleString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium", timeStyle: "short" });
            return `<div class="removed-item">
                <div class="removed-info">
                    <strong class="removed-name">${escapeHTML(item.product_name)}</strong>
                    <span class="removed-meta">${escapeHTML(item.unit || "")} · ${peso(item.price)} · ${Number(item.quantity)} in stock${item.supplier_name ? ` · ${escapeHTML(item.supplier_name)}` : ""}</span>
                    <span class="removed-meta">Removed ${escapeHTML(removedOn)}${item.removed_by_name ? ` by ${escapeHTML(item.removed_by_name)}` : ""} · was ${item.status_before_removal === "archived" ? "archived" : "active"}</span>
                </div>
                <div class="removed-actions">
                    <button type="button" class="btn btn-sm btn-outline-primary" data-restore="${Number(item.product_id)}"><i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i> Restore</button>
                    <button type="button" class="btn btn-sm btn-danger btn-remove" data-delete="${Number(item.product_id)}">Delete permanently</button>
                </div>
            </div>`;
        }).join("");
    }

    async function load() {
        try {
            const response = await fetch("/api/inventory/removed", { cache: "no-store" });
            if (response.status === 401) { window.location.href = "/login"; return; }
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || "Unable to load removed products.");
            products = result.products || [];
            render();
        } catch (error) {
            $("deletedList").innerHTML = `<p class="text-danger mb-0">${escapeHTML(error.message || "Unable to load removed products.")}</p>`;
        }
    }

    async function act(url, method, productId) {
        const response = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ product_id: productId }) });
        if (response.status === 401) { window.location.href = "/login"; return null; }
        const result = await response.json();
        return { ok: response.ok, message: result.message };
    }

    $("deletedList").addEventListener("click", async event => {
        const restore = event.target.closest("[data-restore]");
        const remove = event.target.closest("[data-delete]");
        const button = restore || remove;
        if (!button) return;
        const id = Number(restore ? restore.dataset.restore : remove.dataset.delete);
        const item = products.find(p => Number(p.product_id) === id);
        const name = item ? item.product_name : "this product";
        if (remove && !(await olvConfirm(`Delete "${name}" permanently?\n\nThis cannot be undone.`, { ok: "Delete permanently", danger: true }))) return;
        button.disabled = true;
        try {
            const result = restore
                ? await act("/api/inventory/restore", "PUT", id)
                : await act("/api/inventory/delete", "DELETE", id);
            if (!result) return;
            $("deletedMessage").className = `small mb-2 ${result.ok ? "text-success" : "text-danger"}`;
            $("deletedMessage").textContent = result.message || (result.ok ? "Done." : "Unable to finish. Try again.");
            await load();
        } catch {
            $("deletedMessage").className = "small mb-2 text-danger";
            $("deletedMessage").textContent = "Unable to finish. Check your connection and try again.";
            button.disabled = false;
        }
    });
    $("deletedSearch").addEventListener("input", render);

    load();
    // Products removed by someone else show up on their own.
    setInterval(load, 15000);
})();
