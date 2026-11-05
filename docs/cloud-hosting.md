# Running the system online 24/7 (cloud server)

This moves the OLV system to a cloud server at **Render** (render.com). It stays
online day and night, even when the station laptop is off. Staff, drivers and
customers use it from any phone or computer.

You will get an address like `https://olv-water.onrender.com` right away. Later you
can add your own `.com` (step 7).

| What | Cost |
|---|---|
| Render server (Starter plan) | about US$7 per month |
| Saved disk for the database (1 GB) | about US$0.25 per month |
| Your own `.com` (optional, step 7) | about US$10–11 per year |

**Laptop or cloud, not both.** After the move, everyone uses the cloud address.
Do **not** keep taking orders on the laptop too, or the orders end up in two
separate places.

---

## Before you start

- Every staff, admin and driver account must have a strong password. The cloud
  server will not start while any account uses an easy one, like `admin123`.
- Have your Gmail details from `.env` ready (`GMAIL_USER`, `GMAIL_APP_PASSWORD`,
  `REPORT_RECIPIENT`). The cloud server needs them to send sign-in codes and emails.

## Step 1: Put the code on GitHub (private)

Render takes the code from GitHub. Your **database and `.env` are not uploaded**:
the project's `.gitignore` keeps them on the laptop.

1. Make a free account at **https://github.com/signup**.
2. Install **GitHub Desktop** from https://desktop.github.com and sign in.
3. Choose **File → Add local repository**, then pick the project folder
   `olv_tracking_and_inventory_system`. When it says it is not a repository yet,
   click **create a repository**, then **Create repository**.
4. Look at the list of files. `.env` and `database/olv_database.db` must **not** be
   in it. If they are, stop and ask for help.
5. Click **Publish repository**. Keep **"Keep this code private" ticked**.

## Step 2: Make an upload key

The upload key is a secret, used once to send your data to the new server. On the
laptop, in the project folder, run:

```
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Copy the long code it prints. Then open `.env` and add it:

```
OLV_IMPORT_TOKEN=paste-the-code-here
```

## Step 3: Create the server on Render

1. Sign up at **https://dashboard.render.com/register**. Choose **Sign up with GitHub**.
2. Click **New → Blueprint**, pick your `olv_tracking_and_inventory_system`
   repository, and click **Connect**.
3. Render reads the project's `render.yaml` file and asks for these values:

   | Setting | What to type |
   |---|---|
   | `OLV_IMPORT_TOKEN` | the same code as in step 2 |
   | `GMAIL_USER` | same as in `.env` |
   | `GMAIL_APP_PASSWORD` | same as in `.env` |
   | `REPORT_RECIPIENT` | same as in `.env` |
   | `SITE_URL` | leave empty for now |

4. Click **Apply**. Render asks for a card for the Starter plan.
5. Wait for the build, about 3–5 minutes. Under **Logs** you should see:
   `No data yet. Waiting for the station's data upload`
6. Copy your address at the top of the page, e.g. `https://olv-water.onrender.com`.

## Step 4: Stop taking orders on the laptop

Close the system on the laptop: stop `npm run online` or `node app.js`. From now on
the cloud is the real system.

## Step 5: Send your data to the server

On the laptop, in the project folder, run (with **your** address):

```
npm.cmd run cloud:upload -- https://olv-water.onrender.com
```

It shows `Received … MB. The system is starting.` and then `Done.`

Open the address. You should see the OLV homepage. Click **Sign in** and use your
usual username and password. All customers, orders, stock and accounts are there.

Then, on Render, open **Environment**, delete `OLV_IMPORT_TOKEN`, and save.

## Step 6: Tell everyone the new address

Give staff, drivers and customers the new address. Customers sign in with the same
accounts as before.

## Step 7 (optional): Use your own .com

1. Buy the domain (see `docs/own-domain-setup.md`, steps 1–2).
2. On Render, open your service, then **Settings → Custom Domains → Add**, and type
   `olvwater.com`. Add `www.olvwater.com` too.
3. Render shows one or two records to add. In Cloudflare, open your domain, go to
   **DNS → Records**, and add each one exactly as shown. Set **Proxy status** to
   **DNS only** (grey cloud).
4. Wait until Render shows **Verified** and **Certificate issued**. This takes a few
   minutes to an hour.
5. On Render, open **Environment**, set `SITE_URL` to `olvwater.com`, and save.
   Links in emails now use your own address.

If you set up the laptop tunnel for the same domain before, first delete that
tunnel's public hostname in Cloudflare (**Zero Trust → Networks → Tunnels**).

---

## Updating the system later

1. Change the code on the laptop and test it.
2. In GitHub Desktop, write a short summary, then click **Commit** and **Push origin**.
3. Render updates the server by itself in a few minutes. **The data stays safe** on
   the saved disk. Everyone is signed out once and signs in again.

## Backups

- The system saves a backup every day on the server's disk (`/var/data/backups`).
- Render also keeps snapshots of the disk, under **Disks** in your service.

## If something goes wrong

| Problem | What to do |
|---|---|
| Log says "There is no database on the server yet" | `OLV_IMPORT_TOKEN` is missing on Render. Add it, then do step 5. |
| Upload says "Wrong upload key" | The key in `.env` and on Render differ. Copy it again exactly. |
| Upload says "already has data" | The server already has its data. Nothing more to upload. |
| Log says "Not starting: … easy default password" | The upload was set aside. Change that password on the laptop, then do step 5 again. |
| Emails are not sent | Check the Gmail settings on Render under **Environment**. |
