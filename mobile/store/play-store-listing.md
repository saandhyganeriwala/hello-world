# Google Play listing: CRUD.chat (step by step, copy and paste)

Work through the parts in order. Play Console's left sidebar and its **Dashboard** checklist show the same tasks.
Allow about 2–3 hours, plus Google's waiting times (account verification and the testing period).

---

## Part A — Accounts (once)

1. **Developer account**: go to play.google.com/console, sign up as **Personal** and pay US$25 (one-time).
   Google verifies your identity (ID document) and phone number. This can take a few days.
2. **Payments profile** (needed to sell the Pro subscription): Play Console → **Settings → Payments profile**.
   Use your legal name and address (903, Raheja Willows, Lokhandwala, Kandivali East, Mumbai 400101), add your
   bank account, and fill in the tax information. Google holds payouts until the bank account is verified.

> **Personal accounts must test first.** For accounts created after November 2023, Google requires a **closed
> test with at least 12 testers who stay opted in for 14 days in a row** before you can apply for production. The
> Dashboard shows the exact requirement for your account. Start the closed test (Part F) as soon as you can,
> because the 14 days run while you finish everything else.

---

## Part B — Build the signed app bundle (once, about 10 minutes)

Google Play needs an **.aab** file signed with your *upload key*. Our GitHub workflow builds it once four secrets
are set.

1. **Create the upload key** on your Mac. Open **Terminal** (Spotlight → "Terminal") and paste these lines one at a
   time. Replace `CHOOSE-A-PASSWORD` with a strong password and keep it somewhere safe:
   ```
   cd ~/Desktop
   openssl req -x509 -newkey rsa:2048 -keyout crud-key.pem -out crud-cert.pem -days 10000 -nodes -subj "/CN=CRUD.chat/O=Crud/C=IN"
   openssl pkcs12 -export -in crud-cert.pem -inkey crud-key.pem -name crud -out crud-upload.jks -passout pass:CHOOSE-A-PASSWORD
   base64 -i crud-upload.jks | pbcopy
   ```
   The last line copies the key file, encoded as text, to your clipboard.
   **Back up `crud-upload.jks` and the password**, for example in a password manager. You need them for every
   update. (If you lose them, Google can reset the upload key, but it takes days.) Then delete `crud-key.pem` and
   `crud-cert.pem`.
2. **Add the four secrets**: GitHub → your `hello-world` repo → **Settings → Secrets and variables → Actions →
   New repository secret**:

   | Name | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | paste (the clipboard from step 1) |
   | `ANDROID_KEYSTORE_PASSWORD` | your password |
   | `ANDROID_KEY_ALIAS` | `crud` |
   | `ANDROID_KEY_PASSWORD` | the same password |

3. **Build**: GitHub → **Actions → Mobile apps → Run workflow** (branch `crud-chat-backend`). After about 5 minutes,
   open the finished run and download the **crud-chat-play-bundle** artifact. Unzip it to get `app-release.aab`.
   Every run gets a higher version code automatically.

---

## Part C — Create the app

Play Console → **Create app**:
- App name: `CRUD.chat: Business Records`
- Default language: English (India) – en-IN, or English (United States)
- App or game: **App**
- Free or paid: **Free** (Pro is an in-app subscription)
- Tick both declarations → **Create app**

---

## Part D — Store listing (Grow → Store presence → Main store listing)

**App name (30):** `CRUD.chat: Business Records`

**Short description (80):**
```
Record orders, payments and leads by text, voice or screenshot. No spreadsheets.
```

**Full description (4000):**
```
CRUD.chat is the simplest way for a small team to keep its business records, without spreadsheets.

Record anything the way you'd tell a colleague: type a message, send a voice note or share a screenshot. "Order from Kashish, 45 boxes at 500 each, deliver Hyderabad" becomes an order with the customer, quantity, amount and delivery filled in. A screenshot of a customer's WhatsApp message, a bill or a PDF invoice is read for you.

EVERYTHING IN ITS PLACE
• Sections such as Orders, Payments, Leads, Tasks and Inventory appear automatically from what you record
• See each section the way that suits it: list, table, pipeline board, calendar, chart, ledger or tracker
• Edit any record right where you see it
• Share photos, PDFs and Excel files into CRUD.chat from any app, and pick the workspace
• Import Excel or CSV files, and export to CSV or Excel any time

JUST ASK
• "How much is pending from Hotel Orchid?" or "Top customers this month?", answered from your own records
• Change the app by asking: "show leads as a pipeline", "add a chart of sales by product", or describe any view you want and CRUD.chat builds it

BUILT FOR TEAMS
• Invite your team with a link; everyone sees changes instantly
• Messages in English or Hinglish
• Works on Android, iPhone and in any browser at crud.chat

PLANS
• Free: try it with free AI actions, up to 3 people in a workspace. Viewing, editing and searching are always free.
• CRUD.chat Pro (monthly subscription, renews automatically): up to 10 people in the workspace and a generous monthly AI allowance (fair use).

The subscription is charged to your Google Play account and renews every month until cancelled. Cancel any time in Google Play → Payments & subscriptions → Subscriptions. Each workspace has its own plan.

Privacy Policy: https://crud.chat/privacy
Terms: https://crud.chat/terms
```

**Graphics** (all files are in the repo under `mobile/store/`):

| Field | File | Size |
|---|---|---|
| App icon | `play-icon-512.png` | 512 × 512 |
| Feature graphic | `play-feature-graphic.png` | 1024 × 500 |
| Phone screenshots (upload all 6, in order) | `v2/android-phone/1-message.png` … `6-team.png` | 1080 × 1920 |
| 7-inch tablet screenshots (optional, recommended) | `v2/android-tablet-7/1-…6-…png` | 1200 × 1920 |
| 10-inch tablet screenshots (optional, recommended) | `v2/android-tablet-10/1-…6-…png` | 1600 × 2560 |

Leave the video field empty. Click **Save**.

**Store settings** (Grow → Store presence → Store settings):
- App category: **Business**
- Tags: pick up to 5, e.g. *Business*, *Productivity*, *Small business*, *Sales & CRM*, *Office tools*
- Contact email: `login@crud.chat` · Phone (optional): `+91 70037 05584` · Website: `https://crud.chat`

---

## Part E — App content (Policy → App content). Answer each section:

1. **Privacy policy:** `https://crud.chat/privacy`
2. **App access:** *All or some functionality is restricted* → **Add instructions**:
   - Name: `Demo login`
   - Username: the email part of `REVIEW_LOGIN` on Railway (e.g. `review@crud.chat`)
   - Password: the 6-digit code part of `REVIEW_LOGIN`
   - Other information:
     `Enter the email, tap Continue, then enter the 6-digit code as the login code. No email is sent for this demo account. Try: type "Order from Ravi, 10 boxes at 500 each, paid", tap the mic for a voice note, or share a screenshot.`
3. **Ads:** *No, my app does not contain ads*
4. **Content rating:** start the questionnaire → email `login@crud.chat` → category **"All other app types"**
   (or *Productivity/Utility*, whichever is offered).
   - Violence, sexuality, language, controlled substances, gambling: **No** to all.
   - "Can users interact or exchange content with other users?" **Yes** (team members in a workspace chat and share records).
   - "Does the app share the user's current physical location?" **No**.
   - "Does the app allow users to purchase digital goods?" **Yes**.
   - "Is it a web browser or search engine?" **No**.
   Submit to get the ratings. Expect *3+ / Everyone*, possibly with "Users interact" and "In-app purchases" labels.
5. **Target audience and content:** age group **18 and over** only. "Could it unintentionally appeal to children?" **No**.
6. **News app:** **No**
7. **Data safety:** see Part E1 below.
8. **Government app:** **No** · **Financial features:** *My app doesn't provide any financial features*
   (it records the team's own payments but doesn't move money, lend or invest) · **Health:** none.
9. **Advertising ID:** *No, my app doesn't use advertising ID*.

### Part E1 — Data safety form

**Overview:**
- Does your app collect or share any of the required user data types? **Yes**
- Is all of the user data collected by your app encrypted in transit? **Yes**
- Do you provide a way for users to request that their data is deleted? **Yes**, at `https://crud.chat/delete-account`
  (and in the app: Menu → Delete account)
- Third-party services that process data for us (AI, email, hosting) count as **service providers**, not sharing, so
  answer **No** to "shared" for every type.

**Data types: tick these, and for each one choose Collected = Yes, Shared = No, Processed ephemerally = No (unless noted):**

| Category → type | Required or optional | Purposes |
|---|---|---|
| Personal info → **Name** | Required | App functionality, Account management |
| Personal info → **Email address** | Required | App functionality, Account management |
| Financial info → **Purchase history** | Optional | App functionality |
| Photos and videos → **Photos** (screenshots people share) | Optional | App functionality |
| Audio → **Voice or sound recordings** (voice notes; **Processed ephemerally: Yes**, they're turned into text and not kept) | Optional | App functionality |
| Files and docs → **Files and docs** (PDFs, Excel/CSV) | Optional | App functionality |
| Messages → **Other in-app messages** (team chat) | Optional | App functionality |
| App activity → **Other user-generated content** (records) | Optional | App functionality |
| App activity → **App interactions** (anonymous visit counts) | Required | Analytics |

Leave everything else unticked: location, contacts, calendar, device IDs, health, web browsing, crash logs.
Review → **Submit**.

---

## Part F — Testing tracks

1. **Internal testing** (instant, up to 100 testers): Test and release → Testing → **Internal testing → Create new
   release**. Accept **Play App Signing** (recommended), upload `app-release.aab`, release name `1.0.0 (N)`.
   Release notes:
   ```
   <en-IN>
   First release of CRUD.chat: record orders, payments and leads by text, voice or screenshot.
   </en-IN>
   ```
   **Save → Review release → Start rollout**. Under **Testers**, create an email list with your own Gmail
   addresses, then open the **join link** on your Android phone and install from Play.
2. **Closed testing** (the 12 testers × 14 days requirement): **Closed testing → Create track** (or use "Alpha"),
   **Countries/regions**: India (plus any others), **Testers**: an email list or a Google Group with **at least
   12 people** (friends, family, early users, each with a Google account on an Android phone). Upload the same
   `.aab` (or promote the internal release) → Start rollout → send testers the opt-in link. They must **opt in and
   keep the app installed for 14 days**. Ask them to open it a few times; Google looks at engagement.
3. After 14 days: Dashboard → **Apply for production** → answer the short questionnaire about your test.

---

## Part G — The Pro subscription (Monetize with Play → Products → Subscriptions)

You can create it once a release with Play Billing (any of the above) has been uploaded.
1. **Create subscription**: Product ID `chat.crud.pro.monthly` (must be exactly this, since the app asks for it),
   Name `CRUD.chat Pro`.
2. **Benefits** (shown to buyers, up to 4): `Up to 10 people in the workspace` · `Monthly AI allowance for messages,
   voice and screenshots` · `All views, imports and exports` · `Each workspace has its own plan`.
3. **Description**: `Pro plan for one CRUD.chat workspace, billed monthly.`
4. **Add base plan**: ID `monthly`, type **Auto-renewing**, billing period **1 month**, grace period **3 days**,
   account hold on (default). **Set prices**: India ₹499 → **Update other prices** from it (or set the US at US$5.99)
   → Save → **Activate** the base plan.
5. **Server-side checks.** These let the server confirm purchases and renewals; full detail is in
   `mobile/README.md` → "In-app purchases":
   - Google Cloud Console (same Google account): create a project → enable **Google Play Android Developer API** →
     **Service accounts → Create** (no roles) → **Keys → Add key → JSON** → open the file and paste its whole text
     into Railway variable `GOOGLE_PLAY_SERVICE_ACCOUNT`.
   - Play Console → **Users and permissions → Invite new users** → the service account's email → app permissions:
     *View financial data* and *Manage orders and subscriptions* → Invite.
   - **Pub/Sub** (Google Cloud): create topic `play-billing`; add principal
     `google-play-developer-notifications@system.gserviceaccount.com` with role *Pub/Sub Publisher*; create a
     **push** subscription to `https://crud.chat/api/iap/google/notifications?token=YOUR_SECRET`, and set Railway
     variable `GOOGLE_RTDN_TOKEN` to the same secret.
   - Play Console → **Monetize with Play → Monetization setup** → Topic name `projects/<project-id>/topics/play-billing`
     → Save → **Send test notification** (you should see it arrive in the Railway logs).
6. **Test a purchase**: Play Console → **Settings → License testing** → add your Gmail. On your phone, install from
   the internal-test link → Plan & usage → **Upgrade this workspace**. License testers aren't charged, and test
   subscriptions renew every few minutes.

---

## Part H — Production

1. **Test and release → Production → Countries/regions**: add India (and others you want).
2. **Create new release** → **Add from library** (pick the tested bundle) → release notes as above →
   **Review release → Start rollout to Production**. You can start with a staged rollout (e.g. 20%).
3. Google reviews in a few hours to about 7 days. You'll get an email.
4. After it's live: Play Console → **Test and release → App integrity → App signing** → copy the **SHA-256** of the
   *App signing key certificate* → set Railway variable `ANDROID_CERT_SHA256`. Invite links (crud.chat/app/join/…)
   then open the app directly.

## For every update
Run the **Mobile apps** workflow → download the new `.aab` → Production (or a testing track) → Create new release
→ upload → release notes → rollout.
