# Conversation hierarchy refinement

Reference: the user's Codex screenshots and the live coordination conversation. Keep the product
quiet, keyboard friendly and readable. The sidebar should scan as projects with subordinate chats;
conversation status should explain placement without repeating it in the composer/footer.

Palette: canvas #fcfcfd, navigation #f5f5f7, surface #ffffff, text #242529,
secondary #6d7078, divider #e8e8eb. Native uses semantic system equivalents in light/dark appearances.
System sans throughout; monospace is reserved for code. Desktop scale: metadata 11–12, chat titles
13, projects 14 medium, conversation 15, content headings 17/20/24. On iOS, project 17 and chat 16
scale with Dynamic Type. Widen desktop navigation to about 280 logical points. Preserve 44-point
minimum touch rows. Avoid bolding every navigational level or turning selected chats into cards.

    project icon  Project name             compose
                  Conversation title
                  Conversation title

    Conversation title             computer name  status
    Project context

Align nested conversation titles to project titles; keep selection a subdued fill. The computer
label describes the primary execution host, independently of the machine that a child job uses.
On narrow screens the computer/status pair gets its own row and the computer name truncates first.

Rich messages use GFM parsing: real tables, nested/ordered/task lists, quotes, links, emphasis,
headings, images and fenced code. Code has a language label and copy action. Wide tables/code scroll
inside the message, preserving the conversation width. Raw HTML is not executed. Preserve untrusted
text as content and disallow executable URL schemes.

Review against brief: retain Codex's system type and restrained hierarchy rather than introducing a
new display font or decorative theme. Elevation remains on interactive controls; message structure
comes from type, spacing and actual document semantics.

## Quick creation and run settings

Keep the existing palette and type scale. An expanded project starts with a muted “New task”
row aligned with its chats. It is a real keyboard/touch target and disappears with the collapsed
contents. Composer controls read Agent / Model / Effort, including on the new-task screen.
Use compact menus and wrap on narrow layouts; show selected values instead of hiding them behind
an unlabeled settings icon. Model suggestions come from the execution computer; custom IDs remain
possible. Effort choices follow the selected adapter/model. Review: this extends the requested
Codex hierarchy and avoids adding another settings page or a competing primary action.

## Provider usage footer

Keep usage beside the task tree so choosing an agent does not require a settings detour. Reuse canvas #fcfcfd, navigation #f5f5f7, surface #ffffff, text #242529, secondary #6d7078 and divider #e8e8eb. System type at 12–13 points, tabular percentages, left-aligned names and right-aligned amounts. One quiet disclosure surface contains provider rows and thin usage meters; expanding reveals the execution computer, reset dates and freshness. Avoid separate provider cards or a dashboard of large numbers. This matches the requested Codex hierarchy and preserves task navigation space, including on iPhone.

Review: a permanently expanded multi-provider panel would crowd projects and imply every machine has the same account. Use a compact summary with an explicit computer context, and expand details on demand. Never infer quota from token counts or present missing data as zero. Percentages mean used throughout. Offline or old observations are marked stale.
