# Putting the system on your own website address (https://….com)

This gives the system a real address such as **https://olvwater.com** that customers
type or bookmark. It stays the same every time and has the padlock (https).

**How it works:** the station laptop still runs the system, as it does now. A free
Cloudflare *tunnel* connects your domain to the laptop. You only pay for the domain.

| What | Cost |
|---|---|
| A `.com` domain from Cloudflare | about US$10–11 per year, renewed yearly |
| Cloudflare tunnel and https | free |

**Keep in mind:** the laptop must stay on and connected, with `npm run online`
running, whenever customers use the website. If it is off, the website shows an error.

**Want it online even when the laptop is off?** Use a cloud server instead:
see `docs/cloud-hosting.md`. You only need steps 1–2 below (buying the domain) and
then step 7 of that guide.

---

## Step 1: Make a Cloudflare account

1. Go to **https://dash.cloudflare.com/sign-up** and sign up with the station's email.
2. Confirm the email Cloudflare sends you.

## Step 2: Buy the domain

1. In the Cloudflare dashboard, open **Domain Registration → Register Domains**.
2. Search for the name you want, for example `olvwater` or `olvrefilling`.
   Shorter is easier for customers to type.
3. Choose a `.com` that is available, then pay with a card or PayPal.
   Use the station owner's real name and details. They own the domain.
4. Wait until the domain shows as **Active**. This is usually a few minutes.

## Step 3: Create the tunnel

1. In the dashboard, open **Zero Trust**. If it asks you to pick a plan, choose the
   **Free** plan ($0). It may ask for a card even for the free plan.
2. Go to **Networks → Tunnels → Create a tunnel**.
3. Choose **Cloudflared**, name it `olv-station`, and click **Save tunnel**.
4. On the next page, choose **Windows**. You will see an install command with a long
   code in it, starting with `eyJ`. **Copy only that long code.** That is your
   *tunnel token*.
   - Do **not** run the install command. The system starts the tunnel by itself.
   - Keep the token secret. Anyone with it could take over your address.
5. Click **Next**. Under **Public hostname**, fill in:
   - **Subdomain:** leave empty
   - **Domain:** your domain, e.g. `olvwater.com`
   - **Service type:** `HTTP`
   - **URL:** `localhost:3000`
6. Click **Save**.
7. Optional: add a second public hostname with **Subdomain** `www` and the same
   service, so `www.olvwater.com` works too.

## Step 4: Put the two settings in `.env`

Open the `.env` file in the project folder with Notepad or VS Code. Add or fill in:

```
CLOUDFLARE_TUNNEL_TOKEN=paste-the-long-eyJ-code-here
SITE_URL=olvwater.com
```

Use your real domain for `SITE_URL`.

Then **empty the ngrok lines**, since you no longer use ngrok:

```
NGROK_AUTHTOKEN=
NGROK_URL=
```

Save the file.

## Step 5: Go online

In the project folder, run:

```
npm.cmd run online
```

After a short wait, it shows:

```
The system is ONLINE at:  https://olvwater.com
```

Open that address on your phone to check it works. Links in emails, such as
password resets and sign-in codes, now use this address too.

---

## If something goes wrong

| Message or problem | What to do |
|---|---|
| "fill in BOTH CLOUDFLARE_TUNNEL_TOKEN and SITE_URL" | One of the two is empty in `.env`. Fill in both. |
| "Use either your own domain … or ngrok …, not both" | Empty `NGROK_AUTHTOKEN` and `NGROK_URL` in `.env`. |
| "Cloudflare refused the tunnel token" | Copy the token again from **Zero Trust → Networks → Tunnels → olv-station → Configure**. |
| The website shows "Bad gateway" or error 502 | The system is not running on this laptop. Run `npm.cmd run online`. |
| The website shows error 1033 | The tunnel is not connected. Check the internet, then run `npm.cmd run online` again. |
| "Not going online: … easy default password" | Change that account's password in Manage Accounts first. |
| The token was shared by mistake | In the tunnel's page in Cloudflare, use **Refresh token**, then put the new one in `.env`. |

## Going back to a free address

To go back to the free address, empty `CLOUDFLARE_TUNNEL_TOKEN` and `SITE_URL` in
`.env`. The domain keeps working only while it is paid for.
