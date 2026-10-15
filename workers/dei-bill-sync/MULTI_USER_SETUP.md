# Per-user DEI integration setup (not yet deployed)

This setup is for the existing Firebase project `temo-75`, the existing `dei-bill-sync` Worker, and the existing `DEI_KV` binding. It does not migrate legacy KV data or change Realtime Database rules.

## Firebase Console

1. Open the existing Firebase project `temo-75`; do not create another project.
2. Confirm **Authentication → Sign-in method → Google** is enabled. The project owner reports this is already enabled.
3. Confirm **Authentication → Settings → Authorized domains** includes `temo75.github.io`. The project owner reports this domain is already added.
4. In **Project settings → General**, use the existing registered web app's public config values. Configure the Worker variables `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, and `FIREBASE_APP_ID`; the project ID is `temo-75` and is already declared in Wrangler config.
5. Do not change live Realtime Database rules as part of this DEI deployment. The current repository contains no rules file, and the live rules have not been inspected. Review them separately before any RTDB changes.

The web API key and Firebase app ID are public client configuration, not credentials. Restrict the API key to the site's referrer and the Firebase Identity Toolkit / Secure Token APIs where the Google Cloud console supports those restrictions.

## Cloudflare Worker

Keep the existing Worker name, `DEI_KV` binding, Google OAuth client, and configured callback:

`https://dei-bill-sync.temo75elia.workers.dev/oauth/callback`

Confirm these variables/secrets exist before deployment:

- Variable: `FIREBASE_PROJECT_ID=temo-75` (declared in `wrangler.toml`)
- Variables: `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_APP_ID`
- Existing variable: `GOOGLE_CLIENT_ID`
- Existing secrets: `GOOGLE_CLIENT_SECRET` (do not replace if already configured)
- Secret: `DEI_TOKEN_ENCRYPTION_KEY` — a new random 32-byte key encoded as unpadded base64url. Generate it in a password manager or secure local generator, then enter it only into the Wrangler/Cloudflare secret prompt.
- Secret: `LEGACY_LINK_ADMIN_KEY` — required for the one-time administrator-controlled link from an existing T1 account to its verified Firebase UID. It is never sent to the browser.

Use `wrangler secret put <NAME>` from a trusted local terminal; never put secret values in source, GitHub, browser code, chat, or command history. Verify secret *names* with `wrangler secret list`; values cannot be read back.

The current `wrangler.toml` already contains a daily Cron trigger. This branch does not alter that schedule. Do not deploy until the tests pass and the owner gives final deployment approval.

## Required one-time link for existing T1 accounts

The existing T1 login is a legacy browser session, not a Firebase Auth identity. The DEI Worker therefore requires an administrator-verified link before Gmail OAuth or any private bill endpoint is available. Do not link accounts using an email match, localStorage ID, password, or password hash alone.

1. The user signs in to T1 with the existing T1 account and opens the DEI page. They press the Gmail button and select their Google account. This establishes the Firebase UID; no separate email/password registration form is shown.
2. The T1 administrator independently verifies ownership of the existing T1 account through a trusted channel or in person. In Firebase Authentication, the administrator confirms the Firebase UID for the Google account the user selected. Record a non-sensitive verification reference.
3. From a trusted local terminal, the administrator calls `POST /api/admin/link-claim` using the Cloudflare-only `LEGACY_LINK_ADMIN_KEY`. Include the verified existing T1 account ID, Firebase UID, verification method/reference, and `ownershipVerified: true`.
4. Deliver the returned single-use claim code only to that verified user through the same trusted channel. It expires after seven days and is bound to that Firebase UID; another UID cannot redeem it.
5. The user enters the code on the DEI page. The Worker verifies the signed Firebase ID token and claim binding, stores the T1-account-to-UID mapping, and only then permits Gmail OAuth and private bill APIs.
6. After this one-time mapping, the user signs in to T1 normally, clicks the Gmail button, selects their Gmail account, and approves read-only access. The Worker checks that the signed UID maps to the T1 account active in that browser. A mismatch fails closed.

A user ID read from the browser is used only as a UI consistency check; the Worker never accepts it as identity. Every protected request derives the Firebase UID from the verified ID token and requires that UID's administrator-approved T1 link. The link code is not a replacement for T1 login.

The legacy shared KV keys (`gmail_refresh_token`, `latest_bill`, `bill_history`, and old unscoped history keys) are deliberately ignored by the per-user API. No old bill is assigned to any user automatically.

The legacy shared keys (`gmail_refresh_token`, `latest_bill`, `bill_history`, and old unscoped history keys) are deliberately ignored by the per-user API. No old bill is assigned to a regular user automatically.

## Isolation model

The browser sends a Firebase ID token over HTTPS. The Worker verifies its RS256 signature against Google's Firebase Secure Token public keys and checks issuer, audience, expiry, issue time, and UID. Every protected endpoint derives the UID from the verified token; request body/query UIDs are ignored. Gmail refresh tokens are AES-GCM encrypted using the Worker secret. No OAuth tokens or email body/snippets are returned to the browser.

Firebase ID token verification is signature-based. A disabled account's already-issued token may remain valid until its short expiry; add revocation checks only if the product needs immediate account disablement.

## Pre-deployment checks

- Confirm the Firebase client values and Cloudflare secret names are present without displaying secret values.
- Run the Node.js 24 Worker/auth/widget tests and JavaScript syntax checks.
- Review the branch diff and confirm no legacy shared KV keys are read or copied.
- Keep all deployment and Cron changes pending the owner's separate final approval.
