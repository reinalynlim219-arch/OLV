# OLV Water Refilling Station — Panel Q&A Review

Likely panel questions with suggested answers, based on what the system actually does.
Answer in your own words; the numbers below are the real settings in the system.

---

## 1. Scope and objectives

**Q: What problem does the system solve?**
Before, the station tracked stock, orders and deliveries by hand or by memory. The system keeps
inventory, customer orders, deliveries, driver cash remittance and reports in one place, so the
owner can see what is in stock, what is ordered, and where each delivery is.

**Q: Who are the users?**
Four roles: **Admin** (owner — full access, users, reports, backups, activity log), **Staff**
(orders, customers, inventory, pickups), **Driver** (assigned deliveries, drop-off, cash collected),
and **Customer** (orders online, tracks deliveries, sees gallon status).

**Q: Your title says "real time". How is it real time?**
The main screens — dashboard, orders, inventory, stock movements, deliveries and the customer
portal — refresh their data automatically every 5 seconds. When staff update an order or a driver
marks a delivery, the customer and the admin see it within seconds without reloading the page.

**Q: Is Santo Domingo (or a far area) covered?**
No. The delivery coverage is the station's service area only; far areas are outside the scope.

---

## 2. Technology

**Q: What did you use to build it?**
Node.js for the server, SQLite for the database, HTML/CSS/JavaScript with Bootstrap 5 for the
screens. Passwords are protected with bcrypt. Emails are sent through Gmail.

**Q: Why SQLite and not MySQL?**
It is a single file, needs no separate database server, and fits one station's data. It runs in WAL
mode so reading and saving can happen at the same time, and simultaneous orders were tested to make
sure none fail or oversell stock.

**Q: Does it work without internet?**
Yes, at the station. The system runs on the station laptop, so staff can keep working offline.
Internet is only needed for customers ordering from outside, for emails, and for real road
distances in route planning (without it, the system uses straight-line distance, so planning still
works).

**Q: How do customers reach it online?**
Through a secure https address (ngrok tunnel) that points to the station laptop. The laptop must be
on and connected for customers to reach it.

---

## 3. Inventory

**Q: How does the system prevent overselling?**
Stock in pending orders is held (reserved). When an order is placed, the system checks the free
stock inside one database transaction, so two customers ordering the last gallons at the same time
cannot both succeed.

**Q: How do you know stock is running low?**
Each product has a minimum stock level. Products at or below it are flagged on the dashboard and in
inventory.

**Q: How do you track stock changes?**
Every stock in, stock out and order is recorded in Stock Movements, with who did it and when.

**Q: What is the price of a refill versus a new gallon?**
Each product has a refill price and an optional new gallon price. A customer who needs a new gallon
pays both — for example ₱35 refill + ₱100 gallon = ₱135. The order records which one was chosen.

**Q: How do you track the station's gallons?**
Two ways: the system counts new gallons each customer bought, and it keeps a lending record —
gallons lent and returned per customer. A return can't exceed what is still out. The Gallon Report
shows lent, returned, bought and still out.

---

## 4. Orders and pickup

**Q: Can a customer mark their own order as picked up?**
No. Only staff can confirm a pickup, so a customer can't close an order they didn't receive.

**Q: Can orders be cancelled?**
Yes, by the customer or staff while the order is still pending. The stock is released and the
customer gets an email.

**Q: Can staff mark a delivery order complete before it is delivered?**
No. A delivery order is completed only after the driver records the drop-off.

---

## 5. Delivery and routing

**Q: How do you plan deliveries?**
Orders are grouped into trips (batches) by vehicle capacity — default 50 gallons per trip. Each
trip visits the nearest stop first, then the next nearest, using real road distances from
OpenStreetMap (OSRM). Customers within the walking distance — default 100 m — are delivered on foot.
All of these settings can be changed by the admin.

**Q: Can the customer see when the delivery will arrive?**
Yes. The customer sees an estimated arrival based on the trip schedule (first trip 8:00, last trip
17:00, about 60 minutes per trip by default), and a timeline of every status change.

**Q: Why not live GPS tracking?**
Live GPS is outside the scope stated in our proposal. Tracking is shown as a status timeline
(e.g., scheduled → out for delivery → delivered), updated by the driver.

**Q: Is the nearest-first route the best possible route?**
It is a nearest-neighbor approach: fast and good for a small number of stops, though not always the
mathematically shortest route. For a station's daily deliveries it is practical.

---

## 6. Driver cash remittance

**Q: How do you handle the driver's cash?**
The driver records the cash collected at each drop-off. The Remittance Report shows what each
driver collected and must turn over, so cash can be checked against delivered orders.

**Q: Why cash only? Why no GCash?**
Payments are cash only within this project's scope. GCash or other online payments are a
recommended future feature, since a payment gateway needs a business account and fees.

---

## 7. Reports

**Q: What reports does the system produce?**
Inventory, Sales, Delivery, Customer, Transaction, Remittance and Gallon reports. Each can be
filtered by period (e.g., today, this week, this month), printed, exported as CSV, and a station
summary can be emailed.

---

## 8. Security

**Q: How are passwords protected?**
Passwords are never saved as plain text; they are hashed with bcrypt.

**Q: What if someone guesses passwords?**
After 5 wrong attempts on one account (or 20 from one device), sign-in is blocked for 15 minutes.

**Q: What if a user leaves the computer signed in?**
The system signs them out after 30 minutes of no activity, and after 12 hours at most.

**Q: Why email links instead of OTP?**
SMS is outside our scope and costs per message. Account confirmation and password reset use
emailed links that expire in 30 minutes and work only once. Email requests are limited to 5 per
15 minutes to stop abuse.

**Q: What if a customer has no email?**
Staff can create a login for that customer at the station.

**Q: Can you see who did what?**
Yes. The Activity Log (admin only) shows each action — who, their role, and when — for example
sign-ins, orders, stock changes and cancellations.

---

## 9. Data privacy (RA 10173)

**Q: How do you comply with the Data Privacy Act?**
The sign-up form shows a privacy notice explaining what data is collected (name, contact, address,
orders) and why (orders and deliveries). Customers must tick the consent box to register, and the
date of consent is saved. Data is only accessible to signed-in station users based on their role.
For road distances, only map coordinates are sent — never names or addresses.

---

## 10. Reliability and backups

**Q: What if the laptop breaks or the database gets damaged?**
The system makes an automatic backup every day and keeps the last 30 days. The admin can also click
"Back up now" on the dashboard and download a backup. To restore, the backup file replaces the
database.

**Q: What happens if the system hits an error?**
It keeps running; the error is saved in an error log for checking, so one problem doesn't shut down
the whole system.

---

## 11. Testing and evaluation

**Q: How did you test the system?**
Automated tests check every role's flows — orders, deliveries, accounts, emails, route planning and
the security fixes (including 111 browser checks, 80 audit checks and 45 route-planning checks). Then a pilot test with actual users and the System Usability Scale (SUS).

**Q: What was your SUS score?** *(fill in from your results)*
Our SUS score was ___, which is rated ___ (above 68 is above average).

---

## 12. Limitations and future work

**Q: What are the limitations?**
- No live GPS tracking — status timeline only.
- No SMS notifications — email only.
- Cash payments only — no GCash or online payment.
- Runs on the station laptop — online access needs the laptop on and connected.
- Route planning is nearest-first, not a guaranteed shortest route.
- One station only.

**Q: What would you add in the future?**
SMS notices, GCash payment, live GPS for drivers, a cloud server so the system doesn't depend on the
laptop, and a custom web address.
