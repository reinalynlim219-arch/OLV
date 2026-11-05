# OLV station system

This is a web-based capstone for managing the station's inventory, reusable containers, customers, orders, delivery records, and reports. It uses Node.js, SQLite, HTML, CSS, and browser JavaScript.

## Start

```powershell
npm.cmd install
npm.cmd start
```

Open the address printed by the server (normally `http://localhost:3000`). Existing database records are retained. Stop the old server before restarting it after code updates.

For verification services, copy `.env.example` to `.env`, enter your own provider settings, and run `npm.cmd run start:configured`. Without provider settings, existing logins work but new self-registration and password recovery report that verification is unavailable. Codes are not displayed on the website.

## Main workflows

- **Inventory:** maintain product records and record stock movement.
- **Containers:** register a unique tag, mark a container full, issue it to a customer, then record its return. Damaged containers can be repaired or retired. This does not change sellable product stock.
- **Customers → View history:** review orders, deliveries, payments, credit, and container issues/returns for one customer. Print the history if needed.
- **Customer portal:** place delivery/pickup orders, confirm receipt, and optionally attach a delivery photo.
- **Orders → Payments and credit:** record collected cash, review customer transfer evidence, approve credit terms, and print an acknowledgment for an approved payment.
- **Reports:** review inventory, customer, delivery, transaction, activity, and outstanding-credit records.
- **Manage Accounts:** administer staff and customer accounts separately on one page.

Delivery status, payment status, and physical-container status are separate records. A delivered order is not automatically paid. A returned empty container is not automatically a full product in stock.

## Check the work

```powershell
npm.cmd run check
npm.cmd run test:accounts-payments
npm.cmd run test:system
npm.cmd run test:browser
```

System tests create a temporary database and server. Browser tests use headless Chrome at the standard Windows installation path. They do not send live SMS/email or alter the live database. The latest completed system run is recorded in `miscellaneous/test-results/latest-system-check.json`.

## Read before the defense

- [Implementation and demonstration guide](miscellaneous/IMPLEMENTATION_AND_DEMO.md)
- [Verification/payment setup](miscellaneous/ACCOUNT_AND_PAYMENT_SETUP.md)
- [Proposal comparison](miscellaneous/CAPSTONE_SCOPE_REVIEW.md)
- [Owner acceptance checklist](miscellaneous/OWNER_ACCEPTANCE.md)

The new modules are organized by responsibility rather than placed inside the large existing server file. The original application still contains older callback-based code. This project has not been certified production-ready; owner acceptance and live messaging setup remain separate tasks.
