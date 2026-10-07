# Built-in deployment

Opt-in desktop feature: after a sync that **pushed a commit**, publish this vault's notes to
the website project, build it, and push the result to your server — all from FIT settings,
with no shell script and no CI round-trip.

It is the same pipeline the equivalent shell tooling runs by hand
(`sync content → npm run build → rsync dist/`), reimplemented as three sequential stages so a
failure at any one of them stops the run before the next:

1. **Content** — copy `.md`/`.mdx` notes from `vaultContentPath` into the project's
   `src/content/` collections, pruning entries the vault no longer has.
2. **Build** — `npm run build` in `astroProjectPath`.
3. **Upload** — `rsync` the built `dist/` to `sftpRemotePath` over SSH.

It is off by default and does nothing on mobile.

## What triggers it

A sync run in which FIT actually wrote local changes to the remote repo — a non-empty
[`SyncResult.pushedRemoteChanges`](../src/syncResult.ts), the same commit gate the
[post-sync hook](post-sync-hook.md) uses.

| Situation | Deploy runs? |
| --------- | ------------ |
| Manual sync that pushed an edit | ✅ |
| Auto sync that pushed an edit | ✅ |
| Sync that only pulled remote changes | ❌ — nothing new to build |
| Sync with no changes at all | ❌ |
| Sync that failed | ❌ |
| Sync whose files were skipped (API size limit, rate limiting) | ❌ — nothing was committed |
| "Run deployment" command, or "Run now" in settings | ✅ — bypasses the commit gate on purpose |

## Configuration

FIT settings → **Deployment configuration (desktop only)**:

| Setting | Meaning |
| ------- | ------- |
| Enable auto-deploy | Master switch. Off by default. |
| Astro project path | Local checkout of the website project. `npm run build` runs here and `dist/` is read from here. |
| Vault content path | Vault folder holding the publishable notes, with `project/` and `journal/` subfolders. |
| Server host | Deployment server: hostname or IP address. |
| Server port | SSH port. Falls back to 22 when empty or out of range. |
| Server user | SSH user the site is published as. |
| Server password | Optional. Empty selects key or ssh-agent auth, which is preferred. Needs `sshpass` when set. |
| Remote path | Directory on the server that `dist/` is published into. |

**Defaults.** Every path and server field ships with this device's value already filled in
(`DEFAULT_SETTINGS` in [src/fitSettings.ts](../src/fitSettings.ts)), so a fresh or previously
unconfigured install opens the tab ready to run rather than with blank fields. The same values
are used as the input placeholders. A field saved as an empty string is read as "never
configured here" and re-adopts its default on the next load (`withDefaults`), rather than
shadowing it forever.

The tab also shows a **Readiness** line that runs the same `missingDeploymentSettings` check
the deployer does, so the UI cannot promise more than the next run will deliver, and warns when
both auto-deploy and the post-sync hook are enabled (see below).

**Pre-flight.** "Run now" (and the `Run deployment` command) validate before anything starts:
`deploymentConfigurationProblem` checks that the five required fields are filled *and* that both
local paths exist. A problem is reported as a sticky error Notice and no stage runs — an empty
path surfaces as one message, not as a deploy that died in its first stage.

## Run log

Every run appends to **`~/.fit-deploy.log`** (`DEPLOYMENT_LOG_FILENAME`; one line per entry,
ISO timestamp first), in addition to the FIT debug log:

```
2026-10-07T11:40:02.118Z [deploy] ===== run started 2026-10-07T11:40:02.117Z =====
2026-10-07T11:40:02.119Z [deploy] project: /home/you/site
2026-10-07T11:40:02.120Z [deploy] vault: /home/you/vault/site
2026-10-07T11:40:02.121Z [deploy] target: ubuntu@45.135.242.135:/opt/arman-hosseini (port 22)
2026-10-07T11:40:02.122Z [deploy] stage: content
...
2026-10-07T11:40:31.400Z [deploy] ===== success in 29s — 4 file(s) copied, 1 removed, 12 uploaded from /home/you/site/dist =====
```

Failures end with `[deploy] ===== run failed during <stage> — <reason> =====`, so the tail of
the file is always the verdict of the latest run. The child processes' stdout/stderr is appended
as it arrives, which makes `tail -f ~/.fit-deploy.log` a live view of a build. The active log
is rotated to `~/.fit-deploy.log.1` as soon as it passes `DEPLOYMENT_LOG_MAX_BYTES` (512 KiB) —
checked at run start and again before every line, so a chatty build can overrun it by at most
one line rather than for the rest of the run; only one older generation is kept.
`DeploymentOptions.logPath` overrides the location, and `logPath: null` disables file logging
entirely (the tests use both so a suite run never touches the developer's home directory).

## Behaviour notes

- **Not awaited by the sync.** The sync completes and its notice is dismissed first, so a
  multi-minute build never holds the sync UI open. Progress is a sticky Notice that updates per
  stage, and every stage's output goes to `.obsidian/plugins/fit/debug.log` with a `[Deploy]`
  prefix and to `~/.fit-deploy.log`.
- **"Run deployment now" bypasses only the commit gate.** It runs the identical
  `content → build → upload` pipeline (no git commit or push either way), skipping the "did this
  sync push a commit" condition, after the pre-flight above.
- **Re-entrancy guarded.** A second sync while a deployment is running does not start a second
  build against the same working tree; the run is skipped with a Notice.
- **Never fails the sync.** `runDeployment` resolves on every path — including the upload,
  which is wrapped so nothing can escape. A failed deploy shows a sticky Notice
  ("see the FIT debug log") while the sync outcome is unaffected.
- **Output is capped** at the most recent 200 lines, in memory and in the FIT debug log. The
  run log file is bounded by rotation instead (see above), so it keeps a full record of the run.
- **Per-command timeout** of 900 seconds; a timed-out build or upload is reported as a failure
  with `timedOut: true` rather than hanging the deploy forever.
- **Desktop only.** On mobile the deployment is skipped and the settings are left untouched, so
  a vault synced from a phone and a laptop keeps the same configuration.
- **The password never reaches the process list.** When set, it is written to a mode-`0600`
  temp file and handed to `sshpass -f`; the file is removed in a `finally`. Without a password
  the SSH calls run with `BatchMode=yes` so a prompt can never hang an unattended run.
- **Prefer key auth.** A password is stored as plain text in this device's `data.json`. FIT
  strips the deployment credentials before `data.json` is synced to the remote, so they never
  leave the machine — see `FIT_OWN_SETTINGS_DENYLIST` in
  [src/util/protectedPaths.ts](../src/util/protectedPaths.ts).

## Content synchronisation

Each vault subfolder maps to one Astro content collection, relative to `astroProjectPath`:

| Vault folder | Collection directory |
| ------------ | -------------------- |
| `project/` | `src/content/projects/` |
| `journal/` | `src/content/journal/` |

Only `.md` and `.mdx` files are copied, recursively, and hidden entries (`.trash`,
`.obsidian`) are ignored. Any `.md`/`.mdx` in the target that the vault no longer has is
removed, so renamed notes do not linger; other files in the target (such as a `.gitkeep`) are
left alone.

Collection directories are created even when they hold no notes: an empty `project/en/` in the
vault produces an empty `src/content/projects/en/`, and a `journal/` folder missing from the
vault still yields `src/content/journal/`. The mirror therefore reflects the vault's *layout*,
not only its populated corners — which is what an empty language branch looks like before the
first note is written.

If the project ships `scripts/sync-content.mjs`, it runs afterwards with
`--vault <vaultContentPath> --quiet`. That script owns frontmatter normalisation, so a
hand-written note missing the `title`/`date`/`lang` fields the content collections require
still builds. Its failure aborts the deploy before the build stage.

## Upload

Published with `rsync -a --human-readable --itemize-changes --delete`, excluding `.DS_Store`,
`*.log`, and `*.map`. The trailing slash on the source publishes the *contents* of `dist/`
into `sftpRemotePath`, and `--delete` removes files there the build no longer produces — point
the remote path at a directory dedicated to this site.

The remote directory is created first with `ssh … mkdir -p <remotePath>`, because `rsync`
creates only the final path component of its destination. SSH runs with `ConnectTimeout=15` and
`StrictHostKeyChecking=accept-new`.

## Relationship to the post-sync hook

Both features run after the same event, so enabling both would build and upload the same site
twice per commit. Use one:

- **This feature** when the pipeline is exactly copy → `npm run build` → `rsync dist/`.
- **The [post-sync hook](post-sync-hook.md)** when you have your own script that should own the
  whole thing (extra steps, a different host, a readiness check).

The settings tab warns when both are on, and the deployment logs a line in that case.

## Related: desktop-only code

`src/deploy.ts` is the plugin's second registered Node.js exception (after the post-sync hook).
The constraints it must satisfy and the enforcement that checks them are documented in
[docs/api-compatibility.md § Desktop-only exceptions](api-compatibility.md#desktop-only-exceptions).
