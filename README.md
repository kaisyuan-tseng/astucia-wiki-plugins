# Astucia Wiki Plugins — one-click install bundle

> 🌐 **中文版**: see [README.zh.md](README.zh.md)

A drop-in set of file-management plugins for [Astucia Wiki](https://github.com/madsrg/astucia-wiki).
**Anyone with a fresh Astucia Wiki checkout can install this in one command.**

```
plugin bundle (this directory)
   │  bash installer/install.sh <wiki-root>
   ▼
your Astucia Wiki project root
```

## What you get (final effect)

| Plugin | Feature |
|---|---|
| **Tabs** | Browser-style file tabs: each tab independently keeps its scroll position, cursor, unsaved edits; single-click opens a replaceable "preview" tab, right-click "open in new tab" makes it permanent; tabs can be drag-reordered, right-click closed; italic name = currently editing |
| **Tree Drag & Move** | File-tree multi-select (Ctrl/Shift) + drag-and-drop (root is a valid drop target) + full right-click menu (open / new tab / duplicate / move / rename / Backlinks / delete / reveal in file manager) |
| **Sidebar Tab Order** | Right-click the sidebar (Pages / Tags / Recent / Saved) to enter edit mode: drag to reorder, hide/show panes, synced across devices |
| **Context Menu** | Shared right-click menu component (used by the above, no UI of its own) |

Bonus fixes: file tree no longer collapses expanded folders on refresh; tab edit state survives switching; admins can delete a Space and reveal a file in the OS file manager (Windows / macOS / Linux).

![Multiple tabs at once — one being edited (italic + dot), others previewed](screenshots/tabs-multi.png)

**Full 8-language localization**: en / zh / hi / da / sv / es / fr / de, **7800+ keys** total
(zh 994 · hi 1001 · de 781 · ...). Every visible UI string — sidebar tabs, search box,
TOC title, edit / history / admin / preferences, modal titles — translates instantly.
Coverage:
- `index.php` is shipped as a whole file (Tier 2 replace) with **309 `data-i18n` sites** —
  sidebar tabs, admin pane groups, every modal title, share / chat / AI-clone dialogs
- 43 modules (admin / chat / list / toc / ...) shipped as whole files with their R10 i18n deltas

![Admin panel — group tabs (Users / AI / Monitoring / Content) translated to the active language](screenshots/i18n-admin.png)

**Operation audit log**: reuses the project's built-in `write_access_log`. Adds calls in
11 critical success branches: FILE_UPDATE / FILE_CREATE / FILE_DELETE / FOLDER_CREATE /
FOLDER_DELETE / FILE_MOVE / FILE_RENAME / FOLDER_MOVE / FOLDER_RENAME / FILESFOLDER_CREATE /
SPACE_CREATE / SPACE_RENAME / SPACE_DELETE / FILE_REVEAL. Format
`timestamp | EVENT | uid | name | IP | detail`, written to `LOG_DIR/yyyy-mm-dd_access.log`.

> **Verified on v2026.7.41** (clean install, PHP built-in server, headless-browser +
> curl): **78 patches / 0 needs-manual**, `php -l` clean for 4 core files, all 11 audit
> events land in the log, language switch en / zh / de translates search box and TOC
> panel correctly, zero page errors. See `screenshots/` for proof.

## Requirements

- Astucia Wiki **v2026.7.40 / v2026.7.41 verified** (the installer uses anchor-based
  positioning, so small upstream changes still install; major mismatches are
  reported explicitly)
- PHP 8.0+ (same as the wiki itself)

## Install (3 steps)

```bash
# 1. Unzip this directory anywhere (does not need to be inside the wiki)
# 2. Run the installer with your wiki root as the argument
bash installer/install.sh /var/www/astucia-wiki
# Windows (Git Bash):  bash installer/install.sh "E:/sites/astucia-wiki"

# 3. Clear your browser cache (Ctrl+Shift+R) and reload
```

What the installer does:
1. Creates `plugins-backup/` in the wiki root and backs up every file it will touch
   (fixed directory name — idempotent re-runs never pollute it, so uninstall
   always restores the pre-install originals)
2. Copies the 4 plugins to `wiki/plugins/`
3. Replaces the 44 files in `core/replace/` (index.php + 43 modules — plugin wiring,
   R10 full localization, bug fixes)
4. Applies 34 anchor-based patches to 6 core files (auto-located, auto-skipped on
   repeat runs)

**Output meaning**: `applied` = patched or copied; `skipped` = already installed
(idempotent); `needs-manual` = anchor not found (upstream version drift) — see
"Manual install" below.

## Uninstall

```bash
bash installer/uninstall.sh /var/www/astucia-wiki
```

Restores every patched / replaced file from `plugins-backup/` and removes the 4
plugin directories.

![Language picker — 8 languages with one click](screenshots/lang-dropdown.png)

## Manual install (when the script reports `needs-manual`)

Every patch block carries an `=== local plugins ===` marker. To install manually,
copy the contents of `core/blocks/<file>.code` to the anchor line in
`core/install.index` (the `anchor` column) of the target file. `core/install.index`
has the full legend.

## Directory layout

```
astucia-wiki-plugins/
├── README.md                ← this file (English, primary)
├── README.zh.md             ← 中文版
├── plugins/                 # 4 plugins (complete, self-contained)
│   ├── context_menu/
│   ├── sidebar_tab_order/
│   ├── tabs/
│   └── tree_drag_move/
├── core/
│   ├── install.index        # patch list (file / anchor / idempotency guard)
│   ├── blocks/              # patch code (each file = one block, with === local plugins === marker)
│   └── replace/             # 44 whole-file replacements (index.php + 43 modules)
├── installer/
│   ├── install.sh           # install (backup + copy + patch, idempotent)
│   └── uninstall.sh         # uninstall (restore from backup)
└── screenshots/             # proof-of-work screenshots (Chinese UI — localization in action)
    ├── tabs-multi.png        # multiple tabs: one being edited (italic + dot), others previewed
    ├── ctx-menu.png          # file right-click context menu
    ├── i18n-zh.png           # full Chinese UI (sidebar tabs / buttons / footer all translated)
    ├── i18n-admin.png        # admin panel: group tabs (Users/AI/Monitoring/Content) in Chinese
    └── lang-dropdown.png     # language picker: 8 languages
```

![Edit mode — active tab name becomes italic, unsaved dot appears](screenshots/tabs-multi.png)

## Compatibility notes

- **Why anchors instead of diff**: anchors are stable original lines in upstream
  source; small upstream changes don't break the install, missing anchors are
  reported explicitly, never silently misplaced.
- **Tier 2 whole-file replacements** (`core/replace/`, 44 files): combine plugin
  wiring, R10 full-i18n module changes (admin/chat/list/toc + 309 `data-i18n` sites
  in `index.php`) and small bug fixes. We verified every one of these files vs
  pristine .41: the only differences are i18n strings (zero non-i18n lines), so
  shipping them whole cannot lose upstream functionality. If you upgrade upstream,
  just re-run `install.sh` (the fixed backup directory will be refreshed).
- **Removing the plugins**: `uninstall.sh` + deleting all `=== local plugins ===`
  marker blocks cleanly undoes everything. See the per-plugin header comments for
  the manual removal recipe.

![File right-click context menu — open in new tab / duplicate / move / rename / Backlinks / delete / reveal](screenshots/ctx-menu.png)

## Verify the install

After install, in the wiki:
1. Click any file in the tree → a tab appears at the top (preview tab, normal name)
2. Click Edit → the active tab name becomes italic; type → a dot appears (unsaved)
3. Switch to another file and switch back → edit content / cursor / scroll kept
4. Right-click a file → menu includes "Open in new tab / Duplicate / Move / Rename / Backlinks / Delete / Reveal in file manager"
5. Right-click the sidebar tab bar → reorder pane tabs
6. Switch the language picker → sidebar tabs (Pages / Search / Recent), search box,
   TOC title, admin pane groups all translate instantly
7. After any write operation → `LOG_DIR/yyyy-mm-dd_access.log` shows the corresponding event line

If step 2–3 misbehave, it's usually browser cache — force-reload and retry.
