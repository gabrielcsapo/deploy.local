# Native workspace design

Reference: Things’ official cross-device screenshot (references/things-native.png), and Linear’s official iOS navigation photo (references/linear-mobile.png). Things demonstrates clear project hierarchy, quiet chrome and content aligned across devices. Linear keeps primary destinations within reach. Borrow these principles, not their branding.

## Tokens

Paper #FFFFFF; rail #F7F7F8; raised surface #EEEEF0; ink #202123; secondary #72747B; divider #E7E7E9. Native implementations use semantic system equivalents so dark mode and accessibility remain supported. Success green is reserved for successful execution.

SF system type: 13pt desktop navigation, 15pt conversation (dynamic body on iOS), 20pt desktop task title; SF Mono for code. Maximum conversation width 720pt; use leading alignment for text.

Desktop: quiet project sidebar, spacious conversation, changes on demand.

    projects  |  project / task                   [Changes]
    chats     |        conversation (max 720)
              |        follow-up composer
    computer  |

Phone: one compact native navigation bar, readable conversation, compact bottom composer; changes in a sheet. No second toolbar or permanent inspector.

## Review before implementation

The product’s organizing unit is a repository with ongoing coding conversations, not metric cards. Existing design repeats title chrome and exposes infrastructure payloads; remove both. Use whitespace for hierarchy, understated selected rows, and code styling only for source or execution output. Keep native navigation, dynamic text, accessible labels, and real working controls. Browser preview remains available in the review tools; the unavailable computer-control placeholder should not occupy a primary tab.

## Codex hierarchy refinement

Astra high review: organizing tasks outside their project context was the core problem, not merely
spacing. The second pass uses global New task, a top-level Tasks section only for independent tasks,
and collapsible Projects containing their own tasks. Recency sits at the row trailing edge; activity
is indicated only while running. Per-project + starts with that project selected. New task opens a
centered first-message composer with optional Project and Computer context, rather than a mandatory
repository/title form. User messages are trailing bubbles; agent text reads as a continuous document.

## Typography and alignment refinement

Keep the approved hierarchy and neutral palette. Navigation uses 13pt on Mac and dynamic subheadline
on iOS; conversation text uses 15pt on Mac and dynamic body on iOS. Secondary text is 12pt/caption.
SF Symbols sit in consistent 18pt optical boxes, with regular weight for navigation. Sidebar project
labels and child task text share a leading edge; disclosure remains inside the folder’s hit area.
Metadata uses tabular numbers. Native phone rows retain 44pt minimum height, desktop rows 34pt.
Conversation and composer text align 24pt inside a common 760pt maximum container. The new-task
headline scales with Dynamic Type, its composer is shorter, and Local replaces the raw host name in
the computer picker. Controls remain native. Fresh visual QA is pending screen/browser availability.
