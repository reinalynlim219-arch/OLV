# Panelist-style system audit

This is a practical review of the current local capstone build. “Open” items are deployment or future-scope concerns, not hidden claims that the system is perfect.

## Addressed in this pass

- JavaScript syntax and required-file check: `npm run check`.
- Admin-only customer and product deletion is enforced by the server, not only by hiding a button.
- Customer records with order history are protected from permanent deletion; Archive preserves reports.
- Responses now include basic browser safety headers (`nosniff`, frame protection, referrer policy, and a same-origin CSP).
- Port can be changed with `PORT`, which prevents debug sessions from colliding with another local server.
- Run/debug instructions and role boundaries are documented in `README.md`.
- Shared keyboard focus states and a consistent blue/white theme were applied to the shared, customer, and delivery interfaces.
- Reports now have one working Back to Dashboard control under the description; the removed hidden duplicate no longer causes a null-element JavaScript error.
- Admins now have a clearly labeled User Management entry on the dashboard for creating staff accounts.
- Staff Orders no longer shows a misleading “+ New Order” button; customer orders are submitted through the customer portal.

## Remaining panel questions and honest answers

| Concern | Current status | Recommended answer or next step |
|---|---|---|
| HTTPS | Not enabled for local development | Use HTTPS/reverse proxy when deployed publicly. |
| In-memory sessions | Sessions disappear when Node restarts | Suitable for a single-PC capstone; use a persistent session store in production. |
| CSRF protection | SameSite cookies reduce risk, but no token system | Add CSRF tokens before public deployment. |
| Rate limiting | No distributed rate limiter | Add login/API throttling for an internet-facing deployment. |
| Audit trail | Business tables retain timestamps; not every action has a user audit event | Add an audit log if the panel requires who/when for every change. |
| Pagination | Tables load all rows | Add pagination when the database becomes large. |
| Notifications | No email/SMS integration | Outside the local capstone scope unless explicitly required. |
| Automated browser tests | Pre-flight checks are included; full E2E tests still require a browser | Demonstrate the documented customer → order → delivery → report flow manually. |
| Order-to-delivery link | Delivery scheduling now requires/selects an available order and auto-fills the customer, contact, item, and address details. Existing legacy deliveries can still be edited. | Keep the documented customer → order → delivery workflow for demonstrations. |
| Contact verification | Registration verification is implemented for the local system | A real SMS/OTP provider is still needed for production verification. |
| Delivery vs pickup | Orders now record `delivery` or `pickup`; delivery requires a saved address and appears in Delivery Management, while pickup has no delivery fee and is completed by the customer. | Demonstrate both choices and explain the different completion paths. |
| Data backup | SQLite file is local | Copy the database before demonstrations and schedule backups for production. |

## Demonstration checklist

1. Sign in as admin and show user management plus permanent delete restrictions.
2. Sign in as staff and show daily operations; confirm Delete is unavailable/forbidden.
3. Create a customer with exactly 11 digits and show invalid contact validation.
4. Create an order, confirm stock changes, schedule delivery, and update delivery status.
5. Open each report and verify it reflects the transaction.
6. Run `npm run check` before presenting.
