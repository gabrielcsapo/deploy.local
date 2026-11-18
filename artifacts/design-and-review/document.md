# Design and review, end to end

Status: proposal, waiting for the owner's approval. Nothing here is built. Every change to a screen that this document describes still gets its own boards and its own approval before it is built.

## Why change it

The rule is sound: a visible change is drawn first, the owner approves it, the approved design is on main, and the product is built to match. In the three weeks to 2026-11-17, 82 designs were approved that way, about five a day. This proposal keeps the rule and fixes the places where following it costs more than it should.

- One change to the sidebar reached review as 235 changed boards. The sidebar is already a shared component with 242 instances that re-sync when a design lands, but the branch carried every re-synced board, so the review was 234 screens long and conflicted with every other open review.
- A session that is not a deploy.local task has no command to propose a design, and when the owner asks for changes on its branch, nobody is told.
- The review on the web moved onto the canvas on 2026-11-12, and it does less than the iPhone review: no second-round view, no pins or drawing, no wipe, no choice of width. Sixteen boards of the earlier one-surface review are still on main beside the two canvas review boards, so the design shows two reviews and does not say which one is the product.
- After approval nothing tracks the design. There is no list of designs that are approved and not built, the check that the app matches is the building agent's own word, and boards have been corrected after the fact to match what shipped.
- Nothing ends. Five design branches are 250 to 400 commits behind main with changes main does not have, and no review is open for them.
- Dark mode is never reviewed. The server draws boards in light mode only.
- A one-word change and a 235-board change go through the same steps, and those steps are five separate commands described in three places.

## What it is for

Four things the process has to do. Each stage below is judged against them.

1. The design on main is the product. If they differ, something says so.
2. The owner's attention is the scarce part. A review shows what needs a decision and nothing else.
3. The loop is the same for whoever does the work: an agent in a task, a session on a laptop, or the owner by hand.
4. The effort matches the size of the change.

## The experience, stage by stage

### 1. Start

One command starts a design change:

```
deploy design start "Sidebar by project"
```

It fetches main, makes the design branch from it in its own worktree, and records who is working there. An agent in a task does the same with its design tool. Starting from a stale checkout stops being possible, so the renderer's stale-checkout refusal and the notes that warn about it are no longer needed.

### 2. Draw

Chrome that repeats is drawn once. The sidebar already is: it is a component in the design system's library, and its instances re-sync when a design lands. The page header, the tab bar and the phone's navigation join it. A branch changes the component and leaves the instances to the landing.

A change to the sidebar is then one file on the branch. The screens that show it are worked out when the review is drawn and when the design lands, and deploy design check refuses a branch that carries re-synced instances. Two branches that touch different screens stop conflicting through the sidebar.

### 3. Check your own work

One command replaces render, layer IDs, pairing and the screenshot for the conversation:

```
deploy design check
```

It gives new elements their layer IDs, draws every changed board at its widths in light and dark, pairs each with main, and prints what it found: boards changed, screens affected through a shared part, anything that overflows at 700 px, any layer ID lost. The pairs are what the author looks at and what goes into the conversation.

### 4. Propose

```
deploy design propose
```

The author gives a title, a summary in words, and the screens to look at first. The proposal follows its branch: a new commit updates the open review and tells the owner what changed, so a review never shows an older commit than the branch holds.

deploy.local sizes the proposal. Small is up to three boards with no shared part and no new board. Everything else is large. The size decides how it is presented, not whether it is reviewed.

### 5. Review

One review, on the canvas on the web and with the same abilities on the iPhone.

- It opens on a cover: the summary, then the changes grouped. A shared part is one row, "Sidebar · 234 screens". The owner looks at it on one or two screens and that counts for all of them. Screens with their own changes follow, each with its change in words.
- Any screen can be compared side by side or with a wipe, at 1440, 700 or 390, in light or dark.
- Feedback is a pin on a point, an area, or a layer, with words. Both the web and the iPhone can make them.
- The tick on a board says Seen, because that is what it records. Approval is still one answer for the whole proposal.
- A small proposal is answered from its card in Waiting on you, with Before and After in the card.
- A proposal that would conflict with another open one says so before the owner starts: "Lands cleanly after Projects first". When main has moved, the author is asked to update by default. The owner is only asked to choose when two designs really disagree about the same part.

### 6. Feedback reaches the author

Every review has one thread that holds the owner's note, the pins and the author's replies. The author reads it wherever they are:

```
deploy design feedback
```

A task gets it as a message, as now. A session outside a task waits on it from the command line. If nobody is working on the branch, the review says so and offers to start a task, instead of sending the note nowhere.

The next round shows only what changed since the owner last looked, with each pin marked Addressed or Still open. The iPhone does this today; the web gains it. Rounds stay attached to the proposal even when a different task or session picks it up.

### 7. Approve and land

Approve keeps its 30-second undo. When the design lands, deploy.local deletes the branch on origin, and the author's worktree and local branch are removed the next time they run a design command. A landing that fails says it failed. Today the web can show "on main" for a design that hit a conflict.

### 8. Build

An approved design is a thing to do, and deploy.local keeps the list. Each is in one state: To build, Building, Built, or Differs. The Design page shows the count, "4 approved, not built", and the list.

Building starts from the list, in a task or from a session that claims it:

```
deploy design build sidebar-by-project
```

The command prints the brief: the boards, their widths, the fixture names and the words that changed. A pull request that changes files people see, with no approved design behind it, carries a note saying so. The owner can dismiss the note when nothing visible changed.

### 9. Verify

The tool makes the comparison, not the agent's report:

```
deploy design verify
```

It captures the running app at each board's widths in light and dark, pairs each capture with its board, measures how far apart they are, and attaches the pairs to the design's entry. The agent adds what it knows: which differences are deliberate and why.

A match closes the entry as Built without asking the owner. A difference becomes the decision that exists today: fix the app, or keep it and update the board. The iPhone gains that decision. The pairs are kept by deploy.local with the design, not committed under docs/evidence, which holds 1,853 files and 162 MB today.

### 10. Upkeep

- A proposal with no activity for 14 days is parked. The Design page lists parked proposals with Revive and Withdraw.
- Withdrawing deletes the branch.
- An entry left at To build for 14 days shows in Waiting on you once, as a question: still wanted?

## What stays the same

- Boards are HTML in the repository, built from the design system, and every element keeps its layer ID.
- The owner approves every visible change before it is built.
- Approval puts the design on main.

## Decisions for the owner

1. Approve part of a proposal. Recommended: no. Grouping and smaller proposals do the same job without a proposal that is half on main.
2. The note on a pull request with no design. Recommended: a note the owner can dismiss, not a block. Make it a block later if designs are still skipped.
3. Small changes in one step. For a small proposal, the author could build it on a branch and propose the board and the running app together, for one approval. It is faster, and it bends the rule that nothing is built before approval. Recommended: not yet. See what the faster card does first.
4. The five stale design branches: app-performance, default-health-check, design-page-narrow-bar, desktop-runs-the-worker and release-and-computer-stats. Recommended: the owner looks at each once and it is revived or withdrawn, before parking is built.

5. The sixteen boards of the earlier one-surface review. Recommended: retire the ones the canvas review replaced, and redraw on the canvas any state that is still wanted, so the design shows one review.

## Order of work

Each step is useful without the ones after it.

1. The deploy design commands (start, check, propose, feedback), feedback that always reaches someone, branches removed on landing, and the known faults: the inbox prints the conflict line under the wrong proposal, one broken landing blocks the ones behind it, and a conflicted landing reads as on main.
2. Branches that change a shared component without carrying its instances, more chrome in the library, and grouped rows in the web review.
3. The canvas review on the web catches up with the iPhone: second round, pins, wipe and width, with dark mode on both. The boards of the earlier one-surface review are retired or redrawn on the canvas.
4. The list of approved designs, build and verify from the command line, and evidence kept out of the repository.
5. Small proposals answered from their card, parking, and the note on pull requests.

AGENTS.md and design/README.md are rewritten at step 1 to describe the commands, so the process is written down once.
