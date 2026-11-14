# iPhone pairing contract

An authenticated person sends JSON `{}` to `POST /api/devices/pair`.
Render the response as a QR code containing the JSON itself:

```json
{
  "version": 1,
  "address": "https://deploy.local",
  "fingerprint": "SHA-256 fingerprint of the DER root CA certificate, uppercase colon-separated hex",
  "token": "opaque 256-bit single-use token",
  "expiresAt": 1793145900000
}
```

The client must pin the root certificate to this fingerprint **before** sending the
token. Trust applies only to this SER connection, not to the system trust store.
Do not use an unauthenticated fingerprint fetched separately from the QR as the
trust source. Never send the token to a redirect or another origin.

Within five minutes, POST `{"token":"…","name":"Gabriel’s iPhone"}` as JSON to
`<address>/api/devices/exchange`. No existing session is required. It returns
`{id, username, token, expiresAt}`. Store the username/token in Keychain, then send
`X-Deploy-Username` and `X-Deploy-Token` on requests. The device session lasts 30
days, consistent with existing sessions; pair or sign in again after expiry.
Only the token digest is retained while pairing. An atomic transaction consumes
it and creates exactly one session/device. A failed replay returns 410.

GET `/api/devices` lists only the signed-in account's active paired devices.
DELETE `/api/devices/:id` with JSON `{}` revokes its actual session immediately.
The caller cannot remove another account's devices. Existing APNs registrations
remain in the separate push store: this slice revokes API access, but does not
remove APNs tokens. The iPhone/push slice must associate those records with the
paired device ID and stop delivery when it is removed.

`DEPLOY_PUBLIC_ORIGIN` configures the canonical HTTPS address and WebAuthn relying
party; default `https://deploy.local`. Do not derive it from untrusted Host or
Origin headers. Public options/verification, CLI polling and pairing exchange
are rate limited per socket peer; no forwarded-address header is trusted.
