# Checkpoint deltas

A `deploy_checkpoint` used to copy every tracked and untracked workspace file into one
base64 JSON blob capped at 8 MiB. Any real repository is larger than that, so no task in
one could checkpoint, run a checkpoint job, commit, deploy or publish at all. A checkpoint
in a repository conversation is now a **delta over a commit the coordinator already has**,
so its size follows the change rather than the repository.

## Snapshot shape

```ts
type Snapshot = {
  base?: { commit: string }; // the commit `files`/`deleted` are measured against
  files: { path: string; content: string; executable: boolean }[];
  deleted?: string[]; // paths the delta removes from the base tree
  excluded: string[];
  digest: string;
};
```

Without `base`, `files` is the whole workspace: the shape conversations without a
repository keep, and the shape of every checkpoint recorded before this change. The digest
covers `base`, `files` and `deleted`; a full-tree snapshot keeps hashing `files` alone, so
stored records stay valid. `deleted` without a `base` is rejected, as is a `base` whose
commit is not a plain object ID.

Limits, all enforced on capture and again in `validateSnapshot`:

| Shape                 | Total content | One file |
| --------------------- | ------------- | -------- |
| Delta over a `base`   | 64 MiB        | 16 MiB   |
| Full tree (no `base`) | 8 MiB         | 8 MiB    |

Both limits keep the 10,000-entry cap, and either error names the measured size and the
largest files so the agent knows what to remove, ignore or commit.

## Recording the base

Workers write the commit they prepared a workspace from to `deploy-checkpoint-base` inside
that workspace's own Git directory: per worktree, never inside the tree, never part of a
checkpoint. It is written when the repository runner adds the worktree, when a remote
worker clones, at every local and remote run start (so workspaces prepared before this
change also get one), when `refreshCommitBaseline` installs a `deploy_commit` baseline, and
when `deploy_create_repository` installs its initial commit. `readCheckpointBase` ignores a
marker whose commit the workspace no longer has.

## Capturing

With a usable base, capture diffs the working tree against it:

- `git diff --name-status -z --no-renames --ignore-submodules=all <base>` for tracked
  changes, so a rename arrives as a deletion plus an addition and a mode-only change is an
  ordinary modification.
- `git ls-files -z --others --exclude-standard` for untracked files, so `.gitignore` still
  applies.
- The existing rules then apply unchanged: credential-like and private paths, symlinks,
  symlinked parents and non-regular files go to `excluded`; executable bits are preserved.
  A path that Git reports as deleted but that exists as an untracked file is carried as a
  file, not removed.

Without a usable base, capture falls back to the full tree under the 8 MiB limit.

## Materializing

Every consumer reads base + delta, so each still sees a complete tree:

| Consumer                                           | How it gets the base tree                                   |
| -------------------------------------------------- | ----------------------------------------------------------- |
| `deploy_commit`, Publish (`buildCheckpointCommit`) | `read-tree <base>`, deletions, then the files               |
| `deploy_application` (`checkpointBundle`)          | `extractBaseTree` from the hosted repository                |
| Checkpoint jobs (`job-runner`)                     | `fetchBaseTree` over `/api/git` with the worker's token     |
| Task detail (`checkpointChangedFileCount`)         | compares the base tree plus delta with the task's diff base |

`restoreSnapshot` still writes full-tree checkpoints and refuses a delta; `restoreCheckpoint`
takes a callback that writes the base tree first. Jobs keep getting a fresh, isolated
directory, and no checkpoint ever carries Git metadata into it.

When the coordinator stores a delta it verifies the base commit is in the task's hosted
repository and pins it under `refs/deploy/checkpoint/<hash of owner + operationId>`. The ref
makes the commit fetchable by name (no bare-object-ID fetch) and keeps it reachable for
every later reader even if the task branch moves. An unknown base commit is refused at
capture time with the commit named, rather than failing later in a job or a commit.

## Limitations

- A base tree is materialized with `git checkout-index`, so files that come from the base
  keep Git's modes while delta files keep the checkpoint's own `0600`/`0700`.
- Git LFS content is not hydrated into a materialized base tree; those paths hold their
  pointer files unless the delta carries the real bytes.
- A job or deploy now transfers the base tree, so a large repository costs that transfer
  once per job even when the delta is tiny.
