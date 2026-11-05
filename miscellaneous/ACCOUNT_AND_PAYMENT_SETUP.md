# Account verification, payments, and credit

## What changed

Registration and recovery use real verification codes. The application no longer shows a demo OTP or resets a password just because someone knows a phone number. A registration is saved only after the provider approves the code.

Payments are independent of delivery. A received order is not automatically paid. Customers submit GCash or bank-transfer references and JPEG receipts. Staff verify the transfer against the station's actual account before approval. Cash is recorded by staff after collection. This is manual payment recording, not a payment gateway.

Staff can approve credit terms with a due date and note. Partial approved payments reduce the balance. The Credit report includes only orders explicitly approved for credit, and removes settled balances. Old orders without ledger entries show “No verified payment”; do not assume those customers owe money without reconciling historical receipts.

## Configure real SMS and email

1. Create a Twilio account and Verify service. Enable SMS destinations for the Philippines. Trial accounts may restrict which recipients can receive messages.
2. To use email, configure a SendGrid sender and verification email template in that Verify service. Email is sent through Twilio Verify's email channel, not the existing Gmail report mailer.
3. Copy `.env.example` to `.env`. Enter `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID`. Keep `.env` private.
4. Set `GCASH_PAYMENT_INSTRUCTIONS` and `BANK_PAYMENT_INSTRUCTIONS` to the station's actual public payment instructions. Without these, customers are told to contact the station.
5. Run `npm.cmd run start:configured` to load `.env`. Plain `npm start` uses environment variables already set in the shell.
6. Test registration using a real phone and then a real email. Test wrong codes, correct codes, recovery, and session logout. Provider fees may apply. No live messages were sent during development checks.

References: [Twilio Verify](https://www.twilio.com/docs/verify/api/verification), [checking a code](https://www.twilio.com/docs/verify/api/verification-check).

If credentials are absent, registration and recovery return a “not configured” message. Existing logins still work. There is no fake-code fallback. Old pending demo registrations can be reviewed by an administrator in Manage Accounts; they are not automatically marked verified.

Email recovery works for customer emails verified at registration. Existing staff accounts use their stored mobile number for SMS recovery; staff email enrollment is not included. Shared phone numbers are not eligible for automatic recovery when they identify more than one account. Verification tickets expire after ten minutes or a server restart. Request limits and tickets are in memory; deployment across multiple servers needs shared storage.

## Demonstrate payment and credit

1. Create an order in the customer portal. Scroll to Payments and credit.
2. Submit a transfer receipt and reference. The amount is awaiting verification, not paid yet.
3. As staff, open Orders and find Payments and credit. View proof, then approve or reject with a reason.
4. Record a cash payment only after receiving the cash. Partial payments are supported.
5. For an agreed unpaid balance, approve credit with a due date and note. Open the Credit report to see the outstanding amount.
6. Record the remaining amount and verify that the balance is zero and no longer in the outstanding-credit report.

Payment records keep who recorded/reviewed them and the review time. Approved entries cannot be edited or deleted in this release; refunds and correcting approved entries require a separate controlled workflow. Credit terms cannot be changed after approval in this release.

Payment-proof uploads currently accept JPEG up to 650 KB. They are separate from delivery receipt photos. A photo alone is not payment verification.

## Code map for the defense

| File | Responsibility |
|---|---|
| `app.js` | Starts the server and directs requests to the existing modules and new routes. |
| `routes/accountVerification.js` | Validates signup/recovery, limits attempts, stores short-lived verification tickets, updates accounts. |
| `utils/verification.js` | Converts mobile numbers to international format and calls Twilio Verify. |
| `routes/payments.js` | Stores the payment ledger, restricts access, validates balances, approves payments and credit. |
| `public/js/payments.js` | Displays payment balances, forms, proof links, and staff review actions. |
| `public/js/scripts.js` | Connects the login, registration, and recovery forms to the server. |

Amounts are stored in integer centavos to avoid adding fractional currency values. Only approved payments reduce the balance. Pending amounts reserve the remaining payable amount so the same balance cannot be submitted twice. A single SQL insert checks that limit when writing the payment.

Customer access is checked on the server, not only by hiding buttons. Passwords use bcrypt hashes. OTP values are checked by the provider and are not returned to the browser or logged by the app. Successful recovery invalidates that account's sessions.

The new modules are separated by purpose, and an abandoned commented-out order implementation was removed. The rest of the system keeps its existing structure; it has not been completely rewritten. Review the code, run the examples, and explain what each step does in your own words. Follow your school's rules on acknowledging assistance.

## Checks

- `npm.cmd run check`: project JavaScript syntax and required files, now including route and utility modules.
- `npm.cmd run test:accounts-payments`: isolated in-memory payment/account tests; messaging is mocked, no SMS/email is sent.
- Browser checks still needed: real SMS/email delivery, camera/file selection on the target phones, and full customer-to-staff payment review with the configured provider.

Existing sales reports still total completed orders, not collected cash. Compare the payment ledger separately when discussing collections. Automated bank matching, refunds, interest, credit limits, and SMS payment reminders are outside this implementation.

## Customer email administration

Manage Accounts shows each customer's email, verification status, and email search. In Edit customer account, enter an email, select Send verification code, then enter the code the customer received and select Verify and save email. This saves the email separately from username/password/status changes. The existing recovery email remains in use until verification succeeds.

An optional email entered during SMS registration is retained as unverified. It cannot be used for recovery until verified. Verified addresses cannot be shared with another account. Recovery requests made against an older email are rejected after the address changes. Customers and staff cannot call the admin email-change endpoints.

The route is in routes/customerEmail.js; the interface is in public/js/customer-accounts.js. Run npm run test:customer-email for isolated tests with a simulated provider. Real email delivery still requires Twilio Verify email configuration and an authorized recipient test. No real messages were sent during automated tests.
