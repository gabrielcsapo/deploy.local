# Fresh workbench review — October 17, 2026

## Direction

Make deploy.local a calm project workbench. Keep the global rail, a contextual second sidebar, purple identity, and resource lists/viewers in the right pane. Give every destination one clear location header and a consistent inner alignment. The work itself—a prompt, response, source file, diff, or deployment output—should carry the strongest visual emphasis.

The immediate changes are a composition pass, not a claim that the entire product has been polished. Use a 720–760-point desktop reading/composing axis, 24-point desktop / 16-point compact work-pane insets, a 56-point location header, and a quieter context row. Keep native system type and the established web type contract. Reserve strong purple for selected navigation and the next enabled decision. A solid, quietly bordered prompt surface replaces glass-like layered elevation and oversized empty editors.

## Root findings

1. **The surfaces describe different products.** Current web task navigation uses project scope and local sections; native task navigation groups conversations under projects. Native repositories abandon the contextual sidebar for a large segmented header. Conversation, source browsing, review, and application management have different title/context arrangements. Shared colors and vectors cannot repair that conceptual discontinuity. Context stays in the second sidebar; the actual task list, repository content, review, and management resources belong in the right pane.
2. **Chrome competes with resource identity.** Live web squeezes title, project, computer, status, Computer use, and Changes into one line. At 1280 pixels the title becomes a fragment. Native repeats context over title bar and another row. Application overview stacks a location header, action strip, context strip, and section header before its first resource. Separate location/actions from quiet execution context; combine related metadata and its secondary action instead of adding another band.
3. **Prompt and transcript have different centers of gravity.** The web transcript is readable and centered, while its continuation composer spans almost the entire pane. New-task CSS turns the same input into a full-height blank bordered editor; native instead centers a short welcome form. Use the same prompt component, width, and alignment from task start through continuation. The surrounding pane can fill the window without forcing the input to fill it.
4. **Review obscures the result of AI work.** Native's floating inspector gives changes and checks a hard height ceiling and hides actual code behind View diff. Web exposes a concatenated raw patch, with noninteractive paths above it. Review needs a proper work pane with navigable file sections, old/new line gutters, and an explicit Checks section. Computer controls are a separate action.
5. **Resource styling often gives metadata equal weight to identity.** Applications begins with Status instead of Application; unavailable metric cells occupy substantial attention. Each row repeats a destructive action. Identity should lead, secondary measurements should recede, and row height should remain comfortable. Source/diff/log viewers can have their own dense reading rhythm; the surrounding shell should remain quiet.
6. **The implementation carries competing visual histories.** `workspace.css` defines a floating inspector and centered composer, while later rules in `native-workspace.css` undo that composition and later rules undo some of those rules again. The immediate pass consolidates the affected composition rules in place. This is not a complete CSS architecture cleanup.

## Priority and implementation

### Implemented in this web pass

- A task's title and actions have a dedicated location header. Project, execution computer, and real task state live in a quieter context row below it.
- Transcript and continuation composer share the generated `readingWidth` token. Assistant text no longer has an extra nested left gutter. Task start uses “Describe the work,” adjacent execution-computer selection, and the same bounded prompt surface. It no longer stretches an empty textarea to fill the pane.
- Review fills the right pane. Changes and Checks are separate local views. Changed-file links scroll to and focus the actual file section. The parser retains deleted/renamed/quoted paths, real hunk line numbers, metadata and binary notices, and header-like source text. It does not create synthetic diffs for unavailable content.
- Application identity is the first data column. Names receive clearer weight; row hover no longer adds a decorative colored edge. The application overview combines its context and Add service or storage action into one strip. Management toolbar, overview content, and resource rows use the shared work-pane inset.
- Older affected composer/review/header rules are replaced or removed, rather than adding another final override block.

### Parent-owned native alignment

Native work is being integrated separately: the same task-start language/solid prompt surface and reading axis; full-height review with Changes/Checks and real per-file gutters; contextual repository navigation instead of a segmented full-width header. This memo does not claim those native changes are built or visually accepted.

## Full-view audit status

| Surface                                        | Evidence inspected                                              | Status / remaining gap                                                                                                                                               |
| ---------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task start                                     | Current web/native source; prior task-start captures            | Web composition changed. Needs rendered desktop/compact/light acceptance.                                                                                            |
| Active conversation                            | Live authenticated web; latest Mac/iOS shared-icons captures    | Web composition changed. Provider selection, drafts, transport, and running-task actions retain existing code paths. Rendered after-state pending.                   |
| Review and checks                              | Live web; latest native-polish Mac/iOS captures; current source | Web structure and parser changed; targeted parsing checks added. File navigation, focus, scrolling, and compact output need rendered acceptance.                     |
| Repository files/source                        | Live web repository; latest native-polish file/source captures  | Existing real table/source behavior retained. Native context restructuring is parent-owned. Long names, large repositories, and phone source remain acceptance gaps. |
| Applications list                              | Live authenticated table and source                             | Identity-first styling changed. Metric absence and destructive-action treatment still warrant a future product pass.                                                 |
| Application overview                           | Live real application with service/storage; current source      | Context/action chrome simplified. Must verify expanded rows, pending configuration, and active-build states.                                                         |
| Deployments/logs                               | Current structure/source and previous full-view evidence        | No new full interactive audit. History/output behavior, log filtering and recovery must be included in integration acceptance.                                       |
| Issues, pull requests, pipelines               | Current web/native implementation and previous evidence         | Whole-flow interaction review remains. Agent-to-review-to-deployment continuity is not fully resolved by this pass.                                                  |
| Computers, settings, provider/account controls | Current structure/source                                        | Existing controls retained; no exhaustive interactive audit. Worker/provider recovery remains an important acceptance case.                                          |
| Public landing/docs                            | Live landing structure, current source                          | Outside this immediate workbench implementation. Public identity and typography need a later coherent review.                                                        |
| Custom icons                                   | Shared icon manifest/reference and latest native screenshots    | Shared geometry is adequate, but compose/review need optical refinement at actual sizes. No geometry change in this pass.                                            |

## Validation and practical limits

Targeted parser tests cover independent file/hunk numbering, additions/deletions, renamed and quoted paths, binary notices, empty patches, UTF-8 Git quoting, and source that resembles patch headers. Typecheck, targeted lint/format, the production build, and all four targeted parser tests passed locally. The design-token generator was run; the composition-rule updates do not change the generated CSS values.

A local Vite preview is available at `http://127.0.0.1:5173`, proxying API calls to the existing trusted coordinator. No service, backend, commit, or deployment is made by this web pass. My browser surface became unavailable (`browsers: []`) after the read-only live audit. Consequently the parent owns rendered after-state acceptance at desktop and compact widths, including keyboard focus and both appearances. Build success must not be described as visual acceptance.

Remaining design work includes application row-action disclosure, broader resource/empty/error-state consistency, full issue/PR/pipeline and deployment interaction review, icon optical quality, native Dynamic Type and older OS acceptance, and a final cross-platform comparison using the same real task. Do not call the overall product exhaustively polished based on this composition pass.
