# Diagnostics → Traffic, and the repeating-sender warning

Boards: `design/boards/DiagnosticsTraffic.html` and `design/boards/AppRequestsRepeating.html`, approved on main in 518a1ea4 (sidebar since updated in a7b7fcbd) with the rest of Diagnostics.

Run the pages against the fixture:

```bash
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5182 node docs/evidence/app-one-page/fixture-server.mjs
node design/tools/capture.mjs http://127.0.0.1:5182/dashboard/computers/diagnostics docs/evidence/diagnostics-traffic/captures/DiagnosticsTraffic 1440,700 1400
node design/tools/capture.mjs http://127.0.0.1:5182/dashboard/app-requests docs/evidence/diagnostics-traffic/captures/AppRequestsRepeating 1440,700 1100
```

`DiagnosticsTraffic-1440.png` and `AppRequestsRepeating-1440.png` pair each board (left) with the page (right). `/dashboard/app-requests` shows the Requests tab's content without the project page around it, because the fixture has no real router for the project's tabs.

## Built

- `GET /api/diagnostics/traffic?range=` for admins: totals and the chart from the 1-minute rollups; senders, bytes and repeating senders from `request_logs`, never further back than 24 hours and kept for a minute.
- Computers → Diagnostics (admins only), showing Traffic.
- The warning on an app's Requests page, from `repeating` in its request summary.

## Differences from the boards

- **Only Traffic exists.** The other Diagnostics tabs (Overview, Git, Processes, API requests, Logs, Profiler) are not built, so there is no tab row and no Overview row; the page is Computers › Diagnostics, Traffic.
- **deploy.local's own traffic is not counted.** The edge records requests to apps only. The board's deploy.local row and "to deploy.local itself" need new recording in the edge.
- **"Leave it out" is not built.** The warning on Requests says "The numbers below include it" and has no button.
- **"See its requests" is not on the Traffic warning.** Each app in the tables links to its Requests page instead.
- **Not in Waiting on you.** A sender that repeats for a day raises no inbox item yet.
- **Steady** is judged by requests per minute (there in 90% of minutes, varying by no more than about a third), not by the gaps between requests: parallel loops arrive in bursts, and their gaps are not even.
- **Since** looks back seven days. Older than that reads "before <date>".
- **Bytes and senders for 7 and 30 days** cover the last 24 hours and say so; the per-app Sent column is empty for those ranges.
- **A computer is named** only when the sender's address is the one deploy.local has for it. A Mac on Ethernet and Wi-Fi shows as an address when it sends from the other one.
- **Times** read "Nov 12 at 6:01 PM" where the board says "Thu 7:41 PM", and pace reads "Every 0.4 seconds".
