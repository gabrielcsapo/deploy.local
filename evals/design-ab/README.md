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

## Rerun

    python3 setup.py /tmp/ab ~/.ab-key.json      # then run each /tmp/ab/runs/rNN/prompt.txt in a fresh agent
    # arm A: (cd <proj> && deploy design export)
    DEPLOY_CHROMIUM=/tmp/chromium node evals/design-ab/render_pages.mjs ~/.ab-key.json /tmp/ab/render
    python3 render_models.py ~/.ab-key.json /tmp/ab/render
    python3 make_blind.py ~/.ab-key.json /tmp/ab/render /tmp/ab/blind ~/.ab-blind.json
    # run each /tmp/ab/blind/<kind>-judgeN/prompt.txt in a fresh agent, save its JSON as <kind>-judgeN.json
    python3 score.py ~/.ab-key.json ~/.ab-blind.json <judgements dir>

`make_blind.py` also writes each judge's prompt.txt from `judge_prompt.md` and `briefs.json`.
