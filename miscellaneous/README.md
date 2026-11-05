# OLV Water Refilling Station System

A small web-based tracking and inventory system for OLV Water Refilling Station. It uses Node.js, SQLite, HTML, CSS, and browser JavaScript so it can run locally without a separate web server.

## Run the system

```powershell
npm install
npm run check
npm start
```

Open `http://localhost:3000/` in a browser. For VS Code debugging, use **Run and Debug** and select **Launch OLV System** (Microsoft Edge) or **Launch OLV System in Opera**.

If port 3000 is busy, stop the previous Node process or choose another port:

```powershell
$env:PORT = 3001
npm start
```

HTTPS is supported when PEM files are available. Set `HTTPS_KEY` and `HTTPS_CERT` to absolute file paths before starting; without them the app intentionally uses local HTTP.

## Main modules

- **Authentication** – login, logout, password hashing, sessions, and role checks.
- **Dashboard** – inventory, low-stock, order, and activity summaries.
- **Customers** – customer records, structured addresses, exact 11-digit contacts, archive/restore, and admin-only permanent deletion.
- **Inventory** – products, stock quantities, low-stock thresholds, and movement history.
- **Orders** – customer orders with stock validation and transaction history.
- **Scheduling / Delivery** – delivery details, status tracking, and delivery confirmation.
- **Reports** – inventory, sales, delivery, customer, credit/debit, and transaction reports.
- **Customer portal** – customer account registration, profile, orders, and delivery status.

## Roles

- **Admin:** full management access, including permanent deletion and user management.
- **Staff:** daily operations such as customers, inventory, orders, and deliveries; permanent deletion is blocked.
- **Customer:** customer portal only.

## Before presenting

1. Run `npm run check`.
2. Start with `npm start` and test one complete flow: customer → order → delivery → report.
3. Confirm the browser is using the same port shown in the terminal.
4. Explain that records with order history are archived instead of permanently deleted so reports remain accurate.

The `scripts/verify-system.js` pre-flight check is intentionally dependency-free and checks JavaScript syntax plus required project files.

See `PRODUCTION_READINESS.md` for the honest status and deployment prerequisites for advanced integrations.

For Gmail reports, copy `.env.example` to a private environment configuration and use a Gmail **App Password**, never your normal Gmail password. Keep that file out of source control.
