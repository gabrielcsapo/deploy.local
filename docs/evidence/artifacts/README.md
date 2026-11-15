# Design becomes Artifacts: build parity

Approved design: c846e4fb. Each `<Board>-<width>.png` here puts the approved board (left) beside the running app (right). The raw captures are in `captures/` (web) and `iphone/` (simulator, iPhone 17, iOS 27).

Web captures came from the real v2 API over a temporary data directory with three projects (deploy.local and forma carrying this repository's `design/`, home-gym without one) and Vite for the UI. Sidebar data the API alone does not answer (Live, Waiting on you, computers) shows as unavailable in the captures; that is the harness, not the change.

## Differences from the boards

- **ArtifactDocumentEdit:** the formatting bar has no **Text ⌄** style control. The board shows the control but not its choices, so it is left out until they are drawn. Bold, italic, both lists, link and code are there. Link asks for the address with the browser's own prompt, which no board shows.
- **ArtifactsNew:** a Document tile opens the same dialog titled **New document**; only **New design** is drawn. A refused Create shows the server's reason under Name (for example `artifact/onboarding-flow already exists`); that state is not drawn.
- **DesignNewEmpty:** **Ask an agent** opens the existing ask box, titled "Ask an agent about Onboarding flow"; the board shows only the button.
- **DesignProjectMenu:** **New artifact** goes to the Artifacts gallery, where Make something new is; the board does not say where it goes.
- **Artifacts / ArtifactsEmpty:** below 600 px the page keeps the app's 20 px side padding, as every page does; the boards draw 32 px at 700.
- **DesignPanelLeftClosed / DesignPanelsClosed:** captured on a canvas, not in a review; the review bar is unchanged and the restore buttons sit below it.
- **iPhone:** the document page's back button is the system chevron (iOS 26 style) rather than the word Artifacts. Within a project, artifacts are newest first.

## Not drawn, not built

Before and After for a document in review (a document's review opens the canvas review, which has no boards to show), editing a document on iPhone, the design menu in the iPhone picker sheet, and the narrow web picker sheet's project list (unchanged). A document only on its branch shows its branch where "on main" would be, on web and iPhone.
