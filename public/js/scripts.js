const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");
const recoveryForm = document.getElementById("recoveryForm");
const resetForm = document.getElementById("resetForm");
const checkEmailPanel = document.getElementById("checkEmailPanel");
const formMessage = document.getElementById("formMessage");
const pageParams = new URLSearchParams(window.location.search);
const resetToken = pageParams.get("reset") || "";

// Results of links opened from an email (see /verify-email).
const notices = {
    registered: ["Email confirmed. Your account is active, so you can sign in now.", "success"],
    email_changed: ["Email address confirmed and saved.", "success"],
    link_invalid: ["This link is invalid, expired, or already used. Please request a new one."],
    username_taken: ["That username was taken before you confirmed. Please register again with another username."],
    email_taken: ["That email is already used by another account."],
    verify_failed: ["We could not confirm your email. Please try again."]
};

function setLoginPasswordVisible(visible) {
    const password = document.getElementById("password");
    const toggle = document.getElementById("togglePassword");
    if (!password || !toggle) return;
    password.type = visible ? "text" : "password";
    // Closed eye while hidden, open eye while shown (see password-eye.js).
    if (window.OLVPasswordEye) window.OLVPasswordEye.paint(toggle, visible);
    else {
        toggle.setAttribute("aria-pressed", String(visible));
        toggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
        toggle.title = visible ? "Hide password" : "Show password";
    }
}

document.getElementById("togglePassword")?.addEventListener("click", () => {
    setLoginPasswordVisible(document.getElementById("password").type === "password");
});
loginForm?.addEventListener("reset", () => setLoginPasswordVisible(false));

// Messages pop up in the middle of the screen (olvPopup, theme.js), so on the long
// sign-up form a problem is never out of sight (pressing a button never seems to do nothing).
function showMessage(message, type = "danger") {
    formMessage.className = "alert d-none";
    window.olvPopup(message, type);
}

function hideMessage() {
    formMessage.className = "alert d-none";
    formMessage.textContent = "";
}

// Shows one panel of the page and hides the others.
function showPanel(panel) {
    for (const element of [loginForm, registerForm, recoveryForm, resetForm, checkEmailPanel]) {
        element?.classList.toggle("d-none", element !== panel);
    }
    document.getElementById("showRecovery")?.classList.toggle("d-none", panel !== loginForm);
    document.querySelector(".account-switch")?.classList.toggle("d-none", panel !== loginForm);
    // Each view shows only its own form: sign-in links to "Create account",
    // sign-up links back with "I already have an account".
    const [title, subtitle] = panel === registerForm
        ? ["Create your account", "Order purified water online and follow every delivery."]
        : panel === checkEmailPanel ? ["Check your email", "One more step: enter the 6-digit code we sent you."]
        : panel === loginForm ? ["Welcome to OLV", "Sign in to order water, follow your delivery, or manage the station."]
        : ["Your OLV account", "Recover access to your account."];
    const titleEl = document.getElementById("authTitle");
    if (titleEl) { titleEl.textContent = title; document.getElementById("authSubtitle").textContent = subtitle; }
}

function showLoginForm() {
    setLoginPasswordVisible(false);
    showPanel(loginForm);
    hideMessage();
}

function showRegisterForm() {
    showPanel(registerForm);
    hideMessage();
}

function passwordIsStrong(password) {
    return password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /[0-9]/.test(password) && /[^A-Za-z0-9]/.test(password);
}

async function postJSON(url, body) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const result = await response.json();
    return { ok: response.ok && result.success, result };
}

// After a successful sign-in, ask the browser to show its own "Save your password?"
// prompt (Edge and Chrome; the browser decides, and the person can choose Not now).
// Only on https or localhost; other browsers offer it on their own after the sign-in.
async function offerToSavePassword() {
    if (!window.PasswordCredential || !window.isSecureContext) return;
    try {
        const credential = new PasswordCredential({
            id: document.getElementById("username").value.trim(),
            password: document.getElementById("password").value,
            name: document.getElementById("username").value.trim()
        });
        await Promise.race([navigator.credentials.store(credential), new Promise(resolve => setTimeout(resolve, 1500))]);
    } catch { /* the browser declined; signing in still works */ }
}

async function openHome(user) {
    await offerToSavePassword();
    window.location.href = user.role === "customer" ? "/customer-portal" : user.role === "driver" ? "/delivery" : "/dashboard";
}

// The 6-digit code step. `purpose` is "signin" or "register".
let codeStep = null;
function showCodeStep(purpose, result) {
    codeStep = { purpose, ticket: result.otp_ticket };
    document.getElementById("codeTitle").textContent = purpose === "signin" ? "Enter your sign-in code" : "Confirm your email";
    document.getElementById("verificationNotice").textContent = result.message;
    document.getElementById("otpCode").value = "";
    showPanel(checkEmailPanel);
    hideMessage();
    document.getElementById("otpCode").focus();
}
document.getElementById("otpCode")?.addEventListener("input", event => {
    event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
});
checkEmailPanel?.addEventListener("submit", async event => {
    event.preventDefault();
    const code = document.getElementById("otpCode").value.trim();
    if (!/^\d{6}$/.test(code)) return showMessage("Enter the 6-digit code from the email.");
    const button = checkEmailPanel.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const { ok, result } = await postJSON(codeStep.purpose === "signin" ? "/login/verify" : "/register/verify", { otp_ticket: codeStep.ticket, code });
        if (!ok) return showMessage(result.message || "Wrong code.");
        if (codeStep.purpose === "signin") return openHome(result.user);
        showLoginForm();
        document.getElementById("username").value = result.username || "";
        showMessage(result.message, "success");
    } catch (error) {
        console.error(error);
        showMessage("Unable to connect to the server.");
    } finally {
        button.disabled = false;
    }
});
document.getElementById("resendCode")?.addEventListener("click", async event => {
    event.target.disabled = true;
    try {
        const { ok, result } = await postJSON(codeStep.purpose === "signin" ? "/login/resend" : "/register/resend", { otp_ticket: codeStep.ticket });
        showMessage(result.message || "Unable to send a new code.", ok ? "info" : "danger");
    } catch {
        showMessage("Unable to connect to the server.");
    } finally {
        setTimeout(() => { event.target.disabled = false; }, 30000);
    }
});

loginForm?.addEventListener("submit", async event => {
    event.preventDefault();
    try {
        const { ok, result } = await postJSON("/login", {
            username: document.getElementById("username").value.trim(),
            password: document.getElementById("password").value
        });
        if (ok && result.otp_required) {
            showCodeStep("signin", result);
        } else if (ok) {
            await openHome(result.user);
        } else {
            showMessage(result.message || "Invalid username or password.");
        }
    } catch (error) {
        console.error(error);
        showMessage("Unable to connect to the server.");
    }
});

document.getElementById("showRegister")?.addEventListener("click", showRegisterForm);
document.getElementById("showLogin")?.addEventListener("click", showLoginForm);
document.getElementById("backToLoginFromEmail")?.addEventListener("click", showLoginForm);
document.getElementById("showRecovery")?.addEventListener("click", () => {
    showPanel(recoveryForm);
    hideMessage();
});
document.getElementById("showLoginFromRecovery")?.addEventListener("click", showLoginForm);

// Step 1 of recovery: email a reset link.
recoveryForm?.addEventListener("submit", async event => {
    event.preventDefault();
    const email = document.getElementById("recoveryEmail");
    if (!email.value.trim() || !email.checkValidity()) return showMessage("Enter a valid email address.");
    const button = recoveryForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const { ok, result } = await postJSON("/account/recover/request", { email: email.value.trim() });
        if (!ok) return showMessage(result.message || "Unable to send the reset link.");
        recoveryForm.reset();
        showMessage(result.message, "info");
    } catch (error) {
        console.error(error);
        showMessage("Unable to connect to the account recovery service.");
    } finally {
        button.disabled = false;
    }
});

// Step 2 of recovery: opened from the emailed link (/login?reset=...).
resetForm?.addEventListener("submit", async event => {
    event.preventDefault();
    const password = document.getElementById("recoveryPassword").value;
    const confirmPassword = document.getElementById("recoveryConfirmPassword").value;
    if (!passwordIsStrong(password)) return showMessage("Password is not strong enough.");
    if (password !== confirmPassword) return showMessage("Passwords do not match.");
    try {
        const { ok, result } = await postJSON("/account/recover", { reset_token: resetToken, password, confirm_password: confirmPassword });
        if (!ok) return showMessage(result.message || "Unable to reset password.");
        resetForm.reset();
        window.history.replaceState(null, "", "/login");
        showLoginForm();
        document.getElementById("username").value = result.username || "";
        showMessage(result.message, "success");
    } catch (error) {
        console.error(error);
        showMessage("Unable to connect to the account recovery service.");
    }
});

document.getElementById("registerPassword")?.addEventListener("input", event => {
    const text = document.getElementById("passwordStrength");
    text.textContent = passwordIsStrong(event.target.value)
        ? "Strong password."
        : "Use 8+ characters with uppercase, lowercase, number, and special character.";
    text.className = passwordIsStrong(event.target.value) ? "form-text text-success" : "form-text text-danger";
});

document.getElementById("registerConfirmPassword")?.addEventListener("input", event => {
    const password = document.getElementById("registerPassword").value;
    const match = document.getElementById("passwordMatch");
    if (!event.target.value) {
        match.textContent = "";
    } else if (event.target.value === password) {
        match.textContent = "Passwords match.";
        match.className = "form-text text-success";
    } else {
        match.textContent = "Passwords do not match.";
        match.className = "form-text text-danger";
    }
});

// Barangay search box follows the chosen city (Legazpi City or Daraga).
// Barangay drop-down: only the barangays of the chosen city (Legazpi City or Daraga);
// changing the city refills the list and clears the old choice.
const registerBarangayPicker = window.OLVBarangays?.bind(document.getElementById("registerCity"), document.getElementById("registerBarangay"));
// With a search box: typing part of the name narrows the list (e.g. "raw" -> Rawis).
window.OLVSelectSearch?.searchable(document.getElementById("registerBarangay"), { placeholder: "Type your barangay, e.g. Rawis" });
const registerAddressError = document.getElementById("registerAddressError");
function showAddressError(text) {
    if (!registerAddressError) return;
    registerAddressError.textContent = text;
    registerAddressError.hidden = !text;
}
["registerStreet", "registerHouseNumber", "registerLandmark", "registerBarangay"].forEach(id =>
    document.getElementById(id)?.addEventListener("input", () => showAddressError("")));

// Contact number: +63 is fixed, so only the 10 digits after it are typed.
// Letters and symbols are removed as they are typed or pasted; at most 10 digits.
const registerContact = document.getElementById("registerContact");
function contactProblem(digits) {
    if (!digits) return "Enter the 10 digits of your mobile number after +63.";
    if (!/^\d+$/.test(digits)) return "Use numbers only (0–9). Letters and symbols are not allowed.";
    if (digits.length !== 10) return `Enter exactly 10 digits after +63 (you typed ${digits.length}).`;
    if (!digits.startsWith("9")) return "A Philippine mobile number after +63 starts with 9, for example 9171234567.";
    return "";
}
function showContactWarning(text) {
    const warning = document.getElementById("registerContactWarning");
    if (!warning) return;
    warning.textContent = text;
    warning.hidden = !text;
    registerContact.classList.toggle("phone-number-invalid", Boolean(text));
    registerContact.setAttribute("aria-invalid", String(Boolean(text)));
}
registerContact?.addEventListener("input", () => {
    let value = registerContact.value;
    // A pasted "+63 917…", "63917…" or "0917…" keeps just the 10 digits after the prefix.
    // (The 10-digit limit is applied here, after cleaning, so pasted spaces or a +63
    // do not use up the room.)
    const digitsOnly = value.replace(/\D/g, "");
    const cleaned = digitsOnly.replace(/^63(?=9\d{9}$)/, "").replace(/^0(?=9\d{9}$)/, "").slice(0, 10);
    // A pasted "+63", spaces or dashes are simply removed; letters and other symbols get a warning.
    if (/[^\d+\s-]/.test(value)) showContactWarning("Use numbers only (0–9). Letters and symbols are not allowed.");
    else showContactWarning("");
    if (cleaned !== value) registerContact.value = cleaned;
});
registerContact?.addEventListener("blur", () => { if (registerContact.value) showContactWarning(contactProblem(registerContact.value)); });

registerForm?.addEventListener("submit", async event => {
    event.preventDefault();
    const typedContact = document.getElementById("registerContact").value.trim();
    const contactError = contactProblem(typedContact);
    if (contactError) { showContactWarning(contactError); document.getElementById("registerContact").focus(); return showMessage(contactError); }
    // Saved in the system's usual form: 09XXXXXXXXX (the same number as +63 9XXXXXXXXX).
    const contact = "0" + typedContact;
    const email = document.getElementById("registerEmail");
    const password = document.getElementById("registerPassword").value;
    const confirmPassword = document.getElementById("registerConfirmPassword").value;
    const city = document.getElementById("registerCity").value;
    const barangay = window.OLVBarangays?.matchBarangay(city, document.getElementById("registerBarangay").value) || "";
    if (!barangay) {
        const text = `Choose a barangay of ${city} from the list.`;
        showAddressError(text);
        document.getElementById("registerBarangay").focus();
        return showMessage(text);
    }
    const addressParts = {
        street: document.getElementById("registerStreet").value.trim(),
        house_number: document.getElementById("registerHouseNumber").value.trim(),
        landmark: document.getElementById("registerLandmark").value.trim()
    };
    const addressProblem = window.OLVBarangays?.checkAddressParts(addressParts) || "";
    if (addressProblem) {
        showAddressError(addressProblem);
        return showMessage(addressProblem);
    }
    if (!email.value.trim() || !email.checkValidity()) return showMessage("Enter a valid email address.");
    if (!passwordIsStrong(password)) return showMessage("Password is not strong enough.");
    if (password !== confirmPassword) return showMessage("Passwords do not match.");
    if (!document.getElementById("registerConsent").checked) return showMessage("Please read the privacy notice and tick the box to agree before creating your account.");
    const button = registerForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
        const { ok, result } = await postJSON("/register", {
            email: email.value.trim(),
            full_name: document.getElementById("registerName").value.trim(),
            contact_number: contact,
            city,
            barangay,
            ...addressParts,
            username: document.getElementById("registerUsername").value.trim(),
            password,
            confirm_password: confirmPassword,
            privacy_consent: document.getElementById("registerConsent").checked
        });
        if (!ok) return showMessage(result.message || "Unable to create account.");
        document.getElementById("username").value = document.getElementById("registerUsername").value.trim();
        registerForm.reset();
        registerBarangayPicker?.set(document.getElementById("registerCity").value, "");
        showAddressError("");
        showCodeStep("register", result);
    } catch (error) {
        console.error(error);
        showMessage("Cannot reach the system right now, so the account was not created. Check that the system is running, then press Create account again.");
    } finally {
        button.disabled = false;
    }
});

if (resetToken) {
    showPanel(resetForm);
} else if (notices[pageParams.get("notice")]) {
    const [text, type] = notices[pageParams.get("notice")];
    showLoginForm();
    showMessage(text, type);
    window.history.replaceState(null, "", "/login");
} else if (pageParams.get("tab") === "register") {
    // "Create account" on the homepage opens this tab directly.
    showRegisterForm();
}
