# CRUD.chat mobile apps (iOS + Android)

The apps are a native shell (Capacitor 8) around **https://crud.chat/app**. Everything you ship to the
website reaches the apps immediately, so you don't need a store update. A new store build is only needed when
something in this folder changes: the icon, permissions, version or native plugins.

What the shell adds on top of the website:
- an app icon, a splash screen, and a friendly offline screen (`www/offline.html`);
- native permission prompts for the microphone (voice notes), camera and photos (screenshots);
- haptics, and an Android back button that closes sheets first;
- invite links (`crud.chat/app/...`) that open in the app, once the app-link settings below are set;
- **in-app purchases** of Pro through the App Store / Google Play (StoreKit 2 in `ios/App/App/StorePlugin.swift`,
  Play Billing in `android/.../StorePlugin.java`). Razorpay never appears inside the apps. A workspace is Pro
  however it was paid for (website, App Store or Google Play).

App ID: `chat.crud.app` · Name: **CRUD.chat**

## Build it

| | Android | iOS |
|---|---|---|
| On your computer | Android Studio (Windows, Mac or Linux): `npm ci && npx cap sync android && npx cap open android` | A Mac with Xcode 16+: `npm ci && npx cap sync ios && npx cap open ios` |
| In the cloud | GitHub → **Actions → Mobile apps → Run workflow**. Download the APK artifact; the signed Play bundle is built too once the secrets below are set | The same workflow checks that the iOS app compiles. Uploading to the App Store needs Xcode, or Xcode Cloud or Codemagic connected to this repo |

After changing the icon: put new 1024px images in `assets/`, then run `npm run assets` and `npx cap sync`.

## Before you submit (both stores)

1. **Voice notes need server transcription.** The in-app browser on iOS and Android has no built-in speech
   recognition, so set `OPENAI_API_KEY` (or `SARVAM_API_KEY` for Hinglish) on Railway.
2. **Reviewer login.** Login is an emailed code, which reviewers can't receive. Set
   `REVIEW_LOGIN=review@crud.chat:246810` on Railway (use your own 6-digit code). That email then logs in with
   that code and no email is sent. Give both values to Apple and Google in the review notes, and put a little
   sample data in that account's workspace.
3. **Account deletion** is built in (menu → Delete account), with a public page at https://crud.chat/delete-account.
4. **Privacy policy:** https://crud.chat/privacy · **Support:** https://crud.chat/contact

## Google Play

1. Create a developer account at play.google.com/console (US$25, one-time).
   **Important:** new *personal* accounts must run a closed test with at least 12 testers for 14 days before they
   can publish to everyone. *Organisation* accounts skip this, but need a D-U-N-S number. Plan for this.
2. Create the upload key **once**, on your own computer, and back it up somewhere safe. If you lose it, you have
   to ask Google to reset it.
   ```
   keytool -genkeypair -v -keystore crud-upload.jks -alias crud -keyalg RSA -keysize 2048 -validity 10000
   ```
3. In GitHub → Settings → Secrets and variables → Actions, add:
   `ANDROID_KEYSTORE_BASE64` (output of `base64 -w0 crud-upload.jks`), `ANDROID_KEYSTORE_PASSWORD`,
   `ANDROID_KEY_ALIAS` (`crud`) and `ANDROID_KEY_PASSWORD`.
4. Run the **Mobile apps** workflow and download `crud-chat-play-bundle` (`app-release.aab`).
5. In Play Console: create the app → upload the bundle to **Internal testing** first → fill in the
   **Store listing** (screenshots, short and full description), **Data safety**, **Content rating**,
   **Target audience** (18+, business), **Privacy policy URL** and the **Account deletion URL**
   (https://crud.chat/delete-account).
   - Data safety, roughly: collects **email**, **name**, **user content** (messages, photos, audio, files) and
     **app activity**. Used for app functionality and account management. Shared with service providers
     (Anthropic for AI, OpenAI or Sarvam for transcription, Razorpay for payments, Railway for hosting).
     Encrypted in transit. Users can request deletion.
6. App links: in Play Console → **App integrity**, copy the *App signing key* SHA-256 fingerprint and set
   `ANDROID_CERT_SHA256` on Railway. https://crud.chat/.well-known/assetlinks.json then serves it.

## iOS builds with Codemagic (no Mac needed)

`codemagic.yaml` (repo root) builds the iOS app on Codemagic's Macs, signs it and uploads it to TestFlight.
One-time setup:
1. **Apple Developer** → Certificates, Identifiers & Profiles → **Identifiers → +** → App IDs → App → Bundle ID
   (explicit) `chat.crud.app`, description "CRUD.chat". Leave the default capabilities (In-App Purchase is included).
2. **App Store Connect → My Apps → + New App**: iOS, name *CRUD.chat*, bundle ID `chat.crud.app`, SKU `crudchat`.
3. **App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → +**:
   name "Codemagic", access **App Manager**. Download the `.p8` file (only possible once) and note the
   **Issuer ID** and **Key ID**.
4. **codemagic.io** → sign up with GitHub → **Add application** → GitHub → `hello-world` → choose
   *codemagic.yaml* as the configuration.
5. Codemagic → **Team settings → Team integrations → Developer Portal → Connect**: name it exactly
   `CRUD App Store Connect`, then enter the Issuer ID and Key ID and upload the `.p8`.
6. Codemagic → **Team settings → codemagic.yaml settings → Code signing identities**:
   - **iOS certificates → Generate certificate**: type *Apple Distribution*, using the key above. Give it any
     reference name.
   - **iOS provisioning profiles → Fetch profiles**. If none is listed: in Apple Developer → **Profiles → +** →
     *App Store Connect* → App ID `chat.crud.app` → pick the certificate Codemagic just made → name
     "CRUD App Store" → Generate. Then **Fetch profiles** again and add it.
7. **Start new build** → branch `crud-chat-backend` → workflow **iOS → TestFlight**. About 15 minutes later the build
   appears in App Store Connect → TestFlight (after Apple's processing, usually 15–30 minutes).

### Share Extension (one-time Apple setup)

"Share to CRUD.chat" on iPhone is a Share Extension (`ios/App/ShareExtension`, bundle ID `chat.crud.app.share`).
It saves what was shared into an App Group that the app reads, so both App IDs need that group:
1. Apple Developer → **Identifiers → +** → **App Groups** → description "CRUD.chat", identifier `group.chat.crud.app`.
2. **Identifiers → chat.crud.app** → tick **App Groups** → **Configure** → tick `group.chat.crud.app` → Continue → **Save**.
3. **Identifiers → +** → App IDs → App → description "CRUD.chat Share", Bundle ID (explicit) `chat.crud.app.share` →
   tick **App Groups** → Configure → tick `group.chat.crud.app` → Continue → Register.
4. **Profiles**: open "CRUD App Store" → **Edit** → **Save** (it was invalidated by step 2) and download nothing.
   Then **+** → *App Store Connect* → App ID `chat.crud.app.share` → the same certificate → name "CRUD Share App Store" → Generate.
5. Codemagic → **Team settings → Code signing identities → iOS provisioning profiles → Fetch profiles** → add both
   profiles (remove the old, invalid one).
6. Start a new build.

On Android nothing extra is needed: the share-intent filters are in `AndroidManifest.xml` (see `ShareInPlugin.java`).

For each App Store release, bump `APP_VERSION` in `codemagic.yaml`. Build numbers count up by themselves.
Invite links that open the app (Associated Domains) are a later step: enable the capability on the App ID, then
ask for the entitlement to be added to the project.

## Apple App Store

1. Enrol in the Apple Developer Program at developer.apple.com (US$99 a year). Individuals can enrol right away.
   A company needs a D-U-N-S number.
2. Build and upload with Codemagic (section above), or on a Mac: `npx cap open ios` → **App** target →
   **Signing & Capabilities** → choose your Team → Product → Archive → Distribute App.
3. Set `APPLE_TEAM_ID` on Railway (Membership page of your developer account), so
   https://crud.chat/.well-known/apple-app-site-association lists the app.
4. Test it with TestFlight, then submit for review.
5. In App Store Connect: fill in **App Privacy** (same answers as Play's data safety), the category
   (Business / Productivity), screenshots (6.9" iPhone), the support URL, the privacy policy URL, and the
   review notes with the reviewer login.
   - Guideline 4.2 (minimum functionality): mention in the review notes that the app records voice notes with
     the microphone, reads photos and screenshots with the camera and photo library, and works as a shared team
     database with live sync.

## In-app purchases (Pro through the stores)

How it works: the app buys `chat.crud.pro.monthly` tagged with the workspace id. Our server checks the purchase
with Apple or Google and switches that workspace to Pro (the same records as Razorpay). Renewals, cancellations,
billing problems and refunds arrive as server notifications. Code: `src/domain/iap.ts`, `src/routes/iap.ts`.

**App Store Connect**
1. **Business → Agreements**: accept the *Paid Apps Agreement* and fill in bank and tax details (W-8BEN as a
   non-US individual). Purchases don't work, even in testing, until it's active.
2. Apply for the **App Store Small Business Program** (15% instead of 30%).
3. Your app → **Monetization → Subscriptions**: create a subscription group ("CRUD.chat Pro"), then a subscription
   with product ID **`chat.crud.pro.monthly`**, duration 1 month, price ₹499 (Apple sets other countries' prices;
   adjust if you like). Add its display name and description, and a review screenshot of the subscribe screen.
4. **App Information**: copy the *Apple ID* (a number) → set `APPLE_APP_ID` on Railway.
5. **App Store Server Notifications** (App Information): Production and Sandbox URLs are both
   `https://crud.chat/api/iap/apple/notifications`, Version 2.
6. Testing: **Users and Access → Sandbox → Test accounts**, then sign in with that account on the iPhone under
   Settings → App Store → Sandbox Account. TestFlight builds use the sandbox automatically. Sandbox months last minutes.
7. When submitting the app version, attach the subscription to it ("In-App Purchases and Subscriptions").

**Google Play Console**
1. **Monetize → Payments profile**: set it up with your bank account.
2. **Monetize → Products → Subscriptions**: create **`chat.crud.pro.monthly`**, add a base plan (ID `monthly`,
   auto-renewing, 1 month, ₹499) and **activate** it. Products can only be created after you upload a build that
   includes billing (the bundle from the workflow does).
3. **Google Cloud** (console.cloud.google.com), in one project:
   - enable the **Google Play Android Developer API**;
   - create a **service account** and a **JSON key** → paste the whole JSON as one line into
     `GOOGLE_PLAY_SERVICE_ACCOUNT` on Railway;
   - in Play Console → **Users and permissions**, invite the service account's email with *View financial data*
     and *Manage orders and subscriptions* (it can take up to a day to start working);
   - **Pub/Sub**: create a topic (e.g. `play-billing`) and grant `google-play-developer-notifications@system.gserviceaccount.com`
     the *Pub/Sub Publisher* role on it. Add a **push subscription** to the topic with the endpoint
     `https://crud.chat/api/iap/google/notifications?token=YOUR_SECRET`, and set `GOOGLE_RTDN_TOKEN=YOUR_SECRET` on Railway.
4. Play Console → **Monetization setup**: enter the topic name (`projects/<project-id>/topics/play-billing`) and
   send a test notification.
5. Testing: **Settings → License testing**, add your Google account. Test purchases aren't charged and renew every few minutes.

**What people see in the app**: the store price, Subscribe, the renewal terms Apple requires, Terms and Privacy
links, and Restore purchases. Once subscribed: *Manage subscription*, which opens the store's own screen. A
workspace that pays on the website shows as Pro with no purchase buttons. Deleting an account doesn't stop store
billing (the delete screen says so), because only the person can cancel it in their store account.

## Versions

CI sets `versionCode` to the workflow run number. For a public release, set `APP_VERSION_NAME`
(for example `1.0.1`) in the workflow, or bump it in Xcode for iOS.
