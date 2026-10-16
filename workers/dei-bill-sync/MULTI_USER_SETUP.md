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
- Variable: `LEGACY_LINK_ADMIN_UID` — Firebase UID of the administrator account allowed to operate the browser-based link panel. The Worker compares the signed Firebase ID token UID server-side. Configure this before using the panel.
- Secret: `LEGACY_LINK_ADMIN_KEY` — retained only for trusted server-side/legacy administration. It is never sent to the browser and is not needed by the panel.

Use `wrangler secret put <NAME>` from a trusted local terminal; never put secret values in source, GitHub, browser code, chat, or command history. Verify secret *names* with `wrangler secret list`; values cannot be read back.

The current `wrangler.toml` already contains a daily Cron trigger. This branch does not alter that schedule. Do not deploy until the tests pass and the owner gives final deployment approval.

## Admin-panel one-time link for existing T1 accounts

1. The user signs in to T1 with their existing account, opens DEI, and clicks the Gmail button. Google sign-in establishes a Firebase UID and the page sends a pending-link request. It does not send the T1 browser ID as identity.
2. The administrator opens the existing admin bills page and uses **DEI მომხმარებლის დაკავშირება**. Sign in with the Google account whose Firebase UID is configured in Worker variable `LEGACY_LINK_ADMIN_UID`.
3. Select the pending Firebase request and the existing T1 user from the account list. Independently verify that the Google account belongs to that T1 user through an existing trusted channel or in person. Do not infer identity from matching email addresses.
4. Record the verification reference and issue the one-time code. Give it only to the verified user through the trusted channel.
5. The user enters the code on the DEI page. The Worker verifies the signed Firebase UID, consumes the code once, and stores the mapping. Gmail OAuth can then proceed. The code expires after seven days.
6. A mismatch between the current T1 account and the server-approved mapping blocks sync and history. Each Gmail token and bill remains stored under the mapped Firebase UID.

The pending request list and code-issuance endpoint require a Firebase ID token whose verified UID exactly matches `LEGACY_LINK_ADMIN_UID`. The old `LEGACY_LINK_ADMIN_KEY` remains a server-side fallback only; never put it in HTML, JavaScript, localStorage, or chat.

The legacy shared KV keys (`gmail_refresh_token`, `latest_bill`, `bill_history`, and old unscoped history keys) are deliberately ignored by the per-user API. No old bill is assigned to a user automatically.

## Isolation model

The browser sends a Firebase ID token over HTTPS. The Worker verifies its RS256 signature against Google's Firebase Secure Token public keys and checks issuer, audience, expiry, issue time, and UID. Every protected endpoint derives the UID from the verified token; request body/query UIDs are ignored. Gmail refresh tokens are AES-GCM encrypted using the Worker secret. No OAuth tokens or email body/snippets are returned to the browser.

Firebase ID token verification is signature-based. A disabled account's already-issued token may remain valid until its short expiry; add revocation checks only if the product needs immediate account disablement.

## Pre-deployment checks

- Confirm the Firebase client values and Cloudflare secret names are present without displaying secret values.
- Run the Node.js 24 Worker/auth/widget tests and JavaScript syntax checks.
- Review the branch diff and confirm no legacy shared KV keys are read or copied.
- Keep all deployment and Cron changes pending the owner's separate final approval.
