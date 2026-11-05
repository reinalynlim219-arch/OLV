let accounts = [];

function setAccountPasswordVisible(visible) {
    const input = document.getElementById("accountPassword");
    const button = document.getElementById("toggleAccountPassword");
    input.type = visible ? "text" : "password";
    // Closed eye while hidden, open eye while shown (see password-eye.js).
    if (window.OLVPasswordEye) window.OLVPasswordEye.paint(button, visible);
    else {
        button.setAttribute("aria-pressed", String(visible));
        button.setAttribute("aria-label", visible ? "Hide password" : "Show password");
        button.title = visible ? "Hide password" : "Show password";
    }
}

document.getElementById("toggleAccountPassword").addEventListener("click", () => {
    setAccountPasswordVisible(document.getElementById("accountPassword").type === "password");
});
document.getElementById("customerAccountForm").addEventListener("reset", () => setAccountPasswordVisible(false));

function renderAccounts() {
    const body = document.getElementById("accountRows");
    const search = document.getElementById("accountSearch").value.trim().toLowerCase();
    const status = document.getElementById("accountStatusFilter").value;
    const visible = accounts.filter(account =>
        (status === "all" || account.status === status) &&
        [account.customer_name, account.username, account.contact_number, olvPhone(account.contact_number), account.email].some(value => String(value || "").toLowerCase().includes(search))
    );
    body.replaceChildren();
    if (!visible.length) {
        const row = body.insertRow();
        const cell = row.insertCell();
        cell.colSpan = 7;
        cell.textContent = accounts.length ? "No customer accounts match your filters." : "No registered customer accounts yet.";
        return;
    }
    visible.forEach(account => {
        const row = body.insertRow();
        [account.customer_name, account.username, olvPhone(account.contact_number) || "Not provided", account.email || "Not provided", account.email_verified ? "Verified" : "Not verified"].forEach(value => {
            row.insertCell().textContent = value;
        });
        // Login status as the same label as everywhere else (green active, amber pending, grey inactive).
        const status = document.createElement("span");
        status.className = `badge ${account.status === "active" ? "bg-success" : account.status === "pending" ? "bg-warning" : "bg-secondary"}`;
        status.textContent = account.status === "pending" ? "Pending verification" : account.status;
        row.insertCell().appendChild(status);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-sm btn-primary";
        button.textContent = "Edit account";
        button.addEventListener("click", () => manageCustomerAccount(account.customer_id));
        row.insertCell().appendChild(button);
    });
}

async function loadAccounts() {
    const refresh = document.getElementById("refreshAccounts");
    refresh.disabled = true;
    try {
        const response = await fetch("/api/customer-accounts", { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) throw new Error(result.message || "Unable to load customer accounts.");
        accounts = result.accounts;
        renderAccounts();
        document.getElementById("accountsMessage").textContent = "";
    } catch (error) {
        document.getElementById("accountsMessage").textContent = error.message;
        document.getElementById("accountRows").replaceChildren();
    } finally {
        refresh.disabled = false;
    }
}

document.getElementById("accountSearch").addEventListener("input", renderAccounts);
document.getElementById("accountStatusFilter").addEventListener("change", renderAccounts);
document.getElementById("refreshAccounts").addEventListener("click", loadAccounts);

async function manageCustomerAccount(customerId) {
    try {
        const response = await fetch(`/api/customers/account?customer_id=${customerId}`, { cache: "no-store" });
        const result = await response.json();
        if (!response.ok) return alert(result.message || "Unable to load customer account.");
        document.getElementById("customerAccountForm").reset();
        document.getElementById("accountCustomerId").value = result.account.customer_id;
        document.getElementById("accountEmail").value = result.account.email || "";
        document.getElementById("accountEmailStatus").textContent = result.account.email_verified ? "Verified" : (result.account.email ? "Not verified; unavailable for password recovery." : "No email provided.");
        const contact = document.getElementById("accountContact");
        if (contact) contact.value = result.account.contact_number || "";
        document.getElementById("accountUsername").value = result.account.username;
        document.getElementById("accountStatus").value = result.account.status;
        document.getElementById("customerAccountMessage").textContent = "A new username, password, or login status signs the customer out.";
        document.getElementById("customerAccountDialog").showModal();
    } catch (error) {
        alert("Unable to load customer account. Please try again.");
    }
}

document.getElementById("cancelCustomerAccount").addEventListener("click", () => {
    document.getElementById("customerAccountDialog").close();
});

loadAccounts();
document.getElementById("customerAccountDialog").addEventListener("close", () => {
    document.getElementById("customerAccountForm").reset();
});
document.getElementById("customerAccountForm").addEventListener("submit", async event => {
    event.preventDefault();
    const button = document.getElementById("saveCustomerAccount");
    const message = document.getElementById("customerAccountMessage");
    button.disabled = true;
    document.getElementById("cancelCustomerAccount").disabled = true;
    try {
        const response = await fetch("/api/customers/account", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                customer_id: Number(document.getElementById("accountCustomerId").value),
                contact_number: document.getElementById("accountContact")?.value.trim(),
                username: document.getElementById("accountUsername").value.trim(),
                password: document.getElementById("accountPassword").value,
                status: document.getElementById("accountStatus").value
            })
        });
        const result = await response.json();
        if (!response.ok) { message.textContent = result.message || "Unable to save account."; return; }
        document.getElementById("customerAccountDialog").close();
        await loadAccounts();
        document.getElementById("accountsMessage").textContent = result.message;
    } catch (error) {
        message.textContent = "Unable to save account. Please try again.";
    } finally {
        button.disabled = false;
        document.getElementById("cancelCustomerAccount").disabled = false;
    }
});

// Email changes are confirmed by the customer through an emailed link,
// separately from password and login-status changes.
document.getElementById('sendAccountEmailLink').addEventListener('click', async event => {
    const button = event.currentTarget;
    const email = document.getElementById('accountEmail');
    const message = document.getElementById('accountEmailStatus');
    if (!email.value.trim() || !email.checkValidity()) { message.textContent = 'Enter a valid email address.'; return; }
    const customerId = document.getElementById('accountCustomerId').value;
    button.disabled = true;
    try {
        const response = await fetch('/api/customers/email/request', {
            method: 'POST', headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ customer_id: Number(customerId), email: email.value.trim() })
        });
        const result = await response.json();
        if (!document.getElementById('customerAccountDialog').open || document.getElementById('accountCustomerId').value !== customerId) return;
        message.textContent = result.message;
    } catch { message.textContent = 'Unable to send the confirmation email. Please try again.'; }
    finally { button.disabled = false; }
});
