# System review and code cleanup

## Changes verified

- Delivery scheduling: active staff/driver assignment is available in the form and visible in the list. Scheduled deliveries can be edited; completed/in-progress deliveries cannot be reset through that editor. The server derives customer and item details from the order, rejects invalid dates and assignees, excludes pickup/completed orders, and prevents duplicate active schedules.
- Driver access: drivers sign in to Deliveries, see only their assigned deliveries, and can start and record drop-off for those deliveries. Staff inventory, customer, account and financial APIs are blocked. Customer receipt confirmation remains separate from driver drop-off.
- Stock movements: concurrent stock-in requests no longer overwrite each other. Concurrent stock-out requests cannot withdraw more stock than is available. The manual adjustment and its history record are one database operation.
- Accounts: permanent customer deletion removes recovery contacts and revokes the customer's session. Customer username limits now agree across registration and editing (3?32 allowed characters). Existing email verification tests remain passing.
- Reports: all six report buttons use one script. CSV export includes displayed rows, quotes values correctly and neutralizes spreadsheet formula prefixes. Printing and manual email inventory summaries remain available. A slow previous report request cannot replace a newer selection.
- Customer portal: Daraga and Legazpi City, order selection, pickup/delivery receipt, optional photo, credit and payment ownership checks remain covered by regression tests. Customer/driver access to the public PWA files is allowed.

## Code map

| File | Responsibility |
|---|---|
| routes/deliverySchedule.js | Validate and save delivery schedules without changing fulfillment status |
| routes/stockMovements.js | Save manual stock movements with atomic stock updates |
| public/js/deliveries.js | Render deliveries, select assignees, dispatch and record drop-off |
| public/js/reports.js | Load report data, render tables, export CSV, print and request email |
| routes/accountVerification.js | Register/recover accounts and clean up deleted-account contacts |

The long duplicate stock-in/out and delivery-edit handlers were removed from app.js. Reports previously had an unused external script and a separate inline implementation; the page now uses one external file. The changes use named functions, ordinary conditionals, and comments explaining business rules.

## Database compatibility

On startup, stockMovements adds inventory_movements.apply_stock (default 0) and two SQLite triggers. Only the new manual adjustment route sets this flag to 1. Order completion already changes stock and keeps the default, so it is not deducted twice. The triggers validate available stock and update inventory in the same statement that writes the movement record. Account verification installs a trigger that deletes recovery contacts when a customer account is deleted. Existing records are preserved.

## Test evidence

- npm run test:browser: 85 checks passed on a fresh temporary database, including concurrent stock writes, cross-driver access, the actual delivery editor button, all report screens and CSV output.
- npm run check: 35 JavaScript files and 13 required files passed.
- Account/payment, customer-email, and customer-account suites passed. Messaging uses a simulated provider.
- Latest evidence: test-results/latest-system-check.json. Tests do not seed or edit the live database.

## Remaining work and limits

Real SMS/email delivery requires provider credentials and an authorized recipient test. Owner acceptance and deployment checks are still outstanding. Sessions and pending verification requests remain in memory; restart signs users out and expires pending verification. The separate production-readiness register lists deployment work and optional features outside the original capstone scope. This review does not claim every possible defect has been eliminated or that the full legacy backend has been rewritten.

Restart the running Node server to load backend changes. Review the flows with real station staff before deployment.
