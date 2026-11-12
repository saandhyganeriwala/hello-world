# CRUD.chat mobile apps (iOS + Android)

The apps are a native shell (Capacitor 8) around **https://crud.chat/app**. Everything you ship to the
website reaches the apps immediately, so you don't need a store update. A new store build is only needed when
something in this folder changes: the icon, permissions, version or native plugins.

What the shell adds on top of the website:
- an app icon, a splash screen, and a friendly offline screen (`www/offline.html`);
- native permission prompts for the microphone (voice notes), camera and photos (screenshots);
- haptics, and an Android back button that closes sheets first;
- invite links (`crud.chat/app/...`) that open in the app, once the app-link settings below are set;
- **no purchase screens.** Apple and Google require their own billing for subscriptions sold inside an app, so
  the app shows plan and usage but never prices, Subscribe or Razorpay. People who subscribe on the website get
  Pro in the app too.

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

## Apple App Store

1. Enrol in the Apple Developer Program at developer.apple.com (US$99 a year). Individuals can enrol right away.
   A company needs a D-U-N-S number.
2. On a Mac: `npx cap open ios` → select the **App** target → **Signing & Capabilities** → choose your Team
   (bundle ID `chat.crud.app`) → **+ Capability → Associated Domains** → add `applinks:crud.chat`.
3. Set `APPLE_TEAM_ID` on Railway (Membership page of your developer account), so
   https://crud.chat/.well-known/apple-app-site-association lists the app.
4. **Product → Archive → Distribute App → App Store Connect.** Test it with TestFlight, then submit for review.
5. In App Store Connect: fill in **App Privacy** (same answers as Play's data safety), the category
   (Business / Productivity), screenshots (6.9" iPhone), the support URL, the privacy policy URL, and the
   review notes with the reviewer login.
   - Guideline 4.2 (minimum functionality): mention in the review notes that the app records voice notes with
     the microphone, reads photos and screenshots with the camera and photo library, and works as a shared team
     database with live sync.

## Versions

CI sets `versionCode` to the workflow run number. For a public release, set `APP_VERSION_NAME`
(for example `1.0.1`) in the workflow, or bump it in Xcode for iOS.
