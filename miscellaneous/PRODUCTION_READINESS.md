# Production-readiness gap register

This file distinguishes features implemented in the local capstone from features that require deployment services, credentials, or a larger data model. Do not present an external integration as complete until it has been configured and tested.

| Gap | Local capstone status | What is needed for a real deployment |
|---|---|---|
| SMS and email OTP | Provider-backed registration and recovery implemented; no browser-visible demo codes | Twilio Verify credentials, SMS configuration, and SendGrid email sender/template; live delivery testing remains pending. See ACCOUNT_AND_PAYMENT_SETUP.md. |
| HTTPS | Server now supports PEM certificates through `HTTPS_KEY` and `HTTPS_CERT`; local HTTP remains the fallback | Trusted TLS certificate and reverse proxy (IIS, Nginx, or a managed host) |
| Persistent sessions | Sessions are in memory with expiry | SQLite/Redis session table, rotation, cleanup, and multi-process-safe storage |
| CSRF/rate limiting | SameSite cookies and authorization checks exist | CSRF token middleware plus per-IP/user login and API throttling |
| FIFO/weighted-average costing | Dashboard valuation uses current quantity × selling price | Cost-layer tables, receiving costs, issue-cost algorithm, and valuation reports |
| SKU/barcode/category/supplier | Basic product catalog exists | Product master migration, validation, barcode scanner/UI, and supplier screens |
| Batch/serial tracking | Not part of the current schema | Batch/serial tables, expiry rules, warranty fields, and stock allocation UI |
| Excel/PDF export | CSV export and printable reports are implemented and browser-tested | Native XLSX/PDF downloads remain optional additions |
| Browser and system tests | `npm run test:browser` uses a fresh SQLite database, a temporary HTTP server, and headless Chrome; results are saved in `test-results/latest-system-check.json` | Broader device coverage, CI execution, and actual owner acceptance remain |
| Scheduled email reports | Manual Email Inventory Summary uses the configured mailer; no scheduler is implemented | Configure credentials and authorized recipients, test actual delivery, then add a scheduler if required |
| Warehouse locations | Structured customer addresses exist | Facility/zone/aisle/bin tables and inventory-location allocation screens |

## Current verification

Run `npm run check` before a demonstration. It checks all project JavaScript syntax and required files. Manual browser testing should still cover registration, order choice (delivery/pickup), stock movement, delivery confirmation, reports, role restrictions, archive, and admin deletion.
