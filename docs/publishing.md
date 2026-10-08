# Publishing to the website

Replaces the old desktop-only "auto-deploy" (copy → local build → rsync over SSH). Publishing is now
plain HTTPS to the site's admin service, so it works on **desktop and mobile**, needs **no SSH
password and no local Node/Astro toolchain**.

```
Obsidian ──(FIT sync)──► GitHub            (history / backup, unchanged)
Obsidian ──(FIT publish)► POST /api/ingest ─► validate every note ─► write ─► build ─► atomic release
```

## What gets published

Under the configured **vault folder** (default `arman-hosseini`):

```
project/<en|fa>/**/*.md|mdx   →  projects/<lang>/…
journal/<en|fa>/**/*.md|mdx   →  journal/<lang>/…
```

* `publish: false` in a note's frontmatter keeps it private.
* Obsidian syntax is converted before upload: `[[wikilinks]]` (to published notes) → real links,
  `![[image.png]]` → uploaded image, `==highlight==` → `<mark>`, `> [!callout]`, `%%comments%%` and
  `^block-ids` are cleaned. Code blocks are never touched.
* The `slug`, `lang`, `date`, `title`, `tags` frontmatter keys are filled in when missing.

## Safety

* The server **compiles every `.mdx` file** (the same `@mdx-js/mdx` the site build uses) before it
  writes anything. One broken note ⇒ HTTP 422 with file and line, **nothing is changed**.
* Only changed notes are sent (SHA-256 diff against the server manifest).
* Only files that earlier came from the vault are ever deleted by a publish; pages created in the
  dashboard are never touched. A slug that collides with a dashboard page is rejected.
* SEO settings, status (published / draft / disabled) and translation links edited in the dashboard
  live in a separate overrides file, so a re-publish never overwrites them.
* The token is stored in `data.json` on that device only and is on the settings denylist
  (`protectedPaths.ts`), so it is never synced to GitHub.

## Setup

1. Dashboard ▸ Settings ▸ **FIT tokens** ▸ create a token.
2. FIT settings ▸ **Publishing (website)**: site URL, token, vault folder.
3. Commands: **Validate notes for the website (dry run)** and **Publish notes to the website**.
   Optionally enable *Publish automatically after sync*.
