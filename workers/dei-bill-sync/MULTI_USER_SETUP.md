# Per-user DEI integration setup (not yet deployed)

This setup is for the existing Firebase project `temo-75`, the existing `dei-bill-sync` Worker, and the existing `DEI_KV` binding. It does not migrate legacy KV data or change Realtime Database rules.

## Firebase Console

1. Open the existing Firebase project `temo-75`; do not create another project.
2. In **Authentication → Sign-in method**, enable **Google**. Email/Password may remain enabled only as a fallback for existing Firebase Auth users.
3. In **Authentication → Settings → Authorized domains**, add `temo75.github.io` if it is not already present.
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
- Optional secret: `LEGACY_LINK_ADMIN_KEY` — needed only if you choose to use the retained administrator-controlled legacy-account claim endpoint; ordinary Gmail connection and personal bill sync do not require it.

Use `wrangler secret put <NAME>` from a trusted local terminal; never put secret values in source, GitHub, browser code, chat, or command history. Verify secret *names* with `wrangler secret list`; values cannot be read back.

The current `wrangler.toml` already contains a daily Cron trigger. This branch does not alter that schedule. Do not deploy until the tests pass and the owner gives final deployment approval.

## Optional legacy account mapping

Personal Gmail bills are stored by verified Firebase UID and do not require mapping to the old T1 account. This avoids an administrator claim-code step. If a legacy account mapping is separately needed later, do not link by email, old password/hash, or browser-stored ID alone.

1. The user creates/signs into a Firebase Auth account on the DEI page. The main connection button can create/sign in with Google and immediately continue to Gmail OAuth.
2. An administrator independently confirms which existing T1 account belongs to that person through a trusted channel or in person. Record a non-sensitive verification reference.
3. The administrator calls `POST /api/admin/link-claim` from a trusted local tool, using the Cloudflare-only `LEGACY_LINK_ADMIN_KEY`. Include the verified legacy account ID, the Firebase UID, the verification method/reference, and `ownershipVerified: true`.
4. Deliver the returned one-time claim code only to that verified user through the same trusted channel. The code is short-lived and bound to that Firebase UID; another UID cannot redeem it.
5. The user can redeem that code on the DEI page only if the optional mapping UI is reintroduced; it is not part of the ordinary Gmail flow. All Gmail data remains scoped to the Firebase UID regardless of legacy mapping.

The legacy shared keys (`gmail_refresh_token`, `latest_bill`, `bill_history`, and old unscoped history keys) are deliberately ignored by the per-user API. No old bill is assigned to a regular user automatically.

## Isolation model

The browser sends a Firebase ID token over HTTPS. The Worker verifies its RS256 signature against Google's Firebase Secure Token public keys and checks issuer, audience, expiry, issue time, and UID. Every protected endpoint derives the UID from the verified token; request body/query UIDs are ignored. Gmail refresh tokens are AES-GCM encrypted using the Worker secret. No OAuth tokens or email body/snippets are returned to the browser.

Firebase ID token verification is signature-based. A disabled account's already-issued token may remain valid until its short expiry; add revocation checks only if the product needs immediate account disablement.

## Pre-deployment checks

- Confirm the Firebase client values and Cloudflare secret names are present without displaying secret values.
- Run the Node.js 24 Worker/auth/widget tests and JavaScript syntax checks.
- Review the branch diff and confirm no legacy shared KV keys are read or copied.
- Keep all deployment and Cron changes pending the owner's separate final approval.
