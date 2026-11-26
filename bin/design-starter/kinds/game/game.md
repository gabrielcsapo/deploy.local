## Game kind: a game's screens, calm and playable

A game board is one screen on a phone: `<meta name="design-board" content="platform=game,device=phone,schemes=light dark">` (390 × 844; a landscape screen is `width=844,height=390` with `.ds-game.landscape`). Boards link `tokens.css`, `components.css` and `game.css`; the body starts with `.ds-game`. The check draws it once at its size in light and dark. The app-only notes (tab bars, navigation bars) do not apply: a game screen is full-screen.

- **Type is the game scale.** `--text-game-display` 56 (the title screen), `--text-game-score` 40 (the number that matters), `--text-game-title` 28, `--text-game-body` and `--text-game-hud` 17, `--text-game-label` 13. Numbers are tabular. Nothing under 13, because it is read while moving.
- **Thumb-sized.** Buttons are `.ds-game-btn`: 56 px circles (44 px minimum, `.small`), one primary (near-black) per screen. A button the player presses repeatedly is at the bottom third of the screen, within reach of a thumb; pause and close are at the top corners and are `.small`.
- **The stage is calm.** `.ds-game-stage` is the playfield: a quiet ground, a few flat shapes from the tokens. The game's own art is not drawn in the starter; use neutral shapes (circles, rounded squares) in ink, grey and the accent, no gradients or glows. Every colour from a token, so dark mode works.
- **HUD.** `.ds-game-hud` at the top: pause at the left, the score or level name in the middle, lives (`.ds-game-pips`) or time at the right. Three things at most. It is never over the player's thumb.
- **Level select.** `.ds-game-grid`, four across; tiles are `.locked` (dashed, no number emphasis, a lock), `.available` (accent border, accent number) or `.done` (filled, a check). One available tile at a time is the next level.
- **Result.** `.ds-game-result`: a title, up to three stars (`.off` for missing), the score and two stats, then the actions under it: one primary (Next) and one secondary (Replay). Never a modal of five buttons.
- **Pause.** `.ds-game-sheet` over `.ds-game-dim`: Resume (primary), Restart, Quit. Three actions; settings are one more row only if the game has them.
- **Safe areas.** 54 px top and 34 px bottom on the phone, and 54 px on the sides in landscape; nothing tappable under the home indicator.

What agents get wrong for games:

- Making it loud: neon, gradients, glows, many colours, confetti. A calm game is a design choice; the player's attention goes to the stage.
- Tiny controls and links in the HUD. Everything pressed in play is at least 44 px.
- A screen of text. A game screen says one thing: a title and Play, a grid of levels, the score.
- Using an app's tab bar or navigation bar. Games have a back or close icon at a corner, not a tab bar.
- Showing the stage with no content. Draw a few shapes so the screen shows where things go.
