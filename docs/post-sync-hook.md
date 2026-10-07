# Post-sync hook

Opt-in desktop feature: run one local shell command after a sync that **pushed a commit** —
typically "rebuild my website from this vault and deploy it".

It exists so a vault sync can drive a downstream build without a separate watcher daemon or
CI round-trip. It is off by default and does nothing on mobile.

## What triggers it

A sync run in which FIT actually wrote local changes to the remote repo — in the sync
engine's terms, a non-empty
[`SyncResult.pushedRemoteChanges`](../src/syncResult.ts) (see the `didCreateCommit` site in
[`FitSync._doSync`](../src/fitSync.ts)).

Deliberately narrow, because a rebuild is expensive and a deploy is user-visible:

| Situation | Hook runs? |
| --------- | ---------- |
| Manual sync that pushed an edit | ✅ |
| Auto sync that pushed an edit | ✅ |
| Sync that only pulled remote changes | ❌ — nothing new to build |
| Sync with no changes at all | ❌ |
| Sync that failed | ❌ |
| Sync whose files were skipped (API size limit, rate limiting) | ❌ — nothing was committed |
| "Run post-sync hook" command / "Run now" in settings | ✅ — bypasses the commit gate on purpose |

## Configuration

FIT settings → **Post-sync hook (desktop only)**:

| Setting | Meaning |
| ------- | ------- |
| Enable post-sync hook | Master switch. Off by default. |
| Hook command | Shell command line, e.g. `bash /home/you/site/scripts/deploy.sh` |
| Working directory | CWD for the command; point it at the website project so relative paths resolve |
| Hook timeout | Seconds before the process is killed (default 900) |

The command is spawned through a shell (`shell: true`), so pipes, `&&`, and shell built-ins
work. **The value comes from your own settings file — treat it as trusted input.** Nothing
escapes to a remote source; only the device owner can set it.

## Behaviour notes

- **Not awaited by the sync.** The sync completes and its notice is dismissed first, so a
  multi-minute build never holds the sync UI open. Progress is logged to
  `.obsidian/plugins/fit/debug.log` with a `[PostSyncHook]` prefix.
- **Re-entrancy guarded.** A second sync while a deploy is running does not start a second
  build against the same working tree; the run is skipped with a Notice.
- **Never fails the sync.** `runPostSyncHook` resolves on every path. A failed deploy shows a
  sticky Notice ("see the FIT debug log") but the sync outcome is unaffected.
- **Output is capped** at the most recent `POST_SYNC_HOOK_MAX_OUTPUT_LINES` (200) lines.
- **Timeout kills the shell**, not necessarily further descendants it started. Keep commands
  to a single process tree where practical.
- **Desktop only.** On mobile the hook is skipped and the settings are left untouched, so a
  vault synced from a phone and a laptop keeps the same configuration.

## Related: built-in deployment

If your "deploy" step is exactly *copy the notes into a website project → `npm run build` →
`rsync dist/` to a server*, FIT has a configuration-only version of it that skips the shell
script entirely: [docs/deployment.md](deployment.md). Use this hook instead when your own
script should own the whole pipeline.

The two run on the same commit gate, so enabling both would build and upload the site twice.
That is warned about in the settings tab.

## Related: desktop-only code

This is one of the plugin's two registered Node.js exceptions (the other is
[src/deploy.ts](../src/deploy.ts)). The constraints they must satisfy, the enforcement that
checks them, and the gate each uses are documented in
[docs/api-compatibility.md § Desktop-only exceptions](api-compatibility.md#desktop-only-exceptions).
