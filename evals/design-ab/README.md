# Blind A/B test of the design pipeline

Does a fresh agent make better design work with `deploy design` (kit, check, README) than without it?
Evaluation only; nothing here is used by the product.

## Method

1. A fresh agent with no project context wrote six new briefs (`briefs.json`): two pixel-art sprite
   sets, two low-poly game props, two phone screens.
2. `setup.py` made 24 fresh git projects, 2 per arm per brief, in shuffled order. Arm A ran
   `deploy design init --kind <art|model|app>` on main first and was told only to read
   design/README.md and follow it. Arm B got an empty repo and a fixed output path (SVGs, a .glb,
   one HTML page). Both got the same environment notes and no coaching. Designers were Sonnet.
3. Everything was rendered the same way, with no names on it: `deploy design export` for arm A, then
   `render_pages.mjs` (sprites in play on the brief's background, tile 3 x 3, 8x close-up; phone
   screens at 390 x 844) and `render_models.py` (four views from bin/design-blender.py, a far
   thumbnail, measured triangles and size).
4. `make_blind.py` copied the renders under shuffled letters, separately for two judges per kind.
   Each judge (Sonnet, fresh) scored all four candidates of a brief 1 to 5 on fulfils, reads,
   craft and ready, and ranked them (`judge_prompt.md`).
5. `score.py` unblinded. Every A run is paired with every B run on the same brief (4 pairs a brief,
   8 a kind). A pair is a win only when both judges agree.

## Result (2026-11-28, pipeline/all at eb446e81)

| kind  | pipeline won | lost | split | mean "ready" A / B |
| ----- | -----------: | ---: | ----: | -----------------: |
| art   |            0 |    6 |     2 |        3.00 / 3.62 |
| model |            2 |    6 |     0 |        2.62 / 3.12 |
| ui    |            0 |    7 |     1 |        2.62 / 3.62 |

The pipeline lost on every kind. Every B run also met the briefs' hard limits (palette counts in
`results/art-palette-counts.json`, triangles and size on the model sheets), so the checks caught
nothing the other arm got wrong.

Raw judgements, the unblinding key and `results.json` (ranks and every flaw line) are in `results/`.

## Round 2 (2026-11-28, after the fixes in a81574af)

Fixes from round 1: art and model start almost empty on the kit's sample palette, with the
starter's layer names free to change; the README and review questions ask what the brief needs
instead of the kit's phone look; models gain `lathe` and `beam` and the check names parts past the
box; init ignores output/. Six new briefs from a fresh writer (`briefs-round2.json`, no round-1
themes), same harness and judges, results in `results/round2/`.

| kind  | pipeline won | lost | split | mean "ready" A / B | round 1 won / lost |
| ----- | -----------: | ---: | ----: | -----------------: | -----------------: |
| art   |            4 |    3 |     1 |        3.38 / 2.88 |              0 / 6 |
| model |            0 |    5 |     3 |        2.75 / 3.38 |              2 / 6 |
| ui    |            4 |    0 |     4 |        3.88 / 2.88 |              0 / 7 |

Caveats: 8 pairs a kind is small, and the two UI judges disagreed often on ui-1 (all 4 pairs split).
Several arm-B designers could not get a screenshot from /tmp/chromium and checked by arithmetic,
while arm A's check drew its pictures for it; round 1 had the same environment notes.

## Round 3 (2026-11-28, Opus designers, pipeline/all at 0568d3c2)

Same method as round 2 on six fresh briefs (`briefs-round3.json`), but every designer was Opus.
Judges stayed Sonnet so the rounds compare. Two changes to the renders, applied to both arms:
the model sheet adds the view from underneath (one brief hangs overhead), and a phone brief can
name its colour scheme (`render.scheme`; ui-2 asks for a dark theme). Results in `results/round3/`.

| kind  | pipeline won | lost | split | mean "ready" A / B | round 2 (Sonnet) won / lost |
| ----- | -----------: | ---: | ----: | -----------------: | --------------------------: |
| art   |            4 |    4 |     0 |        3.50 / 3.12 |                       4 / 3 |
| model |            0 |    6 |     2 |        3.12 / 3.88 |                       0 / 5 |
| ui    |            1 |    6 |     1 |        3.00 / 3.62 |                       4 / 0 |

What the judges and pictures show:

- UI: both pipeline screens for ui-1 kept the kit's grey grouped background and near-black button;
  both Opus screens without it used the brand's green and bolder type and won every pair. With
  Sonnet the kit lifted weak screens; with Opus it pulls strong ones back to the kit's look.
- Models: both pipeline carousel horses ended the pole on the saddle instead of running it
  through the body, the one thing the brief needed read from below. The semaphores were close.
- Art: even; the one pipeline set that drew no outline (its darkest colour matched the ground)
  ranked third, and the other ranked first on art-1.
- Opus runs without the pipeline also met the briefs' hard limits and checked their own work with
  scripts, so the check again caught nothing they missed.

Caveats as before: 8 pairs a kind, and the briefs differ from round 2, so the absolute scores do
not compare cleanly between rounds. Several designers in both arms said /tmp/chromium hung for
them.

## Rounds 4 to 8 (2026-11-28, the open canvas, Opus designers, Sonnet and Opus judges)

The kits are gone: `deploy design init` starts an open canvas (a short README, the project's own
look.css and one blank board), and the check stops only on breakage and on limits a board's head
states (`min-text=`, `pages=`, `tris=` and the rest). Briefs are fresh and cover all nine kinds
(`results/round6/briefs.json`). Every designer is Opus with no coaching beyond the brief. Each
pair is judged twice, blind: judge1 is Sonnet, judge2 is Opus. Arm B (no pipeline, plain files) was
run once, in round 4; later rounds rerun arm A only on the briefs it had not yet won or tied, against
those same B runs, after fixing what the round showed. Results are in `results/round4` to `round8`.

Latest result per brief, arm A against arm B (W won with both judges, L lost with both, S split):

| kind   | briefs and result    | rounds it took   |
| ------ | -------------------- | ---------------- |
| ui     | ui-1 W, ui-2 W       | 4; 7             |
| model  | model-1 W, model-2 S | 4; 6             |
| print  | print-1 W            | 4                |
| logo   | logo-1 W             | 6                |
| mac    | mac-1 S              | every round      |
| slides | slides-1 S           | 6                |
| doc    | doc-1 S              | 7                |
| art    | art-2 W, art-1 L     | art-1 lost 4–7   |
| game   | game-1 L             | tied 4, lost 5–8 |

The two judges agreed on 29 of the 37 pairs in rounds 4 to 8. Seven kinds now win or tie. art-1 and game-1 lose on taste
at one run a side: the cart's steam and the cobble tile in art-1, and in game-1 the unearned shell
drawn as a dashed outline and the shells' sizes. The check cannot settle these without a kit.

Hand-off (`results/handoff`): a second Opus designer, who never met the first, added a barcode
screen to the pharmacy app (ui-1) and two slides to the library deck (slides-1). Judged on
consistency with the existing work, the brief and craft, arm A won all four judgements (both kinds,
both judges). Arm B's added deck repeated its own closing slide.

Tokens per designer run (subagent tokens less about 125k of fixed context; tool calls; minutes):

| run set        | working tokens | tool calls | minutes |
| -------------- | -------------: | ---------: | ------: |
| arm B, round 4 |            40k |       26.8 |     7.8 |
| arm A, round 4 |            61k |       35.8 |     7.1 |
| arm A, round 5 |            58k |       34.6 |     7.0 |
| arm A, round 6 |            46k |       28.2 |     5.5 |
| arm A, round 7 |            45k |       26.5 |     5.8 |

What the rounds fixed, each from a misuse or a flaw the check missed:

- `look` and `status` follow the canvas's schemes; `look --zoom 0.25` shows work as met from afar.
- `min-text=` (px or pt) in a board's head stops the check on smaller text.
- Text over text, a label past or pressed against its button's edge, and words that print over the
  next sheet of a document stop the check.
- The untouched starting board left beside the designer's own stops the check.
- A phone game starts inside its status bar and home indicator, and a game board without one gets
  a note on the open canvas too.

Gaps left: designers report `/tmp/chromium --dump-dom` hanging when they launch it themselves (an
environment issue); `look --zoom` with `--angle` zooms the board, not the turned view; art export
writes every drawn copy of a sprite unless it is marked `art-copy`; slides are judged from a picture
640 wide.

## Rerun

    BRIEFS=briefs-round2.json python3 setup.py /tmp/ab ~/.ab-key.json   # BRIEFS picks a briefs file for setup, render and make_blind
         # then run each /tmp/ab/runs/rNN/prompt.txt in a fresh agent
    # arm A: (cd <proj> && deploy design export)
    DEPLOY_CHROMIUM=/tmp/chromium node evals/design-ab/render_pages.mjs ~/.ab-key.json /tmp/ab/render
    python3 render_models.py ~/.ab-key.json /tmp/ab/render
    python3 make_blind.py ~/.ab-key.json /tmp/ab/render /tmp/ab/blind ~/.ab-blind.json
    # run each /tmp/ab/blind/<kind>-judgeN/prompt.txt in a fresh agent, save its JSON as <kind>-judgeN.json
    python3 score.py ~/.ab-key.json ~/.ab-blind.json <judgements dir>

`make_blind.py` also writes each judge's prompt.txt from `judge_prompt.md` and `briefs.json`.

## Round 9 (2026-11-28, style left to the brief, three plain draws a brief)

What changed first (commit 49294161 and the next): pixel grid and fixed palettes are advice unless the
board head says `pixels=hard` or `palette=` (which also caps the colour count); one primary button,
near alignment and row heights only hold for a project with a design system; the README drops its
"simplify it until" rule and keeps the brief in `design/brief.md`, whose figures are never asked
about; the art starter has no colours; a renamed board keeps its canvas place; a sprite drawn twice
is exported once; `look` keeps only the newest picture of a board.

Runs: art-1, art-2 and game-1 from round 4, Opus designers, 2 flow runs (A) and 3 plain runs (B) a
brief, so each A is compared with three B draws. Judges: Sonnet (judge1) and Opus (judge2).

| Brief  | Won | Lost | Split | Note                                                                                            |
| ------ | --- | ---- | ----- | ----------------------------------------------------------------------------------------------- |
| art-1  | 0   | 0    | 6     | the judges disagree on every pair: Sonnet put both A runs last, Opus put them first and second  |
| art-2  | 2   | 3    | 1     | one A run first or second with both judges, the other last with both                            |
| game-1 | 3   | 2    | 1     | A runs 2nd and 3rd/4th of 5; one B run first with both; one B run missed the three-shell rating |

Mean "ready": art A 3.25, B 3.50; game A 3.75, B 2.83. Both art A runs switched on `palette=` and
`pixels=hard` themselves, because both art briefs ask for pixel art: the art check was never what lost
art-1. Against three draws, art-1 and game-1 no longer lose; the round 4 to 8 losses were one draw.
Working tokens a run (less about 125k fixed): art-1 A 86k, B 77k; art-2 A 76k, B 57k; game-1 A 41k,
B 32k. Minutes: A 4 to 11, B 8 to 19 (every B run lost time to a Chromium that hung).
Results: results/round9.
