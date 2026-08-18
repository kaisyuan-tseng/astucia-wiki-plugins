// === local plugin: tree_drag_move ===
// Obsidian-like file-tree interactions: multi-select (Ctrl/Shift), drag-to-move
// (files AND folders), and click-blank-to-deselect. Layered on top of
// modules/file_tree without modifying its click handler.
//
// Selection model (Windows-Explorer-like):
//  - The currently-open page is ALWAYS the first member of the selection
//    context: opening a file makes it the only selected item (it carries both
//    file_tree's `.active` and this plugin's `.tree-selected`), and Shift-range
//    starts from it when no manual anchor exists.
//  - plain click  → single-select + open in the preview slot (file_tree opens it)
//  - Ctrl/Meta+click → PURE multi-select for EVERY item kind (files, folders,
//    files-folders, diagrams, …) — it NEVER opens tabs. "Open in new tab" is
//    reached via the right-click menu (R8; Ctrl+new-tab was removed because it
//    collided with multi-select).
//  - Shift+click  → range select from the current selection start, does NOT open
//  - right-click  → context menu. On a FILE: Open in New Tab / Copy / Move /
//    Rename / Backlinks / Delete (+ Reveal for admins) — "Open" was removed
//    (left-click opens) and Backlinks is the header "…" menu feature reused.
//    On a FOLDER: New … (the full toolbar creator set) + Copy/Move/Rename/
//    Delete (+ Reveal). A files-folder (File Library) is a collection/upload
//    container, so it shows NO "New …" actions (R9) — just Copy/Move/Rename/
//    Delete (+ Reveal).
//    Multi-select: Copy (N) / Delete (N). Blank area: New items.
//  - click blank  → clear the multi-selection AND reset the folder operation
//    context to the space ROOT; the current page's `.active` browse highlight
//    is intentionally left intact (the page stays open).
//  - Escape       → same as blank click
//
// Three states are deliberately kept separate (see file_tree's folder context):
//  - browse state     = state.currentPagePath + `.active` highlight
//  - multi-selection  = `.tree-selected` set (drag/delete target)
//  - operation target = file_tree's folder context ('' = root); it drives
//    where new items are created and where drops land
//
// Drag: ANY tree row (file or folder) is draggable. Dropping on a folder row
// moves the whole selection into it; dropping on blank tree space moves it to
// the space ROOT. Moving a folder into itself or its own descendant is
// prevented client-side (and the server `move` action validates paths).
// Cross-space drag is intentionally NOT supported — use the Move lightbox.
//
// Removability: delete this directory, the script.js import/init line, the
// i18n keys (tree.*), and the CSS block. file_tree reverts to single-select.

import { api } from '../../modules/core/api.js';
import { state } from '../../modules/core/state.js';
import { showToast, promptModal, confirmModal } from '../../modules/core/utils.js';
import { icons } from '../../modules/core/icons.js';
import { t } from '../../modules/i18n/index.js';
import { refreshFileTree, revealAndSelectFile, setFolderContext, getFolderContext } from '../../modules/file_tree/index.js';
import { showContextMenu } from '../context_menu/index.js';
import { getNewItemCreators } from '../../modules/new_items/index.js';

const SEL_CLASS = 'tree-selected';
const DROP_CLASS = 'tree-drop-target';
const ROOT_CLASS = 'tree-drop-root';

// Set of currently selected paths (does NOT include the current page unless it
// was clicked / ctrl-clicked as part of the selection).
const _selected = new Set();
// Last plain-click anchor (shift-range base when present).
let _anchor = null;
// Path under the cursor when a drag starts (fallback when nothing selected).
let _dragSourcePath = null;

// --- role gate ---------------------------------------------------------------
// Readers are view-only: the context menu hides create/copy/move/rename/delete
// and drag-to-move is disabled. This is UI honesty only — the server-side
// $edit_actions whitelist rejects the API calls regardless. (index.php always
// injects WIKI_ROLE; when absent, fall back to "can edit" so no-auth installs
// behave exactly as before.)
const canEdit = () => (window.WIKI_ROLE || 'admin') !== 'reader';
// "Reveal in file manager" is admin-only (the backend 'reveal' action is in
// $admin_actions — this UI gate is only honesty, the API rejects non-admins).
const canAdmin = () => (window.WIKI_ROLE || 'admin') === 'admin';

// Admin: locate the wiki item in the operating system's file manager. Acts on
// the SERVER's filesystem (see the 'reveal' action in api.php) — with a local
// install that is the user's own machine.
const revealPath = async (path) => {
    const res = await api.call('reveal', { path }, 'POST');
    if (res.success) showToast(t('reveal.success'), 'success');
    else showToast(res.message || t('reveal.fail'), 'error');
};

// --- containers ---------------------------------------------------------------
const containers = () => [
    document.getElementById('file-navigator'),
    document.getElementById('file-browser'),
    document.getElementById('pages-pane'),
].filter(Boolean);

const allItemContents = () => document.querySelectorAll(
    '#file-navigator .file-item-content, #file-browser .browse-item-content'
);

const rowOf = (el) => el?.closest('.file-item-content, .browse-item-content');

// Visible items in DOM order (collapsed subtrees have display:none → no offsetParent).
const visiblePathsInOrder = () => {
    const out = [];
    allItemContents().forEach(el => {
        if (el.offsetParent === null) return;
        const p = el.dataset.path;
        if (p !== undefined) out.push({ path: p, el });
    });
    return out;
};

// --- selection ----------------------------------------------------------------
// Three DISTINCT concepts (kept separate on purpose):
//   - browse state: state.currentPagePath + the tree `.active` highlight —
//     what the viewer shows. NOT cleared on blank click (the page stays open).
//   - multi-selection: `.tree-selected` + _selected — what a drag/delete
//     targets. Cleared on blank click / Esc.
//   - operation context: file_tree's folder context ('' = root) — where new
//     items are created. Set to root by blank click / Esc.
const clearSelection = () => {
    allItemContents().forEach(el => el.classList.remove(SEL_CLASS));
    _selected.clear();
    _anchor = null;
    // Operation context returns to the space ROOT; the browse highlight
    // (.active) is intentionally left intact.
    setFolderContext('');
};

const setItemSelected = (el, on) => {
    if (!el) return;
    el.classList.toggle(SEL_CLASS, on);
    const p = el.dataset.path;
    if (p === undefined) return;
    if (on) _selected.add(p); else _selected.delete(p);
};

const selectOnly = (el) => {
    clearSelection();
    setItemSelected(el, true);
};

const selectRange = (basePath, targetEl) => {
    const items = visiblePathsInOrder();
    const bi = items.findIndex(it => it.path === basePath);
    const ti = items.findIndex(it => it.el === targetEl);
    if (bi === -1 || ti === -1) { selectOnly(targetEl); return; }
    const [from, to] = bi < ti ? [bi, ti] : [ti, bi];
    clearSelection();
    for (let i = from; i <= to; i++) setItemSelected(items[i].el, true);
};

const toggleSelect = (el) => {
    const p = el.dataset.path;
    setItemSelected(el, !_selected.has(p));
};

// Selection start for shift-range: last manual anchor, else the currently-open
// page, else nothing (fall back to single-select).
const selectionBase = () => _anchor ?? state.currentPagePath ?? null;

// --- move via existing API ----------------------------------------------------
const moveItemsTo = async (paths, destFolder) => {
    let ok = 0, skipped = 0, failed = 0;
    for (const src of paths) {
        const fileName = src.split('/').pop();
        const newPath = (destFolder ? destFolder + '/' : '') + fileName;
        if (newPath === src) { skipped++; continue; }
        // Never move a folder into itself or its own descendant.
        if (destFolder && (destFolder === src || destFolder.startsWith(src + '/'))) { skipped++; continue; }
        const res = await api.call('move', { old_path: src, new_path: newPath }, 'POST');
        if (res.success) {
            ok++;
            // Keep any open tab for this file pointing at the new path
            // (R4 pattern — same as the rename path below).
            if (typeof window.__tabsRemapTab === 'function') window.__tabsRemapTab(src, newPath);
        } else if (res.message && res.message.includes('exists')) skipped++;
        else failed++;
    }
    await refreshFileTree();
    // Keep the current page highlighted if it still exists.
    if (state.currentPagePath) revealAndSelectFile(state.currentPagePath);
    if (ok)      showToast(t('tree.move-success', { count: ok }), 'success');
    if (skipped) showToast(t('tree.move-skipped', { count: skipped }), 'info');
    if (failed)  showToast(t('tree.move-failed-count', { count: failed }), 'error');
    clearSelection();
};

// --- context menu (right-click) ----------------------------------------------
// The menu is only another entry point: copy/move reuse the existing
// copy/move lightboxes (modules/file_ops), create/rename/delete reuse the same
// API actions the toolbar already drives. Nothing is re-implemented here.

const openPath = async (row) => {
    // A programmatic click runs file_tree's open logic (and this plugin's
    // select-on-open) exactly as a user's left-click would.
    row.click();
};

// R8: right-click "Open in New Tab" — a PERMANENT tab via the tab manager
// (never the replaceable preview slot; an active EMPTY tab is reused). Falls
// back to a plain open when the tabs plugin is absent. Readers may use it —
// same read access as "Open".
const openNewTab = (path, row) => {
    const id = row?.dataset.id || null;
    let tags = [];
    try { tags = JSON.parse(row.dataset.tags || '[]'); } catch {}
    if (typeof window.__openInTab === 'function') {
        window.__openInTab(path, id, tags, { newTab: true });
    } else {
        openPath(row);
    }
};

// Copy: single item → existing copy lightbox; multi-select → one destination
// folder (prompted) for the whole set, mirroring copy_page's parameters.
const copyPaths = async (paths) => {
    if (paths.length === 1) {
        state.sourcePathToCopy = paths[0];
        const { openCopyLightbox } = await import('../../modules/file_ops/copy.js');
        openCopyLightbox();
        return;
    }
    const dest = await promptModal(t('tree.copy-dest'), getFolderContext() || '', '', icons.folder);
    if (dest === null) return;
    const target = dest.trim().replace(/\/+$/, '');
    let ok = 0, failed = 0;
    for (const src of paths) {
        const fileName = src.split('/').pop();
        const newPath = (target ? target + '/' : '') + fileName;
        if (newPath === src) continue;
        const res = await api.call('copy_page', { source_path: src, new_path: newPath }, 'POST');
        if (res.success) ok++; else failed++;
    }
    await refreshFileTree();
    clearSelection();
    if (ok)      showToast(t('fileops.copied'), 'success');
    if (failed)  showToast(t('tree.move-failed-count', { count: failed }), 'error');
};

const movePath = async (path) => {
    state.sourcePathToMove = path;
    const { openMoveLightbox } = await import('../../modules/file_ops/move.js');
    openMoveLightbox();
};

const renamePath = async (path) => {
    const oldName = path.split('/').pop();
    // Extension-agnostic: works for wiki types and generic files (Manual.pdf
    // keeps its .pdf when only the base name is edited).
    const lastDot = oldName.lastIndexOf('.');
    const base = lastDot > 0 ? oldName.slice(0, lastDot) : oldName;
    const ext  = lastDot > 0 ? oldName.slice(lastDot) : '';
    const newName = await promptModal(t('fileops.rename-title', { name: base }), base, '', icons.file);
    if (!newName || newName === base) return;
    const dir = path.split('/').slice(0, -1).join('/');
    const newPath = (dir ? dir + '/' : '') + newName + ext;
    const res = await api.call('move', { old_path: path, new_path: newPath }, 'POST');
    if (res.success) {
        showToast(t('fileops.renamed'), 'success');
        await refreshFileTree();
        if (state.currentPagePath === path) {
            // Keep the open tab's identity across renames (mirrors
            // file_ops handleRename): remap the tab, never open a duplicate.
            if (typeof window.__tabsRemapTab === 'function') {
                window.__tabsRemapTab(path, newPath);
            } else {
                revealAndSelectFile(newPath);
            }
        } else {
            revealAndSelectFile(newPath);
        }
        clearSelection();
    }
};

// Delete: whole set, one confirmation. If the currently-open page is included,
// fall back to the space start page exactly like the toolbar's delete.
const deletePaths = async (paths) => {
    if (!paths.length) return;
    const label = paths.length > 1
        ? paths.map(p => p.split('/').pop()).join(', ')
        : paths[0].split('/').pop();
    if (!await confirmModal(t('fileops.delete-confirm', { name: label }), {
        confirmLabel: t('btn.delete'), dangerous: true, icon: icons.trash,
    })) return;
    let ok = 0, failed = 0;
    for (const p of paths) {
        const res = await api.call('delete', { path: p }, 'POST');
        if (res.success) ok++; else failed++;
    }
    await refreshFileTree();
    if (paths.includes(state.currentPagePath)) {
        const deletedPath = state.currentPagePath;
        const startResult = await api.call('get_start_page');
        const fallbackPath = startResult.success && startResult.path ? startResult.path : null;
        // Close the deleted file's tab and fall back to the space start page /
        // blank state (mirrors file_ops handleDelete) — never leave a stale tab.
        if (typeof window.__tabsOpenAfterDelete === 'function') {
            await window.__tabsOpenAfterDelete(deletedPath, fallbackPath, startResult.id);
        } else if (fallbackPath) {
            const { loadPage } = await import('../../modules/page_view/index.js');
            await loadPage(fallbackPath, startResult.id, []);
        } else {
            const { showBlankPage } = await import('../../modules/page_view/index.js');
            await showBlankPage();
        }
    } else if (state.currentPagePath) {
        revealAndSelectFile(state.currentPagePath);
    }
    if (ok)      showToast(t('fileops.deleted'), 'success');
    if (failed)  showToast(t('tree.move-failed-count', { count: failed }), 'error');
    clearSelection();
};

// "New" menu entries reuse the toolbar's creation flows (modules/new_items),
// so the context menu and the new-item-dropdown share the same implementations
// — only the entry point differs. Each entry creates in `folder` by pointing
// the folder context there before running the shared flow.
// R9: the list is DERIVED from the creator set that the toolbar "New …"
// dropdown registers (getNewItemCreators) — order mirrors the dropdown, so
// the two stay in sync with whatever file/content types the project supports
// (pages, diagrams, lists, chats, searches, folders, files-libraries). It is
// NOT hardcoded to a fixed subset; unregistered creators are skipped.
const newItemMenuItems = (folder) => {
    const c = getNewItemCreators();
    const defs = [
        { key: 'createPage',          label: t('nav.new-page'),      icon: icons.file },
        { key: 'createFolder',        label: t('nav.new-folder'),    icon: icons.folder },
        { key: 'createFilesLibrary',  label: t('nav.new-files-lib'), icon: icons.filesFolder },
        { key: 'createDiagram',       label: t('nav.new-diagram'),   icon: icons.diagram },
        { key: 'createList',          label: t('nav.new-list'),      icon: icons.list },
        { key: 'openNewChatLightbox', label: t('nav.new-chat'),      icon: icons.chat },
        { key: 'createNewSearch',     label: t('nav.new-search'),    icon: icons.search },
    ];
    return defs
        .filter(d => typeof c[d.key] === 'function')
        .map(d => ({ label: d.label, icon: d.icon, onClick: () => { setFolderContext(folder || ''); c[d.key](); } }));
};

// Right-click on blank tree space → create items in the current folder context.
// Readers get no items (server rejects creation anyway). `ctx` overrides the
// operation context (used by the directory view, where blank = the shown folder).
const blankAreaMenu = (ctx) => {
    if (!canEdit()) return [];
    const folder = (ctx !== undefined && ctx !== null) ? ctx : (getFolderContext() || '');
    return newItemMenuItems(folder);
};

// R9: Backlinks for the right-clicked item — shares ONE implementation with
// the header "…" menu (openBacklinks in modules/file_ops). The right-clicked
// file may not be the currently-open page, so its own id/path is passed.
const backlinksPath = async (path, row) => {
    const id = row?.dataset?.id;
    if (!id) return;
    const { openBacklinks } = await import('../../modules/file_ops/index.js');
    await openBacklinks(id, path);
};

// Right-click on a tree row. Single selection → per-type actions; multi
// selection → actions that operate on the whole set.
const itemMenu = (targets, type, row) => {
    if (targets.length === 1) {
        const p = targets[0];
        const isContainer = type === 'folder' || type === 'filesfolder';
        const items = [];
        if (isContainer) {
            // R9: ONLY plain folders get the "New …" menu. A files-folder
            // (File Library) is a collection/upload container, not a working
            // directory — "New page/folder/…" actions never appear for it.
            if (type === 'folder' && canEdit()) {
                items.push(...newItemMenuItems(p));
                items.push({ separator: true });
            }
        } else {
            // R9: no plain "Open" item — a left-click already opens. Right-click
            // opens a PERMANENT tab (readers included); the icon is removed.
            items.push({ label: t('tree.open-new-tab'), onClick: () => openNewTab(p, row) });
            items.push({ separator: true });
        }
        if (canEdit()) {
            // R9: Copy / Move / Rename reuse the header "…" menu icons
            // (icons.copy/move/rename) and the SAME handlers/lightboxes
            // (copy.js / move.js) — nothing is re-implemented here.
            items.push(
                { label: t('tree.copy'),   icon: icons.copy,   onClick: () => copyPaths([p]) },
                { label: t('tree.move'),   icon: icons.move,   onClick: () => movePath(p) },
                { label: t('tree.rename'), icon: icons.rename, onClick: () => renamePath(p) },
            );
            // R9: Backlinks is a CONTENT action — same feature as the header
            // "…" menu; containers (folder / files-folder) never get it.
            if (type !== 'folder' && type !== 'filesfolder') {
                items.push({ label: t('header.backlinks'), icon: icons.backlinks, onClick: () => backlinksPath(p, row) });
            }
            items.push(
                { separator: true },
                { label: t('tree.delete'), icon: icons.trash, danger: true, onClick: () => deletePaths([p]) },
            );
        }
        // Admin-only: reveal the real filesystem position of this wiki item.
        if (canAdmin()) {
            items.push(
                { separator: true },
                { label: t('reveal.title'), icon: icons.folderOpen, onClick: () => revealPath(p) },
            );
        }
        return items;
    }
    // Multi-select: act on the whole selection set (readers can only view).
    if (!canEdit()) return [];
    return [
        { label: t('tree.copy-count', { count: targets.length }),   onClick: () => copyPaths(targets) },
        { label: t('tree.delete-count', { count: targets.length }), icon: icons.trash, danger: true, onClick: () => deletePaths(targets) },
    ];
};

const wireContextMenu = (container) => {
    container.addEventListener('contextmenu', (e) => {
        const row = rowOf(e.target);
        e.preventDefault();
        e.stopPropagation();
        if (!row) {
            // Blank area → new-item actions. The target is the current folder
            // operation context ('' = root), set by clicking a folder / a
            // file's parent / blank space (see modules/file_tree).
            const blankCtx = getFolderContext() || '';
            setFolderContext(blankCtx);
            showContextMenu(blankAreaMenu(blankCtx), e.clientX, e.clientY);
            return;
        }
        // Right-clicking an item that is NOT part of the current selection
        // selects just that item first (Explorer behaviour); right-clicking a
        // member keeps the whole selection set.
        if (!_selected.has(row.dataset.path)) selectOnly(row);
        const targets = Array.from(_selected);
        showContextMenu(itemMenu(targets, row.dataset.type, row), e.clientX, e.clientY);
    });
};

// --- drag ---------------------------------------------------------------------
// Files AND folders are draggable (folders can be dragged back to the root).
const isDraggableItem = (el) => {
    const type = el?.dataset.type;
    return type === 'file' || type === 'folder' || type === 'filesfolder'
        || ['diagram', 'list', 'chat', 'search', 'json'].includes(type);
};

// Drop target resolution:
//  - blank area         → { folder: '', el: null }  (space root — valid target)
//  - folder row         → { folder: path, el: row }
//  - file row           → null (invalid target)
const findFolderTarget = (el) => {
    const row = rowOf(el);
    if (!row) return { folder: '', el: null };
    const type = row.dataset.type;
    if (type === 'folder' || type === 'filesfolder') return { folder: row.dataset.path || '', el: row };
    return null;
};

const clearDropHighlights = () => {
    document.querySelectorAll('.' + DROP_CLASS).forEach(el => el.classList.remove(DROP_CLASS));
    containers().forEach(c => c.classList.remove(ROOT_CLASS));
};

// The drop source set: the current multi-selection when the dragged item is
// part of it, else the dragged item alone (or the current page as fallback).
const dragSources = (row) => {
    const p = row?.dataset.path;
    if (_selected.has(p)) return Array.from(_selected);
    if (_selected.size) return Array.from(_selected);
    if (p) return [p];
    if (state.currentPagePath) return [state.currentPagePath];
    return [];
};

// --- event wiring -------------------------------------------------------------
export const init = () => {
    // Full handler containers: the tree and the folder-browse pane. Row clicks
    // and drags are handled here; blank clicks clear the selection.
    const mainContainers = ['file-navigator', 'file-browser']
        .map(id => document.getElementById(id)).filter(Boolean);

    // Root-drop fallback container: #pages-pane is the parent of the above, so
    // it only handles BLANK-area clicks/drops (space root target). It must
    // never intercept row events (would shadow the main containers) and must
    // stop propagation when it handles a drop (otherwise the same drop would
    // fire twice through bubbling).
    const rootContainer = document.getElementById('pages-pane');

    mainContainers.forEach(container => {
        wireContextMenu(container);

        // Capture phase: intercept Ctrl/Shift BEFORE file_tree's bubble-phase
        // click handler would open the file.
        container.addEventListener('click', (e) => {
            const row = rowOf(e.target);
            if (!row) {
                // Blank area of the pane → clear every highlight, open nothing.
                clearSelection();
                return;
            }
            const path = row.dataset.path;
            const type = row.dataset.type;
            if (e.ctrlKey || e.metaKey) {
                // R8: Ctrl+click is PURE multi-select for EVERY item kind
                // (file, folder, files-folder, diagram, list, …). It never
                // opens tabs — "open in new tab" lives in the right-click
                // menu. Intercepting here stops file_tree's bubble-phase
                // click handler from opening the file.
                e.preventDefault();
                e.stopPropagation();
                toggleSelect(row);
                return; // keep anchor unchanged: ctrl toggles don't reset the range base
            }
            if (e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                const base = selectionBase();
                if (base) selectRange(base, row);
                else selectOnly(row);
                return;
            }
            // Plain click: single-select + let file_tree open it. Also set the
            // folder operation context (folder → itself, file → its directory).
            selectOnly(row);
            _anchor = path;
            if (type === 'folder' || type === 'filesfolder') {
                setFolderContext(path);
            } else {
                const dir = path.split('/').filter(Boolean).slice(0, -1).join('/');
                setFolderContext(dir);
            }
        }, true);

        // Make rows draggable on demand (mousedown sets draggable=true so plain
        // clicks still work; dragend clears it). Readers never enter drag mode.
        container.addEventListener('mousedown', (e) => {
            if (!canEdit()) return;
            const row = rowOf(e.target);
            if (!row || !isDraggableItem(row)) return;
            row.draggable = true;
            _dragSourcePath = row.dataset.path;
        });

        container.addEventListener('dragstart', (e) => {
            const row = rowOf(e.target);
            if (!row || !isDraggableItem(row)) { e.preventDefault(); return; }
            // If the dragged item isn't part of the current selection, the drag
            // carries just that item (Explorer behaviour).
            if (!_selected.has(row.dataset.path)) {
                selectOnly(row);
            }
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', row.dataset.path || ''); } catch {}
        });

        container.addEventListener('dragend', () => {
            allItemContents().forEach(el => { el.draggable = false; });
            _dragSourcePath = null;
            clearDropHighlights();
        });

        container.addEventListener('dragover', (e) => {
            const target = findFolderTarget(e.target);
            if (target === null) return;               // over a file row — no drop
            e.preventDefault();
            e.stopPropagation();                       // root fallback must not double-handle
            e.dataTransfer.dropEffect = 'move';
            clearDropHighlights();
            if (target.el) target.el.classList.add(DROP_CLASS);
            else container.classList.add(ROOT_CLASS);  // blank space = root target
        });

        container.addEventListener('dragleave', (e) => {
            if (!container.contains(e.relatedTarget)) clearDropHighlights();
        });

        container.addEventListener('drop', async (e) => {
            const target = findFolderTarget(e.target);
            // File row → ignore. Blank or folder row → proceed.
            if (target === null && rowOf(e.target)) return;
            e.preventDefault();
            e.stopPropagation();                       // root fallback must not double-handle
            clearDropHighlights();
            // Blank drop lands in the current folder operation context ('' = root).
            const destFolder = target
                ? target.folder
                : (getFolderContext() || '');
            const sources = dragSources(rowOf(e.target));
            if (!sources.length) return;
            await moveItemsTo(sources, destFolder);
        });
    });

    // #pages-pane: blank clicks clear the selection; blank drags drop to root.
    // Row events are left entirely to the main containers above.
    if (rootContainer) {
        rootContainer.addEventListener('click', (e) => {
            if (!rowOf(e.target)) clearSelection();
            // Do NOT stopPropagation: row clicks must continue to the containers.
        }, true);

        rootContainer.addEventListener('dragover', (e) => {
            if (rowOf(e.target)) return;               // rows are handled upstream
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            clearDropHighlights();
            rootContainer.classList.add(ROOT_CLASS);
        });

        rootContainer.addEventListener('dragleave', (e) => {
            if (!rootContainer.contains(e.relatedTarget)) clearDropHighlights();
        });

        rootContainer.addEventListener('drop', async (e) => {
            if (rowOf(e.target)) return;               // rows are handled upstream
            e.preventDefault();
            e.stopPropagation();
            clearDropHighlights();
            const sources = dragSources(null);
            if (!sources.length) return;
            await moveItemsTo(sources, '');            // space root
        });
    }

    // Escape clears selection (common desktop convention).
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') clearSelection();
    });

    // Note: file_tree's background polling calls refreshFileTree, which rebuilds
    // the DOM and drops .tree-selected/.active classes. The in-memory _selected
    // set may then hold stale paths; the next blank-click / Esc / new selection
    // clears it. Stale entries are harmless because moveItemsTo validates via API.
};
// === end local plugin ===
