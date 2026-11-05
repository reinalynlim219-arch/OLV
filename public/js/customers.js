// Barangay dropdown follows the chosen city (Legazpi City or Daraga).
const barangayPicker = OLVBarangays.bind(document.getElementById("city"), document.getElementById("barangay"));

// Customer-entered text must display as text, never as page markup.
function customerText(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
}

// ==========================================
// LOAD CUSTOMERS
// ==========================================

let loadedCustomers = [];

async function loadCustomers() {

    try {

        const response =
            await fetch("/api/customers");

        const customers =
            await response.json();
        loadedCustomers = Array.isArray(customers) ? customers : [];

        const tableBody =
            document.getElementById(
                "customerTableBody"
            );

        tableBody.innerHTML = "";

        const statusFilter = document.getElementById("customerStatusFilter")?.value || "active";
        const visibleCustomers = customers.filter(customer => statusFilter === "all" || customer.status === statusFilter);
        // Summary cards and the count under the table title.
        const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
        setText("customersTotal", customers.length);
        setText("customersActive", customers.filter(customer => customer.status === "active").length);
        setText("customersArchived", customers.filter(customer => customer.status === "archived").length);
        setText("customerCount", `${visibleCustomers.length} ${visibleCustomers.length === 1 ? "customer" : "customers"} shown`);
        if (!visibleCustomers.length) {
            tableBody.innerHTML = `<tr><td colspan="6" class="empty-message">No ${statusFilter} customers found.</td></tr>`;
            return;
        }

        visibleCustomers.forEach(customer => {

            tableBody.innerHTML += `

                <tr>

                    <td><strong>${customerText(customer.customer_name)}</strong></td>

                    <td>${customerText(olvPhone(customer.contact_number))}</td>

                    <td class="customer-address">${customerText(customer.address)}</td>

                    <td><span class="olv-pill pill-blue">${customerText(customer.customer_type || "Regular")}</span></td>

                    <td><span class="olv-pill ${customer.status === "active" ? "pill-green" : "pill-slate"}">${customerText(customer.status)}</span></td>

                    <td>

                        <button
                            onclick="editCustomer(${customer.customer_id})"
                        >
                            Edit
                        </button>
                        <button type="button" onclick="window.location.href='/customer-history?id=${Number(customer.customer_id)}'">View History</button>
                        ${!Number(customer.has_login) && customer.status === "active" ? `<button type="button" onclick="createCustomerLogin(${Number(customer.customer_id)})" title="For customers without email: make a portal login for them">Create login</button>` : ""}

                        ${customer.status === "archived" ? `<button onclick="restoreCustomer(${customer.customer_id})">Restore</button>` : `<button onclick="archiveCustomer(${customer.customer_id})">Archive</button>`}

                    </td>

                </tr>

            `;

        });

    }
    catch (error) {

        console.error(
            "Unable to load customers.",
            error
        );

    }

}

// ==========================================
// SEARCH CUSTOMERS
// ==========================================

function searchCustomers() {

    const searchInput =
        document.getElementById(
            "searchCustomer"
        );

    const searchText =
        searchInput.value.toLowerCase();

    const rows =
        document.querySelectorAll(
            "#customerTableBody tr"
        );

    rows.forEach(row => {

        const rowText =
            row.textContent.toLowerCase();

        if (rowText.includes(searchText)) {

            row.style.display = "";

        }
        else {

            row.style.display = "none";

        }

    });

}

// ==========================================
// SAVE CUSTOMER
// ==========================================

async function saveCustomer() {

    const customerId =
        document.getElementById(
            "customerId"
        ).value;

    const customer = {
        customer_name: document.getElementById("customerName").value.trim(),
        contact_number: document.getElementById("contactNumber").value.trim(),
        city: document.getElementById("city").value,
        barangay: document.getElementById("barangay").value.trim(),
        zone: document.getElementById("zone").value.trim(),
        street: document.getElementById("street").value.trim(),
        house_number: document.getElementById("houseNumber").value.trim(),
        landmark: document.getElementById("landmark").value.trim(),
        customer_type: document.getElementById("customerType").value
    };

    if (!customer.customer_name) {

        alert(
            "Customer name is required."
        );

        return;

    }

    // The field shows +63 and takes 10 digits; it reads back as 09XXXXXXXXX.
    if (!/^09\d{9}$/.test(customer.contact_number)) {
        alert("Type the 10 digits of the mobile number after +63, starting with 9 (for example 9171234567).");
        document.getElementById("contactNumber").focus();
        return;
    }
    if (!customer.barangay || !customer.street || !customer.house_number) {
        alert("Barangay, street, and house/lot number are required for delivery.");
        return;
    }

    let url =
        "/api/customers/add";

    let method =
        "POST";

    // ==========================================
    // EDIT MODE
    // ==========================================

    if (customerId) {

        url =
            "/api/customers/update";

        method =
            "PUT";

        customer.customer_id =
            Number(customerId);

    }

    try {

        const response =
            await fetch(
                url,
                {

                    method: method,

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify(customer)

                }
            );

        const result =
            await response.json();

        alert(
            result.message
        );

        if (result.success) {

            loadCustomers();

            closeCustomerModal();

        }

    }
    catch (error) {

        console.error(
            "Unable to save customer.",
            error
        );

        alert(
            "Unable to save customer."
        );

    }

}

// ==========================================
// EDIT CUSTOMER
// ==========================================

async function editCustomer(customerId) {

    try {

        const response =
            await fetch(
                "/api/customers"
            );

        const customers =
            await response.json();

        const customer =
            customers.find(
                item =>
                    Number(item.customer_id) ===
                    Number(customerId)
            );

        if (!customer) {

            alert(
                "Customer not found."
            );

            return;

        }

        document
            .getElementById(
                "customerId"
            )
            .value =
            customer.customer_id;

        document
            .getElementById(
                "customerName"
            )
            .value =
            customer.customer_name;

        document
            .getElementById(
                "contactNumber"
            )
            .value =
            customer.contact_number || "";

        barangayPicker.set(customer.city || "Legazpi City", customer.barangay || "");
        document.getElementById("zone").value = customer.zone || "";
        document.getElementById("street").value = customer.street || "";
        document.getElementById("houseNumber").value = customer.house_number || "";
        document.getElementById("landmark").value = customer.landmark || "";

        document
            .getElementById(
                "customerType"
            )
            .value =
            customer.customer_type;

        document
            .getElementById(
                "customerModal"
            )
            .style.display =
            "block";

        document
            .getElementById(
                "saveCustomer"
            )
            .textContent =
            "Update Customer";

    }
    catch (error) {

        console.error(
            "Unable to edit customer.",
            error
        );

        alert(
            "Unable to load customer information."
        );

    }

}

// ==========================================
// ARCHIVE CUSTOMER
// ==========================================

async function archiveCustomer(customerId) {

    const confirmArchive =
        await olvConfirm(
            "Are you sure you want to archive this customer?",
            { ok: "Archive" }
        );

    if (!confirmArchive) {

        return;

    }

    try {

        const response =
            await fetch(
                "/api/customers/archive",
                {

                    method: "PUT",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:
                        JSON.stringify({

                            customer_id:
                                customerId

                        })

                }
            );

        const result =
            await response.json();

        alert(
            result.message
        );

        if (result.success) {

            loadCustomers();

        }

    }
    catch (error) {

        console.error(
            "Unable to archive customer.",
            error
        );

        alert(
            "Unable to archive customer."
        );

    }

}

async function restoreCustomer(customerId) {
    if (!(await olvConfirm("Restore this customer and make the record active again?", { ok: "Restore" }))) return;
    try {
        const response = await fetch("/api/customers/restore", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer_id: customerId }) });
        const result = await response.json();
        alert(result.message);
        if (result.success) loadCustomers();
    } catch (error) {
        console.error(error);
        alert("Unable to restore customer.");
    }
}

// ==========================================
// CLOSE CUSTOMER MODAL
// ==========================================

function closeCustomerModal() {

    document
        .getElementById(
            "customerModal"
        )
        .style.display =
        "none";

    document
        .getElementById(
            "customerId"
        )
        .value =
        "";

    document
        .getElementById(
            "customerName"
        )
        .value =
        "";

    document
        .getElementById(
            "contactNumber"
        )
        .value =
        "";

    barangayPicker.set("Legazpi City", "");
    document.getElementById("zone").value = "";
    document.getElementById("street").value = "";
    document.getElementById("houseNumber").value = "";
    document.getElementById("landmark").value = "";

    document
        .getElementById(
            "customerType"
        )
        .value =
        "Regular";

    document
        .getElementById(
            "saveCustomer"
        )
        .textContent =
        "Save";

}

// ==========================================
// SAVE BUTTON
// ==========================================

document
    .getElementById(
        "saveCustomer"
    )
    .addEventListener(
        "click",
        saveCustomer
    );

// ==========================================
// OPEN ADD CUSTOMER MODAL
// ==========================================

document
    .getElementById(
        "btnAddCustomer"
    )
    .addEventListener(
        "click",
        () => {

            closeCustomerModal();

            document
                .getElementById(
                    "customerModal"
                )
                .style.display =
                "block";

        }
    );

// ==========================================
// CANCEL BUTTON
// ==========================================

document
    .getElementById(
        "cancelCustomer"
    )
    .addEventListener(
        "click",
        closeCustomerModal
    );

// ==========================================
// SEARCH INPUT
// ==========================================

document
    .getElementById(
        "searchCustomer"
    )
    .addEventListener(
        "input",
        searchCustomers
    );

document.getElementById("customerStatusFilter")?.addEventListener("change", loadCustomers);

// ==========================================
// CREATE PORTAL LOGIN (customers without email)
// ==========================================

let loginCustomerId = null;
window.createCustomerLogin = customerId => {
    const customer = loadedCustomers.find(item => Number(item.customer_id) === Number(customerId));
    loginCustomerId = Number(customerId);
    document.getElementById("customerLoginForm").reset();
    document.getElementById("customerLoginFor").textContent = customer ? `For ${customer.customer_name} (${olvPhone(customer.contact_number) || "no contact number"})` : "";
    // Suggest a username from the name, e.g. "Maria Santos" -> "maria.santos".
    const suggestion = String(customer?.customer_name || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ñ/g, "n").replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "").slice(0, 28);
    document.getElementById("customerLoginUsername").value = suggestion.length >= 4 ? suggestion : "";
    document.getElementById("customerLoginMessage").textContent = "";
    document.getElementById("customerLoginDialog").showModal();
};
// A password that is easy to read aloud: Olv-Abcd-1234!
document.getElementById("customerLoginMakePassword").addEventListener("click", () => {
    const pick = (chars, count) => Array.from(crypto.getRandomValues(new Uint32Array(count)), n => chars[n % chars.length]).join("");
    document.getElementById("customerLoginPassword").value = `Olv-${pick("ABCDEFGHJKLMNPQRSTUVWXYZ", 1)}${pick("abcdefghijkmnpqrstuvwxyz", 3)}-${pick("23456789", 4)}!`;
});
document.getElementById("customerLoginCancel").addEventListener("click", () => document.getElementById("customerLoginDialog").close());
document.getElementById("customerLoginForm").addEventListener("submit", async event => {
    event.preventDefault();
    const message = document.getElementById("customerLoginMessage");
    const username = document.getElementById("customerLoginUsername").value.trim();
    const password = document.getElementById("customerLoginPassword").value;
    try {
        const response = await fetch("/api/customers/account/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer_id: loginCustomerId, username, password }) });
        const result = await response.json();
        if (!response.ok) { message.textContent = result.message || "Unable to create the login."; message.className = "small text-danger"; return; }
        document.getElementById("customerLoginDialog").close();
        alert(`${result.message}\n\nUsername: ${username}\nPassword: ${password}`);
        loadCustomers();
    } catch {
        message.textContent = "Unable to create the login. Check your connection and try again.";
        message.className = "small text-danger";
    }
});

// ==========================================
// START PAGE
// ==========================================

function initializeCustomers() {
    // Quick links from the dashboard menu: ?status=archived, ?action=add
    const params = new URLSearchParams(window.location.search);
    const statusFilter = document.getElementById("customerStatusFilter");
    if (statusFilter && ["active", "archived", "all"].includes(params.get("status"))) statusFilter.value = params.get("status");
    loadCustomers();
    if (params.get("action") === "add") {
        window.history.replaceState(null, "", window.location.pathname + (params.get("status") ? `?status=${params.get("status")}` : ""));
        document.getElementById("btnAddCustomer")?.click();
    }
}

initializeCustomers();
