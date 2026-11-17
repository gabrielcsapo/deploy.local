# Projects list

Boards: `design/boards/Projects.html` and `design/boards/ProjectsShow.html`, approved on main in fdc28295.

Run the page against the fixture:

```bash
DEPLOY_MDNS_ADDRESS=127.0.0.1 PORT=5181 PROJECTS_FIXTURE=docs/evidence/projects-list/projects.json node docs/evidence/app-one-page/fixture-server.mjs
node design/tools/capture.mjs http://127.0.0.1:5181/dashboard/projects docs/evidence/projects-list/captures/Projects 1440,700 1440
```

`Projects-1440.png` and `Projects-700.png` pair the board (left) with the page (right). The fixture's apps come from the older live fixture, so the names differ from the board's (two Miniflux apps, an app called deploy.local).

Checked by hand in the browser: Show more fetches the other nine repositories; ticking Archived adds its group; unticking Live and Repositories leaves Archived alone with the menu still open, as `ProjectsShow` draws it; the last tick cannot be removed; the ticks are kept in `localStorage`; typing "kettle" with the usual two ticked finds the archived kettle-timer; "kettlezz" says nothing matches.

## Differences from the boards

- **Proposals.** The boards' cards and rows name proposals ("1 update", "Archive proposed", "up to date"). The server has no proposals for projects, so a card's one fact is an open PR, Maintained, "Shipped from a folder" or when it changed.
- **Archived rows** have no second line. Nothing records when a project was archived or whether a backup was kept, and nothing can archive one yet.
- **Page width.** The app's Projects page is 896 px wide where the board is 704, as it was before this change. Cards stay two across.
- **Times** use the wording the other project pages use: "1 day ago" where the board says "yesterday", "13 weeks ago" where it says "94 days ago".
- **Stopped apps** say "Stopped" under the name; the board adds how long ago.
- **Repository and archived rows end in a chevron**, as every linked row in the app does.
- **Failing** in the subtitle counts failing apps, from Live, not failing projects.

## States the boards do not show

- No match: "No projects match", then "Nothing is named “…”."
- Nothing under the ticked kinds: "Nothing under Archived", then "Tick another kind of project in the menu beside the filter."
- A project whose apps are all workers has no request line or count.
- "Show N more" fetches up to 20 more repositories each time.
