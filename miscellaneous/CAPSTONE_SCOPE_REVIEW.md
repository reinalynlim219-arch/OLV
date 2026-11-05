# Capstone scope comparison — 21 September 2026

Follow-up: container status/history, a staff customer-history page, printable payment acknowledgments, activity writes, and isolated browser/system checks have since been implemented. See `IMPLEMENTATION_AND_DEMO.md` and `test-results/latest-system-check.json`. The gap table below records the earlier review; live verification and owner acceptance still require external completion.

This review compares the text of `My_Capstone_File.pdf` with the current source code. The desktop attachment and `miscellaneous/My_Capstone_File.pdf` have identical SHA-256 hashes. Page references below use PDF viewer page numbers, with printed page numbers where helpful.

The YouTube link could not be retrieved. No findings in this review are attributed to that video. Diagram captions were extracted, but the individual shapes and arrows have not been visually audited. Source-code presence is not proof that every workflow has passed a live browser or user acceptance test.

## What the proposal actually requires

PDF pages 9–11 (printed pages 4–6) specify inventory management, inventory tracking, customer records and transaction history, reports, scheduling/monitoring, secure login, and an easy-to-use interface. The principal roles in the scope are administrator and staff.

| Requirement | Current implementation | Remaining work or evidence |
|---|---|---|
| Inventory CRUD and stock monitoring | Product/inventory routes, stock-in/out, minimum stock checks, dashboard and movement history exist. | Demonstrate that counts, movements, and reports agree after a full test scenario. |
| Gallon/container status tracking | Products and stock quantities exist. A dedicated container lifecycle or customer return ledger was not found. | Define whether containers are full, empty, issued, returned, or damaged; add only the states the station actually uses. This is the clearest functional gap against the objective on PDF page 9. |
| Customer records and transaction history | Customer details, orders, reports, portal orders, and the new payment ledger exist. | A staff-facing customer detail page consolidating that customer's orders, deliveries, payments, and returns was not found. Existing reports cover some of this, so this is a usability/completeness gap rather than wholly absent transaction data. |
| Scheduling and monitoring | Delivery scheduling, assignments, status changes, receipt confirmation, and optional receipt photos exist. | Demonstrate scheduled → out for delivery → awaiting customer → received/completed; test pickup separately. |
| Report generation | Inventory, customer, sales/order, delivery, transaction, and credit report paths exist. | Reconcile each report with known test records. Explain that completed-order sales differ from money collected. |
| Secure authorized access | Role checks, bcrypt passwords, sessions, and updated verification/recovery routes exist. | Real SMS/email provider configuration and live verification tests remain outstanding; review role boundaries in the final acceptance test. |
| Usable web interface | Responsive pages and recent customer/staff account improvements exist. | Collect actual owner/staff feedback and record fixes. Syntax checks alone do not establish usability. |

## Scope conflicts to resolve in the manuscript

PDF page 12 (printed page 7) explicitly excludes GPS-based real-time delivery tracking, online payment integration, advanced accounting/payroll/financial reporting, a dedicated mobile app, SMS notifications, chat/messaging, and GCash payment processing.

- Do not label those exclusions as missing mandatory features merely because another system demonstrates them.
- Current payment functions record cash/transfers and manually review evidence. They do not charge a customer or integrate a GCash/bank payment gateway. Document this distinction.
- SMS verification is narrower than delivery/payment SMS notifications, but the manuscript should explicitly describe it if retained. The integration was added at the user's request after the original proposal; it was not a documented original requirement.
- Customer self-service and the driver role extend the admin/staff scope. Reconcile the role table, use cases, DFDs, database design, and limitations if these additions are retained.
- Saving a location for delivery confirmation is not a live vehicle-tracking map. Describe what the implementation actually does.
- Existing additions have not been removed by this review. The proposal is reference material, not an instruction to undo subsequently requested work.

## Interview requests versus formal scope

PDF page 73 (printed page 68) records the owner's interest in inventory/container reports, sales, credit/debt lists, delivery reports, and receipts. The new credit ledger addresses part of that interview request. A printable, numbered transaction/payment receipt was not found; uploading proof is not the same as issuing a receipt.

The interview also requests notifications, but the limitations section deliberately excludes them. Keep that distinction clear during the defense rather than presenting every interview suggestion as approved scope.

## Testing and documentation priorities

PDF pages 27–28 (printed pages 22–23) promise functional, reliability, integration, and system testing. Automated syntax and isolated payment/account tests now exist. They are useful checks, but do not replace a completed test-case log and owner/staff acceptance evidence.

Prepare a table with test ID, requirement, inputs, expected result, actual result, pass/fail, evidence, and tester/date. Do not invent results. Cover:

1. Login and role restrictions, invalid phones, wrong verification codes, and account recovery.
2. Inventory stock-in/out, insufficient stock, and matching movement totals.
3. Customer order selection, delivery and pickup completion, and optional receipt photos.
4. Payment submission, proof review, rejected transfers, partial payments, and credit settlement.
5. Report totals reconciled against the same test data.
6. Mobile layout, network failure messages, and restart behavior.

An activity-log report is present, but a corresponding `INSERT INTO activity_logs` writer was not found in the reviewed application source. Check whether it receives real events before demonstrating it. This is an implementation consistency issue; the proposal's core objectives do not explicitly demand a comprehensive audit trail.

## Recommended order of work

1. Confirm and implement the station's gallon/container status and return workflow.
2. Add a consolidated staff customer-history view.
3. Add a printable receipt if retained as an agreed interview requirement.
4. Reconcile the manuscript/diagrams with the approved additions and exclusions.
5. Complete and document end-to-end and user acceptance testing.

The aim is a defensible match between the proposal, the running system, and the evidence—not matching every feature in an unrelated demonstration video.
