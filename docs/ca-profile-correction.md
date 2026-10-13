# Explicit local CA profile

The generator now explicitly requests critical `basicConstraints=CA:TRUE` and
`keyUsage=keyCertSign,cRLSign`, plus SKI and AKI. This removes dependence on the
host OpenSSL configuration. Existing certificates and keys are never rewritten
by this change. Private key creation and permissions remain unchanged.

Disposable fixtures prove strict OpenSSL/Python verification, ordinary curl/Node
TLS verification, hostname rejection, and preservation of existing files. A
synthetic legacy root without Key Usage fails strict verification; re-signing its
certificate with the same disposable key, subject, SKI and validity dates and a
new serial allows its unchanged leaf to verify. This is evidence for a staged
repair, not proof that every deployed certificate or client is compatible.

## Separately approved live migration

No live migration, key access, trust installation, controller installation or
restart is included in this branch. Installing this generation change alone
will not repair an existing malformed CA.

1. Inventory all current leaf and delegated intermediate certificates using
   public certificates only. Check authority key identifiers, issuer/serial
   references, certificate fingerprint pins, fleet membership comparisons and
   every affected device trust store. Resolve unknown clients before proceeding.
2. Obtain specific approval to use the existing signing key solely to produce
   a candidate corrected root certificate, preserving its exact subject, public
   key, SKI and validity window. Use a fresh positive unique serial. Do not read
   or export private key contents, change its permissions, regenerate keys, or
   regenerate site certificates. Preserve an exact public-certificate backup.
3. Stage the candidate without replacing live files or trust. Verify self-signature,
   strict CA profile, key correspondence, subject/SKI/date equality, changed
   serial/fingerprint, and every deployed leaf/intermediate chain. Test strict
   Python, curl and Node clients with explicit candidate trust and hostname
   validation. Any chain or pinned-client failure blocks replacement.
4. Present the candidate fingerprint and exact affected trust entries for
   approval. On SER, affected public files are the original data directory's
   `certs/ca.crt`, `/usr/local/share/ca-certificates/deploy-local-ca.crt`, and the
   generated system CA bundle/symlink. Replace the exact old entry rather than
   co-installing roots with the same subject: issuer selection can pick the old
   malformed root. Update downloaded CA distribution only as explicitly approved.
5. Device impact: clients trusting certificates by fingerprint/DER must receive
   the new certificate. Key pins remain unchanged only where they truly pin the
   public key. macOS and other devices require their own confirmed trust-store
   action. Fleet/delegated imports may compare root bytes and regenerate leaves;
   inspect those paths before re-importing. Do not promise automatic propagation.
6. Verify default system trust, public certificate distribution, strict Python
   HTTPS, curl/Node HTTPS, and unchanged site certificate fingerprints and SSH
   identity. Evaluate process CA caching before any separately approved reload;
   the API reads the CA file dynamically but TLS options are loaded at startup.

## Rollback

Keep exact old public CA and trust entry backups, metadata and hashes. If the
approved replacement fails, restore those public files and regenerate the system
trust bundle through the supported OS command; reverify original fingerprints.
This returns strict clients to their known previous failure, not a repaired
state. Never restore, replace or loosen permissions on private keys or site
certificates as part of this rollback. No data/container/SSH changes are needed.
Any required reload or device rollback needs its own approved scope.
