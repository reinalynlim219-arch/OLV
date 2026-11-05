(() => {
    // Every phone field ([data-phone-number]) works like Create account: +63 is fixed
    // in front, and only the 10 digits after it are typed (numbers only, starting with 9).
    // Pages keep reading and setting input.value in the saved 09XXXXXXXXX form: reading
    // gives "0" + the 10 digits, and setting "09…", "+63 9…" or "639…" shows the 10 digits.
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const toTen = value => {
        const compact = String(value ?? '').replace(/[\s-]/g, '');
        if (/^\+?639\d{9}$/.test(compact)) return compact.slice(-10);
        if (/^09\d{9}$/.test(compact)) return compact.slice(1);
        return compact;
    };
    const lettersMessage = 'Use numbers only (0–9). Letters and symbols are not allowed.';
    const lengthMessage = 'Type the 10 digits after +63, starting with 9 (for example 9171234567).';

    const style = document.createElement('style');
    style.textContent = `
        .phone63{display:flex;align-items:stretch;width:100%}
        .phone63-prefix{display:flex;align-items:center;padding:0 12px;border:1px solid #ced4da;border-right:0;background:#eef2f7;color:#334155;font-weight:700;white-space:nowrap}
        .phone63>input{flex:1 1 auto;min-width:0;width:auto!important;margin:0!important;border-top-left-radius:0!important;border-bottom-left-radius:0!important}
        html[data-theme="dark"] .phone63-prefix{background:#1e293b;color:#e2e8f0;border-color:#334155}`;
    document.head.appendChild(style);

    document.querySelectorAll('[data-phone-number]').forEach(input => {
        const look = getComputedStyle(input);
        const getRaw = () => native.get.call(input);
        const setRaw = value => native.set.call(input, value);

        // "+63" box in front, taking over the field's outer spacing and corners.
        const wrap = document.createElement('div');
        wrap.className = 'phone63';
        wrap.style.marginTop = look.marginTop;
        wrap.style.marginBottom = look.marginBottom;
        const prefix = document.createElement('span');
        prefix.className = 'phone63-prefix';
        prefix.id = `${input.id}Prefix`;
        prefix.textContent = '+63';
        prefix.style.borderColor = look.borderTopColor;
        prefix.style.borderTopLeftRadius = prefix.style.borderBottomLeftRadius = look.borderTopLeftRadius;
        input.before(wrap);
        wrap.append(prefix, input);

        const warning = document.createElement('div');
        warning.id = `${input.id}PhoneWarning`;
        warning.className = 'phone-number-warning';
        warning.setAttribute('role', 'alert');
        warning.hidden = true;
        wrap.insertAdjacentElement('afterend', warning);

        input.type = 'text';
        input.inputMode = 'numeric';
        input.autocomplete = 'tel-national';
        ['pattern', 'minlength', 'maxlength'].forEach(name => input.removeAttribute(name));
        if (!input.placeholder || /09X|^\+63/.test(input.placeholder)) input.placeholder = '9XXXXXXXXX';
        input.setAttribute('aria-describedby', [prefix.id, input.getAttribute('aria-describedby'), warning.id].filter(Boolean).join(' '));

        const current = getRaw();
        Object.defineProperty(input, 'value', {
            configurable: true,
            get() { const digits = getRaw(); return /^9\d{9}$/.test(digits) ? '0' + digits : digits; },
            set(value) {
                const ten = toTen(value);
                // An old saved number that is not a +63 mobile number (e.g. 12345678904)
                // is not put in the field, so there is room to type the correct one.
                if (ten && !/^9\d{9}$/.test(ten) && !input.readOnly && /^\d{7,}$/.test(ten)) {
                    setRaw('');
                    showWarning(`The saved number ${value} is not a valid mobile number. Type the correct 10 digits after +63.`);
                    return;
                }
                setRaw(ten);
                showWarning('');
            }
        });
        input.value = current;

        function showWarning(text) {
            warning.textContent = text;
            warning.hidden = !text;
            input.classList.toggle('phone-number-invalid', Boolean(text));
            input.setAttribute('aria-invalid', String(Boolean(text)));
        }
        function validate() {
            if (input.disabled || input.readOnly) { input.setCustomValidity(''); showWarning(''); return true; }
            const digits = getRaw();
            const error = (digits || input.required) && !/^9\d{9}$/.test(digits) ? lengthMessage : '';
            input.setCustomValidity(error);
            showWarning(error);
            return !error;
        }
        // While typing or pasting: keep digits only. A pasted "+63 917…", "63917…" or
        // "0917…" keeps just the 10 digits after the prefix.
        input.addEventListener('input', () => {
            const typed = getRaw();
            const digits = typed.replace(/\D/g, '').replace(/^(63|0)(?=9)/, '').slice(0, 10);
            showWarning(/[^\d+\s-]/.test(typed) ? lettersMessage : '');
            // Still invalid until all 10 digits are in (the message shows on leaving the field).
            input.setCustomValidity(/^9\d{9}$/.test(digits) || (!digits && !input.required) ? '' : lengthMessage);
            if (digits !== typed) setRaw(digits);
        });
        input.addEventListener('blur', () => { if (getRaw()) validate(); });
        input.addEventListener('invalid', validate);
        input.form?.addEventListener('submit', event => {
            if (!validate()) {
                event.preventDefault();
                event.stopImmediatePropagation();
                input.focus();
            }
        }, true);
        input.form?.addEventListener('reset', () => {
            input.setCustomValidity('');
            showWarning('');
        });
    });
})();
