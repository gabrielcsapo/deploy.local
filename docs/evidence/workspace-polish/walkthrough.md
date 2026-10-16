# Application walkthrough and corrections

The initial SER release was verified for service health, asset delivery and server checks, but that did not establish correct UI behavior. A live browser walkthrough on 2026-10-16 found these defects:

- A landing-page visit followed by dashboard navigation retained the marketing footer.
- A task diff stayed hidden inside a closed disclosure whose toggle was hidden.
- Review state could cover the repository after switching destinations.
- Deployment history used a viewport-based three-column layout inside an already narrow work pane.
- Issue and pull-request composition retained an unnecessary list column at narrow widths.
- Application tables clipped actions; settings stacked every category; catalog and shared apps retained older headings/cards/empty states.
- Service/storage actions, notifications and activity rows linked to routes that are no longer registered.
- Failed history/activity requests could leave loading indefinitely. Switching resources could apply obsolete responses.
- Application deployment computers appeared online while the distinct task worker was offline, without useful recovery guidance.

The corrections share the landing page's lavender/plum identity through generated color/type tokens and semantic utility aliases. Metric identities and status semantics remain separate. The landing uses a floating Dashboard launcher and a labeled, interactive example service list.

Browser verification used the existing live SER application read-only to identify defects. The revised UI was exercised with an isolated database, disposable account, real fixture Git repositories and actual API endpoints. No live deployment, user credentials, runtime configuration or application data was changed by UI testing.

Verified flows: landing disclosure and launcher; public chrome removed on dashboard navigation; task list, conversation, unsent draft continuity, review diff and repository transition; branch/file/source browsing; issue and pull-request creation, branch comparison and changed-file disclosure; application list and overview; deployment selection, failed build output and pagination with 25 fixture attempts; application and global settings categories; computer inventory/task worker distinction; catalog filters/clear/details; read-only Compose inspection and review report; shared-app empty state; fleet activity links; fleet logs and command palette; compact navigation drawer, Escape and focus return.

At 842 px, application table viewport/scroll widths both equal 566 px. At 390 px, page viewport/scroll widths both equal 390 px, and table viewport/scroll widths both equal 342 px. Larger/narrower work panes select their own deployment and repository detail layouts through container queries. Screenshots here show isolated UI data, not live running services or a live agent execution.

Task execution on SER remains unavailable until an ordinary-user task worker is connected to the live coordinator data directory. Online application runtime agents are a different inventory. This release surfaces that condition and the supported worker setup command; it does not start agents or claim a successful coding run.
