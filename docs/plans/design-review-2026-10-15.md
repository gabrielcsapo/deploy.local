# Native workspace design review — October 15, 2026

## Intent and evidence

Improve the actual deploy.local conversation and navigation on macOS, iPhone, and web. This is a refinement of a working tool: the user’s Codex screenshots set the taste direction. We are not adding a dashboard or replacing the established project/task model.

Before images are preserved in `docs/evidence/workspace/design-review/before/`: `web.png`, `macos.png`, `ios.png`, and `ios-navigation.png`. They show the same real “Polish the conversation experience” conversation. iOS evidence is from the iPhone simulator, not a physical-device claim. The paired viewer is `docs/evidence/workspace/design-review/index.html`. Final visual acceptance is recorded below after capture.

## Published prompt sources

- [Vercel: How to prompt v0](https://vercel.com/blog/how-to-prompt-v0) organizes a brief around the concrete surface, the person’s working context, and constraints/taste. Applied here by naming the actual sidebar, conversation, composer, and native platforms instead of asking for an abstract “beautiful dashboard.”
- [Anthropic: frontend-design skill](https://github.com/anthropics/claude-code/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md) asks for a deliberate aesthetic direction and production implementation. The local frontend-design skill adds a plan, critique, build, and visual review loop. The user’s explicit system-native preference overrides generic advice to use unusual typography.
- [Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/) supplies the platform constraint: preserve native navigation, semantic type, accessibility, keyboard conventions, and touch-sized controls.

These are useful published patterns, not evidence that a particular prompt is universally “best.” The prompt below is an original adaptation to this product.

## Reusable design expert prompt

> Act as a senior product designer and implementation engineer for native iOS, macOS, and polished web workspaces. Your product is deploy.local: a personal, cross-computer coding workspace used to find a project, continue a task, read an agent’s work, and compose the next instruction. Users switch between keyboard-driven Mac/web work and touch-driven iPhone check-ins.
>
> Inspect the existing running product and its source before designing. Treat the supplied Codex application screenshots as the primary visual benchmark. Study actual product screenshots from two additional polished applications using primary sources; record image URLs and the specific spatial, typographic, and interaction lessons. Do not imitate their branding or copy marketing page treatments into a working application.
>
> Critique observable problems, not vague aesthetic impressions. Identify three to five problems with hierarchy, proportion, alignment, density, input affordances, or platform adaptation. For each, explain its effect on the person doing work and propose a concrete change. Define a compact token and layout plan, then challenge it against the brief before changing code.
>
> Preserve the narrow utility rail, project-grouped tasks, top-level tasks, search at the top, New task at the bottom, usage behind the account control, unified provider/model/effort selection, collapsible tool activity, and contained agent-controlled computer previews. Preserve all working auth, drafts, transport, tool, and task behavior. Do not invent data or controls to improve a screenshot.
>
> Use platform system typography intentionally. Use SF Symbols natively and the existing SVG icon system on web. Desktop navigation should be compact and keyboard accessible; iPhone should have its own gutters, safe-area treatment, Dynamic Type, and at least 44-point targets. Differentiate canvas, controls, and temporary panels with restrained elevation instead of giving every surface the same shadow. Keep full labels accessible when visual space requires truncation.
>
> Implement the smallest coherent set of changes that produces a perceptible improvement. Modify existing rules rather than layering conflicting overrides. Capture honest before/after screenshots with the same content, viewport, theme, and comparable scroll state. Review the rendered result, fix visible regressions, and report both what improved and what remains unverified. Never call an implementation “native” based only on a screenshot; check its interactions too.

## Actual reference applications inspected

### Codex — primary taste reference

The user’s posted desktop and iPhone captures show grouped project navigation, a compact context header, subdued controls, and a conversation/composer pair that dominates the canvas. They establish the product direction more directly than a marketing page. Existing research image: `docs/design/references/codex.png`; its provenance is recorded in `docs/design/reference-sources.md` and is a republished official-page capture, not an original primary download. The user’s own recent captures remain the authoritative visual reference.

### Things — platform adaptation and hierarchy

[Official product page](https://culturedcode.com/things/) · [actual Mac/iPhone/iPad app image](https://culturedcode.com/things/2024-01-20/images/whatsnew-collage-io60.png)

Visually inspected the image at full size. The phone has generous readable content width without importing the Mac’s multi-column gutters. The Mac sidebar gives group names, tasks, and utility actions distinct emphasis; the main page stays largely unboxed. Applied: remove nested desktop gutters on iPhone and demote project utility actions instead of boxing every navigation item.

### Linear — alignment and surface hierarchy

[Official UI redesign article](https://linear.app/now/how-we-redesigned-the-linear-ui) · [sidebar alignment image](https://webassets.linear.app/images/ornj730p/production/88c9e424655d613e5ccd5e260b7cc1a692d3c068-2352x2808.png) · [actual application after image](https://webassets.linear.app/images/ornj730p/production/9b91020243984487b4e0cbe72278dd1acd7f9c57-2352x1380.png)

Visually inspected both images. The sidebar uses shared icon/text axes; muted section headings separate groups without taking on task weight. The full workspace gives sidebar, list, and content distinct planes while reserving strong elevation for interactive overlays. Applied: align nested task text with project labels, eliminate the redundant overview row, and reduce shadows on fixed controls while retaining an elevated composer.

## Critique of the baseline

1. **iPhone wastes reading width.** A 24-point conversation gutter plus a 16-point assistant inset duplicates a desktop alignment strategy on a small screen. Lists then indent again. The result is unnecessary wrapping and less content visible. Use a 16-point phone gutter and no extra assistant inset.
2. **Context is taller than its importance.** iPhone shows title, project, then computer and status as three stacked layers before any content. Move project to the native navigation title’s secondary line and keep machine/status on one compact row. Keep the computer before the status, including a complete accessible label.
3. **The empty composer is too large.** Minimum input height, a wide vertical gap, and uniform padding make it feel like an empty card. Reduce dead space, preserve multiline growth, and keep touch targets large. Phone mic/model/send targets become 44 points; Mac controls remain compact.
4. **Project utilities compete with tasks.** New task and Project overview occupy full task-like rows; the project title itself only expands. Let the title open the overview and a dedicated chevron expand/collapse. Keep a quieter New task first in the child list. On iPhone, put the 44-point disclosure at the trailing edge so it does not force an oversized leading indent.
5. **Fixed controls look like floating panels.** Native search and bottom New task use the same deep shadow as the composer. Introduce shallow control elevation and retain a restrained deeper layer for composing and temporary panels. This creates hierarchy with fewer visual effects.

## Token and layout plan

| Role | Decision |
| --- | --- |
| Dark canvas / navigator / rail | Retain #181818 / #222222 / #303030 |
| Light canvas / navigator | Retain #FCFCFC / #F5F5F5 |
| Accent | Existing blue #3478F6, primarily enabled Send and selected effort |
| Typography | System UI; desktop navigation 14, secondary action 12, body 15 native / 16 web; iOS semantic Body/Callout/Subheadline/Caption |
| Conversation | Existing 760-point maximum; desktop outer gutter 24 plus message inset; iOS gutter 16 with no nested assistant inset |
| Composer | 22-point corner radius, 24-point native minimum text area, 8-point gap; 14-point horizontal/upper padding; iOS 44-point action targets |
| Navigation | 32-point web task rows, 30-point native Mac rows; iOS 46-point rows; one selected background, no task cards |
| Elevation | Fixed control: 3-point blur / 1-point y; composer: 12-point blur / 4-point y, restrained opacity |

Desktop:

```text
rail | search                 | task title / context
     | tasks                  | readable conversation
     | projects               | compact tool disclosure
     |   project title        |
     |     New task (quiet)   |
     |     task               | composer
     | New task (pinned)      |
```

Phone:

```text
back   task title / project   review
           computer · status
conversation with 16-point outer gutters

compact composer; 44-point action targets
```

Plan critique before implementation: changing the system font or adding a decorative palette would conflict with the user’s native Codex preference. A denser phone navigation with tiny chevrons would also be wrong: preserve touch area, relocate the disclosure, and reduce redundant rows instead. Color changes were rejected as the main solution; the implemented work changes proportion, alignment, and interaction hierarchy.

## Implementation and verification

Changed web `projects.client.tsx`, `workspace.css`, and the project dialog’s SVG close control in `project-hub.client.tsx`; native `WorkspaceView.swift`, `WorkspaceStyle.swift`, `AgentControls.swift`, and `VoiceInput.swift`. No server, authentication, draft, or transport code changed. The existing selected-task transcript identity and closed-computer-view accessibility guard remain intact.

TypeScript typecheck, targeted lint, and targeted formatting passed. Native build and interactive visual acceptance are owned by the parent task; final evidence will be appended after capture. Existing baseline captures remain unchanged.


## Rendered review and acceptance

Reviewed all four actual after captures side by side with their baselines. The iPhone now gives substantially more width to text and less height to persistent context. The model, microphone, and Send controls retain comfortable touch area inside a shorter composer. Mac and web keep the conversation dominant, while project actions no longer resemble additional conversations. The first rendered review caught an oversized gap between Projects and its first folder after increasing the add button’s hit area; a final platform-specific heading height and reduced stack gap corrected it.

Verified by the parent’s live UI session:

- Mac: project overview opens from the header, project collapse/expand works, and the composer draft survives navigation.
- iOS simulator: project sheet opens; collapse/expand works; real typing enables Send.
- Web: project collapse/expand, model popover, composer input, and direct project navigation work.
- Native Mac and iOS simulator builds passed; the existing 10 Swift tests passed. TypeScript typecheck, targeted lint, and formatting passed.

The after screenshots are implementation evidence, not generated mockups. The iPhone image is simulator evidence. This review does not establish physical-device keyboard behavior, all Dynamic Type sizes, or every tool-output state; those require separate acceptance. Native screenshots were captured with macOS application activation state visible, so toolbar emphasis can differ from the baseline. Both phone conversation captures are at the end of the same response; more of the preceding prompt is visible after the layout reduction because the text wraps into fewer lines.

Additional reference images inspected during this review are retained under `docs/design/references/linear-sidebar-alignment.png`, `linear-workspace-after.png`, and `things-platform-collage.png`. These are research material, not shipped application assets.

Final delivery: the spacing correction was rebuilt and installed on Mac and the iPhone simulator,
and all four after captures were refreshed. The signed physical-iPhone build also passed and was
installed successfully; its new layout has not been visually verified on that physical device.
The before/after viewer is `docs/evidence/workspace/design-review/index.html`.
