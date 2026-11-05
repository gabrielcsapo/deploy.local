# iPhone password sign-in checks SER's certificate in the app

Verified on a fresh iOS 27 simulator that has never trusted any deploy.local CA, against a local HTTPS test coordinator with its own test CA and a test account.

- `01-password.png`: the password sheet (SignInPasswordPhone).
- `02-trust.png`: after Sign in, before any password is sent, the trust step shows the test CA's fingerprint, matching `openssl x509 -fingerprint -sha256`. The coordinator logged no login request.
- Cancel returns to the sheet. They match, then a wrong password: the login goes over the app-pinned connection and gets "Wrong username or password." The right password then signs in with no second prompt, and every later request uses the pinned session.
- `03-settings.png`: "SER's certificate · Checked by you on November 5, 2026 · Forget" (SettingsPhone).
- `04-forget.png`: Forget's confirmation. Forget removes the saved trust and signs out of that connection.
- `pair-*.png`: board (left) and app (right).

Found and fixed while verifying: `URLSession.bytes(for:)` asks the task, not the session, for server trust, so the credential-free `/ca.crt` download got default trust and failed on any iPhone that doesn't already trust SER. QR pairing uses the same download. The download and pinned delegates now answer task-level challenges too.

`deploy status --fingerprint` from a Mac (fetched from https://deploy.local/ca.crt) matches `openssl` on SER's `certs/ca.crt`.
