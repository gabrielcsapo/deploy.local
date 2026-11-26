## Game kind: a game's screens, calm and playable

A game board is one screen on a phone: `<meta name="design-board" content="platform=game,device=phone,schemes=light dark">` (390 × 844; a landscape screen is `width=844,height=390` with `.ds-game.landscape`). Boards link `tokens.css`, `components.css` and `game.css`; the body starts with `.ds-game`. The check draws it once at its size in light and dark. A board carries no `<style>`: `game.css` sets the page's margin and ground. The app-only notes (tab bars, navigation bars) do not apply, but the iPhone frame does: the check expects the status bar and keeps taps out of the safe areas. A screen that really hides the status bar (play in landscape, a cutscene) says `immersive=true` in its head, and then the check skips both.

- **Type is the game scale.** `--text-game-display` 56 (the title screen), `--text-game-score` 40 (the number that matters), `--text-game-title` 28, `--text-game-body` and `--text-game-hud` 17, `--text-game-label` 13. Numbers are tabular. Nothing under 13, because it is read while moving.
- **Thumb-sized.** Buttons are `.ds-game-btn`: 56 px circles (44 px minimum, `.small`), one primary (near-black) per screen. A button the player presses repeatedly is at the bottom third of the screen, within reach of a thumb; pause and close are at the top corners and are `.small`.
- **The stage is calm.** `.ds-game-stage` is the playfield: a quiet ground, a few flat shapes from the tokens. The game's own art is not drawn in the starter; use neutral shapes (circles, rounded squares) in ink, grey and the accent, no gradients or glows. Every colour from a token, so dark mode works.
- **HUD.** `.ds-game-hud` at the top: pause at the left, the score or level name in the middle, lives (`.ds-game-pips`) or time at the right. Three things at most. It is never over the player's thumb.
- **Level select.** `.ds-game-grid`, four across; tiles are `.locked` (dashed, no number emphasis, a lock), `.available` (accent border, accent number) or `.done` (filled, a check). One available tile at a time is the next level.
- **Result.** `.ds-game-result`: a title, up to three stars (`.off` for missing), the score and two stats, then the actions under it: one primary (Next) and one secondary (Replay). Never a modal of five buttons.
- **Pause.** `.ds-game-sheet` over `.ds-game-dim`: Resume (primary), Restart, Quit. Three actions; settings are one more row only if the game has them.
- **The iPhone frame.** Every portrait screen starts with `.ds-game-status` (the status bar: time at the left, signal and battery at the right) and ends with `.ds-game-home` (the home indicator), both children of `.ds-game`. They are the device's, not content: the time and glyphs are the iOS fixture and need no `data-question`. The 54 px top and 34 px bottom padding is the safe area: the HUD, stage and every button live inside it, nothing tappable under the status bar or the home indicator. Landscape has no status bar and 54 px side insets.
- **A grid that fits.** `.ds-game-grid` is four across at 390 (80 px tiles at the 12 gap), `.five` is five (65 px at the 8 gap), `.three` for three; never six, a tile is never under 44 px, and a grid with more rows than the screen holds sits in `.ds-game-scroll`, never clipped by the frame or the home indicator.
- **Labelled controls.** Every control has an `aria-label`; a control whose icon is not universal (jump, boost, aim) also has a caption under it (`.ds-game-control` with a `.ds-game-label`). Pause, close, back and sound are understood without one. Never a row of unlabelled glyphs.
- **Progress captions.** A progress bar (`.ds-game-progress`) has its caption 8 px under it and 24 px of air before what follows; a caption under a title is 4 px below it (`.ds-game-heading`). The caption's numbers ("n of m done") are the game's own, never made up.
- **Sample content and product facts.** What play produces (a score, a level's name or room number, a player's name, stars earned) is sample content: draw it plausible and specific ("Room 14: the flooded cellar", "Juniper", `12,480`), with no flag. What the game decides (how many levels there are, what a star unlocks, a daily reward, a price, a lives rule) is a product fact: left out, or drawn plausible and flagged with `data-question`. Never `000`, "Level one" or "Item one": a screen of filler is a wireframe. Worked example: "Room 14" on a level tile is sample; "3 lives, refilled every 30 minutes" is a fact and carries the flag. A reviewer lists each unflagged fact as a `[fact]` finding, and filler as one too.

What agents get wrong for games:

- A game screen with no status bar or home indicator, so the phone frame is missing and the layout ignores the safe areas.
- Level grids that clip at 390, or captions glued to the grid or floating away from their bar.
- Icon-only controls with nothing saying what they do.
- Meta without `width=390,height=844`, so the check treats it as a web board.

- Making it loud: neon, gradients, glows, many colours, confetti. A calm game is a design choice; the player's attention goes to the stage.
- Tiny controls and links in the HUD. Everything pressed in play is at least 44 px.
- A screen of text. A game screen says one thing: a title and Play, a grid of levels, the score.
- Using an app's tab bar or navigation bar. Games have a back or close icon at a corner, not a tab bar.
- Showing the stage with no content. Draw a few shapes so the screen shows where things go.
