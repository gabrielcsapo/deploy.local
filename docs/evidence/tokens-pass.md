# Tokens pass review evidence

Committed on `codex/tokens-pass` from 3179c28. Implemented by Codex (gpt-6.1-sol, high) in an isolated worktree. Rendered review and the light-surface correction are recorded below.

## Palette

| Token           | Light     | Dark      |
| --------------- | --------- | --------- |
| canvas          | `#F7F6F9` | `#121116` |
| sidebar         | `#EFEEF3` | `#19181E` |
| rail            | `#EFEEF3` | `#19181E` |
| surface         | `#FFFFFF` | `#212027` |
| raised          | `#F3F2F6` | `#2A2931` |
| field           | `#FFFFFF` | `#212027` |
| hover           | `#ECEBF1` | `#26252C` |
| line            | `#DEDCE4` | `#34323C` |
| edge            | `#797581` | `#5A5764` |
| selected        | `#E5D9F5` | `#2A2338` |
| text            | `#1F1B27` | `#F8F6FC` |
| secondary       | `#514B5C` | `#C8C3D0` |
| tertiary        | `#615A6C` | `#B4ADBF` |
| accent          | `#70439A` | `#C9ADF1` |
| accentHover     | `#63388C` | `#D7C3F4` |
| accentSoft      | `#E5D9F5` | `#2A2338` |
| action          | `#6A3FC4` | `#7C52D6` |
| actionHover     | `#5C32B2` | `#875CDE` |
| onAction        | `#FFFFFF` | `#FFFFFF` |
| statusActive    | `#245AA6` | `#B1CDFF` |
| statusAttention | `#7D4B09` | `#F2CD91` |
| statusHealthy   | `#21643F` | `#A0DEB8` |
| statusFailed    | `#A72633` | `#FFB3BA` |
| statusInactive  | `#615A6C` | `#B4ADBF` |

`success`, `warning`, and `danger` retain the healthy, attention, and failed values. Existing metric colors remain unchanged. Shared shadow is black; highlight and opaque mask are white. Alpha overlays now mix semantic tokens with transparency, including former numeric RGB colors.

Canvas → chrome → surface → raised has L* 5.3 → 8.6 → 12.6 → 17.0 in dark mode. Light elevation goes toward white instead: canvas 97.0, chrome 94.3, surface and field 100.0, raised 95.7 for chips and tracks on white. Rail and sidebar are identical. Selected differs from hover/raised by CIE76 ΔE 10.3/9.8 in dark and 12.4/11.7 in light; selection retains violet chroma against neutral surfaces.

White/action contrast is 5.20:1 dark and 6.73:1 light; white/actionHover is 4.55:1 dark and 8.22:1 light. Light edge/surface is 4.49:1. Across canvas, chrome, surface, raised, field, hover and selected, the weakest text/status contrast is 6.62:1 dark and 4.89:1 light. The minimum contrast for each text role exceeds its previous minimum. These are numerical sRGB contrast and CIELAB checks, not visual approval.

`actionHover` now has its own CSS variable. The legacy `--ds-accent-hover` maps to readable `accentHover`, so link hover text does not inherit the saturated button fill.

## Files by area

- Contract/pipeline: `app/design-tokens.json`, generated `app/design-tokens.css`, `app/theme.css`, `scripts/build-design-tokens.mjs`. Form font sizes reference type roles; code is 12 px and public hero is 64 px.
- Shared UI/reference: `app/components/ui/{StatusBadge.tsx,index.tsx,ui.css}`, `app/routes/dashboard/design-system.client.tsx` and its stylesheet. The reference shows all five tones, action/disabled specimens and updated usage recipes.
- Web consumers: `app/styles.css`, `app/design-system.css`, `app/native-workspace.css`, `app/public-workspace.css`, dashboard workspace/rail/application-overview styles, landing preview styles, and the affected TSX consumers. Replacements cover local sizes, shorthand fonts, relative code sizes, hex/RGB colors and selection fills. Application status, computer Online/Offline and task context use the shared badge without changing endpoints or state logic.
- Native: `WorkspaceStyle.swift`, `WorkspaceView.swift`, `WorkspaceToolbar.swift`, `ProjectHubView.swift`, `TaskQuestionView.swift`, `AgentControls.swift`, `BrowserPanel.swift`, `CheckpointJobRow.swift`, `NewConversationView.swift`, `ProviderUsageFooter.swift`, `RepositoryBrowserView.swift`, `ReviewWorkspaceView.swift`, `VoiceInput.swift`. Dynamic Type styles retain weights and mono designs. Selection, prompt/surface chrome, prominent actions and task status consume shared palette equivalents.
- Guard/docs: `scripts/check-design-literals.mjs`, `scripts/check-native-token-parity.mjs`, `package.json`, `docs/design-system.md`, `docs/evidence/native-polish/token-parity.json`, this report.

## Counts and allowlist

Measured from this checkout's starting HEAD, then the completed tree:

| Match                                    | Before | After |
| ---------------------------------------- | -----: | ----: |
| `font-size: *[0-9.]+px`                  |    393 |     0 |
| `text-\[[0-9.]+px\]`                     |    149 |     0 |
| RGB/RRGGBB hex regex outside token files |    192 |     0 |
| Hex regex including alpha forms          |    221 |     0 |
| `.system(size:` in DeployUI              |     35 |     0 |

The raw hex regex also counted three React error numbers in comments; those comments now spell out “React error N”. Counts include repeated masks/shadows, so differ from the review's color-only inventory. No remaining product instance requires an exemption. The guard's only allowlisted path is `app/design-tokens.css`, because it is generated from the shared JSON color/type contract. JSON itself is outside the CSS/TS/TSX scan. Code and hero use tokens and require no file/selector exemptions.

The final counts used:

```sh
grep -rhoE "font-size: *[0-9.]+px" app | wc -l
grep -rhoE "text-\[[0-9.]+px\]" app | wc -l
grep -rhoE '#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b' app --include='*.css' --include='*.tsx' --include='*.ts' --exclude='design-tokens.css' | wc -l
grep -rhoE '\.system\(size:' native/Apple/Packages/DeployKit/Sources/DeployUI | wc -l
```

## Command results

- `node scripts/build-design-tokens.mjs`: passes; a second run is byte-identical.
- `node scripts/check-design-literals.mjs`: passes. A temporary product CSS file was planted separately with pixel font-size, arbitrary Tailwind size, short/full hex, numeric RGB, font shorthand and inline fontSize. Every case exited 1 with the matching diagnostic; the probe was removed and the tree passes.
- `node scripts/check-native-token-parity.mjs`: passes, 27 mappings in both appearances.
- `pnpm --pm-on-fail=ignore typecheck`: passes.
- `pnpm --pm-on-fail=ignore lint`: passes, including both guards; existing lint warnings remain.
- `pnpm --pm-on-fail=ignore build`: passes; existing transformWithEsbuild deprecation warning remains.
- `git diff --check`: passes.

The installed pnpm is 11.25.0 while package.json pins 11.1.3. Plain pnpm typecheck/lint attempted an online signature/version fetch and failed because the sandbox cannot reach the registry. The documented `--pm-on-fail=ignore` option runs the installed pnpm and the same repository scripts; neither the dependency lockfile nor package-manager pin was changed.

The initial exact Swift command failed opening `/Users/gabrielcsapo/.cache/clang/ModuleCache/Swift-7JL1KBZ3A6V3.swiftmodule` with “Operation not permitted”, then “unable to load standard library”. Redirecting caches initially found no dependencies offline. Existing bare dependency repositories were copied read-only from the machine cache into `/tmp/tokens-pass-swiftpm/repositories`, and this final command passed:

```sh
CLANG_MODULE_CACHE_PATH=/tmp/tokens-pass-clang-cache \
SWIFTPM_MODULECACHE_OVERRIDE=/tmp/tokens-pass-swift-cache \
swift build --package-path native/Apple/Packages/DeployKit \
  --cache-path /tmp/tokens-pass-swiftpm \
  --config-path /tmp/tokens-pass-swiftpm-config \
  --security-path /tmp/tokens-pass-swiftpm-security \
  --disable-sandbox --skip-update
```

## Rendered review

The repository's visual audit ran outside the sandbox against a seeded demo server. The seed still creates retired portable-site rows that `assertHomeCoordinator` rejects at startup, so a scratch wrapper removed those rows after seeding.

- Dark, desktop and mobile, against an untouched 3179c28 build: both produced 52 captures, with the same 61 failing flows and 32 browser errors. Those failures come from stale audit flows such as `signal-*`, `topology-zoom` and the inspectors, and none is a regression. Applications and the application overview show the solid action, sentence-case status badges (healthy dot, hollow inactive, amber attention) and neutral surfaces.
- Light, desktop: the first light ladder made the page lighter than its surfaces, so the composer, selects and secondary buttons rendered as grey fills that read as disabled. The ladder was corrected to the values above. A re-capture shows white composer, field and button surfaces on the light canvas.
- After the correction, typecheck, lint (with both guards), build and `swift build` for DeployKit passed again outside the sandbox.

## Verification limits

The isolated existing visual-audit harness failed at `listen EPERM: operation not permitted 127.0.0.1`. A separate installed Chromium launch failed at `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`. Inside the sandbox, no screenshots could be taken. The rendered review above covers desktop and mobile web in dark mode and desktop web in light mode. Keyboard, forced-color and reduced-motion interactions, macOS and iOS visuals, and Dynamic Type sizes have not been checked visually. Existing reduced-motion and forced-colors rules were preserved; the new badge includes a forced-colors dot treatment. macOS package compilation succeeded; an iOS simulator build was not run.
