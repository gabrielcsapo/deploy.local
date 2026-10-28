# Capture instructions

No dashboard or iPhone UI files were changed by this backend slice. The existing
SelfUpdate, RestoreData and RestorePhone renders were reviewed. Their fixtures and
paired captures remain in `../8-computers/` and `../10-backups/`; this slice does
not claim to implement their missing self-update controls.

The existing standalone Restarting screen is served by this isolated fixture:

```sh
node docs/evidence/v2/8-computers-2/fixture-server.mjs
node design/v2/tools/capture.mjs http://127.0.0.1:5186/restarting docs/evidence/v2/8-computers-2/captures/Restarting 1440,700 900
```

| Board      | URL                              | Width | Height |
| ---------- | -------------------------------- | ----- | ------ |
| Restarting | http://127.0.0.1:5186/restarting | 1440  | 900    |
| Restarting | http://127.0.0.1:5186/restarting | 700   | 900    |

This is regression evidence for the existing edge screen, not evidence of a
successful coordinator self-release. See `capture.log` for the capture result.
