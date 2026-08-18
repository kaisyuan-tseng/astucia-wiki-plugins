// === local plugin: tabs ===
// VS Code-like file tabs with full state caching.
//
// R8 unified open model — one entry point, three open intents:
//   openInTab(path, id, tags, { preview: true })   plain click → REPLACEABLE
//       preview slot (clicking A, B, C keeps ONE tab)
//   openInTab(path, id, tags, { newTab: true })    right-click "Open in New
//       Tab" → a PERMANENT tab (reuses an EMPTY workspace tab if one is
//       active, otherwise opens fresh; never steals the preview slot)
//   openInTab(path, id, tags, { preview: false })  programmatic permanent open
//       (e.g. a freshly created file auto-opens as a permanent tab)
// Ctrl+click is NOT routed here — it is pure multi-select in the file tree
// (see plugins/tree_drag_move). The "+" button creates EMPTY permanent
// workspace tabs (multiple allowed, each with a unique key); a plain click
// then opens into the active empty tab.
//
// Replaceability rules: a clean preview OR an empty tab is a replaceable
// slot. A dirty/edited preview is promoted to permanent before anything else
// opens, so in-progress work is never silently dropped. Starting to type in
// the editor also promotes the active preview.
//
// Caching strategy: when switching away from a tab, snapshot its rendered DOM
// (content containers + header button visibility), key state fields, scroll
// position, and editor content. Switching back restores the snapshot without
// re-fetching, so scroll position and in-progress edits survive.
//
// Unsaved edits: switching tabs NEVER prompts — the outgoing tab's full state
// (editor value, cursor, dirty flag) is snapshotted, so nothing is lost
// (VS Code behaviour). Only closing a tab prompts, and switching space warns
// (space switch clears all tab snapshots — see script.js hasUnsavedTabs).
//
// Exception: .chat pages re-load on switch (chat polling holds internal module
// state that can't be snapshotted from outside; re-loading keeps it correct).
//
// Tab identity = space + path. Switching space clears all tabs (spaces are
// isolated workspaces, like Obsidian vaults). Folders are NOT tabs — they are
// navigation objects in the tree. A files-folder (File Library) IS an openable
// content object and opens as its own tab (R9) — it is a collection/upload
// container, not a plain directory; "File Library in a tab" is distinct from
// "files uploaded into the File Library". All wiki content types
// (md/drawio/list/chat/search/json) open as tabs.
//
// This plugin wraps loadPage: script.js routes page opens through openInTab()
// instead of calling loadPage directly. The original loadPage is still used for
// first-open (fetch + render) and chat re-loads.
//
// Removability: delete this directory, the script.js import + the openInTab
// routing (restore direct loadPage calls), the #wiki-tabs CSS, and the i18n
// keys (tabs.*). loadPage and state.js are untouched.

import { loadPage, showBlankPage } from '../../modules/page_view/index.js';
import { loadFilesFolder } from '../../modules/files_folder/index.js';
import { state } from '../../modules/core/state.js';
import { confirmModal } from '../../modules/core/utils.js';
import { showContextMenu } from '../context_menu/index.js';
import { icons } from '../../modules/core/icons.js';
import { t } from '../../modules/i18n/index.js';
import { revealAndSelectFile } from '../../modules/file_tree/index.js';
import { updateBreadcrumb, updateFavoriteBtn } from '../../modules/nav/index.js';

const TAB_KEY_SEP = '\u0000';
const tabKey = (space, path) => (space || '') + TAB_KEY_SEP + (path || '');

// Content containers whose innerHTML is cached. Note: `viewer-container` is
// deliberately NOT in this list (it would double-cache viewer-content and the
// editor wrapper) — its hidden/visible state is snapshotted separately via
// `viewerHidden` in snapshotDom/restoreDom, because edit mode hides it while
// the classic editor is shown.
const CONTENT_IDS = [
    'viewer-content', 'diagram-viewer', 'list-view-container', 'chat-view-container',
    'search-view-container', 'json-view-container', 'files-folder-container',
];
// Elements whose visibility/enabled state is cached (not innerHTML, except title).
const STATE_IDS = [
    'page-meta-row', 'tags-container', 'attachments-section', 'editor-mode-group',
    'edit-btn', 'save-btn', 'cancel-btn', 'search-btn', 'diagram-edit-btn',
    'chat-topic-btn', 'page-chat-btn', 'toc-btn', 'graph-focus-btn', 'share-btn',
    'copy-btn', 'move-btn', 'backlinks-btn', 'print-btn',
    'git-history-btn', 'git-commit-toggle-btn', 'git-snapshot-btn', 'page-actions-group',
];
// state.js fields cached per tab.
const STATE_FIELDS = [
    'currentPagePath', 'currentPageId', 'currentPageTags', 'currentPageType',
    'currentPageLastUpdated', 'initialContent', 'isEditing', 'hasUnsavedChanges',
    'currentListData', 'currentChatData', 'sortState', 'pageChatPath',
    'editMode', 'activeListView', 'editingItemId', 'inlineBlocks',
];

const _tabs = new Map();    // key -> tab object
const _order = [];          // tab keys in display order (drag-reorderable)
let _activeKey = null;
let _previewKey = null;     // R7: key of the active preview tab (replaceable by plain click)

const makeTab = (path, id, tags) => {
    const base = path ? path.split('/').filter(Boolean).pop() : '';
    return {
        path, id, tags: tags || [], type: null, space: state.currentSpace || '',
        title: base ? base.replace(/\.(md|drawio|list|chat|search|json)$/, '') : '',
        snap: null, stateSnap: null, scrollTop: 0, editorValue: '',
        selStart: 0, selEnd: 0, isEditing: false, hasUnsavedChanges: false,
        isPreview: false,       // R7: plain-click preview slot (replaceable)
        jsonText: null,         // R11: live .json editor text (rebuild on restore)
    };
};

// --- snapshot / restore -------------------------------------------------------
const snapshotDom = () => {
    const snap = { content: {}, states: {}, titleHtml: '', pageIdText: '', pageIdHidden: true, editorHidden: true, viewerHidden: false };
    CONTENT_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) snap.content[id] = { html: el.innerHTML, hidden: el.classList.contains('hidden') };
    });
    STATE_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) snap.states[id] = { hidden: el.classList.contains('hidden'), disabled: el.disabled };
    });
    const editorWrap = document.querySelector('.editor-container-wrapper');
    if (editorWrap) snap.editorHidden = editorWrap.classList.contains('hidden');
    // R11: edit mode hides the whole viewer-wrapper while the classic editor is
    // shown — without this flag a restore could leave the viewer and the editor
    // visible at once (or both hidden), i.e. the edit state never coming back.
    const viewerEl = document.getElementById('viewer-container');
    if (viewerEl) snap.viewerHidden = viewerEl.classList.contains('hidden');
    const titleEl = document.getElementById('current-page-title');
    if (titleEl) snap.titleHtml = titleEl.innerHTML;
    const pidEl = document.getElementById('page-id-display');
    if (pidEl) { snap.pageIdText = pidEl.textContent; snap.pageIdHidden = pidEl.classList.contains('hidden'); }
    return snap;
};

const restoreDom = (snap) => {
    if (!snap) return;
    CONTENT_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el || !snap.content[id]) return;
        el.innerHTML = snap.content[id].html;
        el.classList.toggle('hidden', snap.content[id].hidden);
    });
    STATE_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el || !snap.states[id]) return;
        el.classList.toggle('hidden', snap.states[id].hidden);
        el.disabled = !!snap.states[id].disabled;
    });
    const editorWrap = document.querySelector('.editor-container-wrapper');
    if (editorWrap) editorWrap.classList.toggle('hidden', snap.editorHidden);
    // R11: restore the viewer-wrapper visibility captured above.
    const viewerEl = document.getElementById('viewer-container');
    if (viewerEl && snap.viewerHidden !== undefined) viewerEl.classList.toggle('hidden', snap.viewerHidden);
    const titleEl = document.getElementById('current-page-title');
    if (titleEl) titleEl.innerHTML = snap.titleHtml;
    const pidEl = document.getElementById('page-id-display');
    if (pidEl) { pidEl.textContent = snap.pageIdText; pidEl.classList.toggle('hidden', snap.pageIdHidden); }
};

const snapshotState = () => {
    const s = {};
    STATE_FIELDS.forEach(f => { s[f] = state[f]; });
    return s;
};

const restoreState = (s) => {
    if (!s) return;
    STATE_FIELDS.forEach(f => { if (f in s) state[f] = s[f]; });
};

// R11: each content type scrolls inside a different element — snapshot the
// right one so restored scroll positions actually apply. The .viewer-container
// div is only a flex shell; the actual scroller is the inner #viewer-content.
const scrollContainerFor = (type) => {
    if (type === 'list') return document.getElementById('list-items-table');
    if (type === 'json') return document.getElementById('json-view-content') || document.getElementById('json-view-container');
    if (type === 'chat') return document.getElementById('chat-view-container');
    if (type === 'search') return document.getElementById('adv-search-results');
    if (type === 'diagram') return document.getElementById('diagram-viewer');
    return document.getElementById('viewer-content');
};

const saveCurrent = async () => {
    if (!_activeKey) return;
    const tab = _tabs.get(_activeKey);
    if (!tab) return;
    // Folder views (file_tree sets state directly, bypassing tabs) are not
    // tab content — never let their state leak into the active file tab.
    if (state.currentPageType === 'folder' && tab.path !== state.currentPagePath) return;
    tab.snap = snapshotDom();
    tab.stateSnap = snapshotState();
    const scrollEl = scrollContainerFor(state.currentPageType);
    tab.scrollTop = scrollEl ? scrollEl.scrollTop : 0;
    const ed = document.getElementById('editor-container');
    if (ed) {
        tab.editorValue = ed.value;
        tab.selStart = ed.selectionStart ?? 0;
        tab.selEnd = ed.selectionEnd ?? 0;
    }
    // R11: .json pages keep their live editor instance in json_view — capture
    // its current text so a restore can rebuild the instance (an innerHTML
    // restore would orphan it) with in-progress edits intact.
    if (state.currentPageType === 'json') {
        try {
            const { getJsonEditorText } = await import('../../modules/json_view/index.js');
            tab.jsonText = getJsonEditorText();
        } catch { tab.jsonText = null; }
    } else {
        tab.jsonText = null;
    }
    tab.isEditing = !!state.isEditing;
    tab.hasUnsavedChanges = !!state.hasUnsavedChanges;
    tab.type = state.currentPageType;
};

const restoreTab = async (tab) => {
    // Stop any active chat poll before swapping content.
    try { const m = await import('../../modules/chat/index.js'); m.stopPolling(); } catch {}
    try { const m = await import('../../modules/page_chat/index.js'); m.closePanel(); } catch {}
    // R11: a .json editor instance must never outlive its tab — tear it down
    // before any non-json restore, or the orphaned instance would hold stale
    // DOM/events and leak into the next restore.
    try { const m = await import('../../modules/json_view/index.js'); m.destroyJsonEditor?.(); } catch {}

    // R8: an empty workspace tab ("+") restores to the blank page, not a file.
    if (!tab.path) {
        await showBlankPage();
        return;
    }

    if (tab.type === 'chat' || !tab.snap) {
        // Chat re-loads (polling state can't be snapshotted). First-open also
        // loads here.
        await loadPageSuppressed(tab.path, tab.id, tab.tags);
        return;
    }

    if (tab.type === 'filesfolder') {
        // Re-loads so its per-row delete buttons (bound inside renderFiles)
        // stay live.
        await loadFilesFolder(tab.path);
        return;
    }

    // === R11: list & json restore through their own renderers instead of a
    // full re-load, so their in-tab state (sort/view for list, live editor for
    // json) actually survives tab switches. ===
    if (tab.type === 'list') {
        // List edits are saved to disk immediately (modals), but the active
        // view and sort order live in state and a full re-load would reset
        // them. renderListView/refreshViewTabs re-render from the restored
        // state and re-bind their handlers, so no re-load is needed.
        restoreState(tab.stateSnap);
        // Show the list container, hide everything else — loadPage owns this
        // choreography on a fresh open, so the restore has to redo it.
        document.getElementById('viewer-container')?.classList.add('hidden');
        document.getElementById('list-view-container')?.classList.remove('hidden');
        document.getElementById('chat-view-container')?.classList.add('hidden');
        document.getElementById('search-view-container')?.classList.add('hidden');
        document.getElementById('json-view-container')?.classList.add('hidden');
        document.getElementById('files-folder-container')?.classList.add('hidden');
        document.getElementById('diagram-viewer')?.classList.add('hidden');
        const editorWrap = document.querySelector('.editor-container-wrapper');
        if (editorWrap) editorWrap.classList.add('hidden');
        try {
            const { renderListView } = await import('../../modules/list/render.js');
            const { refreshViewTabs } = await import('../../modules/list/index.js');
            renderListView();
            refreshViewTabs();
        } catch {}
        updateBreadcrumb(tab.path, tab.space || state.currentSpace);
        updateFavoriteBtn(tab.id || null);
        const tbl = document.getElementById('list-items-table');
        if (tbl) requestAnimationFrame(() => { tbl.scrollTop = tab.scrollTop || 0; });
        try {
            const { stopFileWatch, startFileWatch } = await import('../../modules/page_view/index.js');
            stopFileWatch();
            startFileWatch(tab.path, 0, null);
        } catch {}
        revealAndSelectFile(tab.path);
        return;
    }

    if (tab.type === 'json') {
        // The vanilla-jsoneditor instance can't survive an innerHTML restore
        // (events + instance state would be orphaned). Rebuild it from the
        // text captured at save time so in-progress edits survive.
        restoreState(tab.stateSnap);
        // Show the json container, hide everything else — same as loadPage.
        document.getElementById('viewer-container')?.classList.add('hidden');
        document.getElementById('list-view-container')?.classList.add('hidden');
        document.getElementById('chat-view-container')?.classList.add('hidden');
        document.getElementById('search-view-container')?.classList.add('hidden');
        document.getElementById('json-view-container')?.classList.remove('hidden');
        document.getElementById('files-folder-container')?.classList.add('hidden');
        document.getElementById('diagram-viewer')?.classList.add('hidden');
        const editorWrap = document.querySelector('.editor-container-wrapper');
        if (editorWrap) editorWrap.classList.add('hidden');
        try {
            const { renderJsonView } = await import('../../modules/json_view/index.js');
            const raw = (tab.jsonText !== undefined && tab.jsonText !== null)
                ? tab.jsonText
                : (state.initialContent || '');
            await renderJsonView(raw, tab.path);
        } catch {}
        // renderJsonView clears hasUnsavedChanges while booting the editor —
        // re-apply the real flag (and arm the Save button) after the rebuild.
        if (tab.hasUnsavedChanges) {
            state.hasUnsavedChanges = true;
            const saveBtn = document.getElementById('json-save-btn');
            if (saveBtn) saveBtn.disabled = false;
        }
        updateBreadcrumb(tab.path, tab.space || state.currentSpace);
        updateFavoriteBtn(tab.id || null);
        const c = document.getElementById('json-view-content') || document.getElementById('json-view-container');
        if (c) requestAnimationFrame(() => { c.scrollTop = tab.scrollTop || 0; });
        try {
            const { stopFileWatch, startFileWatch } = await import('../../modules/page_view/index.js');
            stopFileWatch();
            startFileWatch(tab.path, 0, null);
        } catch {}
        revealAndSelectFile(tab.path);
        return;
    }
    // === end R11 ===

    restoreDom(tab.snap);
    restoreState(tab.stateSnap);
    // Editor content (textarea value isn't captured by innerHTML). Note: use
    // ?? not || — an empty string is a real edit (the user cleared the page),
    // not a missing value, and must not fall back to initialContent.
    const ed = document.getElementById('editor-container');
    if (ed) {
        ed.value = tab.editorValue ?? (state.initialContent || '');
        try {
            ed.selectionStart = tab.selStart || 0;
            ed.selectionEnd = tab.selEnd || 0;
        } catch {}
    }
    // R11: inline edit mode renders editable blocks inside viewer-content —
    // the innerHTML snapshot survives, but the per-block event handlers don't.
    // Rebuild the blocks from the restored inlineBlocks (which carry the
    // in-progress edits) and re-wire the handlers.
    if (state.isEditing && state.editMode === 'inline') {
        try {
            const m = await import('../../modules/page_edit/inline_editor.js');
            const vc = document.getElementById('viewer-content');
            const ta = vc?.querySelector('.wiki-block.inline-block-editing textarea');
            if (ta) {
                const idx = parseInt(ta.closest('.wiki-block')?.dataset.blockIndex, 10);
                if (!isNaN(idx) && Array.isArray(state.inlineBlocks) && state.inlineBlocks[idx] !== undefined) {
                    state.inlineBlocks[idx] = ta.value;   // commit the un-saved textarea
                }
            }
            await m.rebindInlineMode(state.inlineBlocks || []);
        } catch {}
    } else if (state.isEditing) {
        // Classic edit mode: re-apply the bits of setEditingMode(true) that
        // live outside the DOM snapshot — line indicator + editor metrics.
        try {
            const pe = await import('../../modules/page_edit/index.js');
            state.editorLineHeight = parseFloat(window.getComputedStyle(ed).lineHeight) || 24;
            const indicator = document.getElementById('line-indicator');
            if (indicator) indicator.style.visibility = 'visible';
            pe.updateLineIndicator();
        } catch {}
    }
    // Breadcrumb + star + title must reflect THIS tab's identity (two tabs can
    // share a filename in different folders — identity is the full path).
    updateBreadcrumb(tab.path, tab.space || state.currentSpace);
    updateFavoriteBtn(tab.id || null);
    // Scroll position. The innerHTML we just restored has no layout yet, so
    // setting scrollTop in the same tick would be clamped to 0 — wait for two
    // animation frames plus a short timeout to give the browser time to
    // compute scrollHeight.
    const vc = document.getElementById('viewer-content');
    if (vc) {
        const apply = () => { if (tab.scrollTop) vc.scrollTop = tab.scrollTop; };
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(apply, 30)));
    }
    // === local plugins: tabs + on-disk watcher ===
    // Snapshot restore skips loadPage (the normal place startFileWatch runs),
    // so restart the watcher for THIS tab — state.currentPageType was just
    // restored by restoreState above, letting startFileWatch filter types
    // correctly (diagram/search/chat are not watched).
    try {
        const { stopFileWatch, startFileWatch } = await import('../../modules/page_view/index.js');
        stopFileWatch();
        startFileWatch(tab.path, 0, null);
    } catch {}
    // === end local plugins ===
    revealAndSelectFile(tab.path);
};

// --- tab bar ------------------------------------------------------------------
const tabBarId = 'wiki-tabs';

const ensureBar = () => {
    let bar = document.getElementById(tabBarId);
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = tabBarId;
    bar.className = 'wiki-tabs';
    const main = document.querySelector('.main-content');
    // Insert at the very top of main-content, above the header.
    main?.insertAdjacentElement('afterbegin', bar);
    return bar;
};

const iconForType = (type) => {
    if (type === 'filesfolder') return icons.filesFolder;
    if (type === 'diagram') return icons.diagram;
    if (type === 'list') return icons.list;
    if (type === 'chat') return icons.chat;
    if (type === 'search') return icons.search;
    if (type === 'json') return icons.json;
    return icons.file;
};

// Tab label: plain filename, but when two open tabs share a filename in
// different folders (Folder A/test.md vs Folder B/test.md) show the parent
// folder so they can be told apart (VS Code behaviour).
const tabLabel = (tab, allTabs) => {
    const base = tab.title || t('tabs.new-tab');
    if (!tab.path) return base;                       // empty "+" tab
    const sameBase = allTabs.filter(x => x.title === base && x.path !== tab.path);
    if (!sameBase.length) return base;
    const parts = tab.path.split('/').filter(Boolean);
    parts.pop(); // drop filename
    const dir = parts.slice(-2).join('/');
    return dir ? (dir + ' / ' + base) : base;
};

const renderBar = () => {
    const bar = ensureBar();
    bar.innerHTML = '';
    // R9: one scroll strip holds the tabs AND the "+" button, which sits at
    // the END of the tab sequence (Chrome logic) — it scrolls together with
    // the tabs instead of being pinned to the right edge of the bar. A new
    // tab is inserted immediately to its left; with many tabs the whole
    // sequence (including "+") scrolls horizontally.
    const strip = document.createElement('div');
    strip.className = 'wiki-tabs-scroll';
    bar.appendChild(strip);
    const ordered = _order.map(k => ({ k, tab: _tabs.get(k) })).filter(x => x.tab);
    ordered.forEach(({ k, tab }) => {
        const el = document.createElement('div');
        // R11: italic now means "editing" (tab.isEditing), not "preview" —
        // a plain click opens a preview slot, which is NOT an edit.
        el.className = 'wiki-tab' + (k === _activeKey ? ' active' : '') + (tab.isPreview ? ' preview' : '') + (tab.isEditing ? ' editing' : '');
        el.dataset.tabKey = k;
        el.title = (tab.space ? tab.space + ' / ' : '') + (tab.path || t('tabs.new-tab'));
        el.innerHTML = `<span class="wiki-tab-icon">${iconForType(tab.type)}</span><span class="wiki-tab-name"></span>`;
        el.querySelector('.wiki-tab-name').textContent = tabLabel(tab, ordered.map(x => x.tab));
        if (tab.hasUnsavedChanges) {
            const dot = document.createElement('span');
            dot.className = 'wiki-tab-dirty';
            dot.textContent = '•';
            el.appendChild(dot);
        }
        const close = document.createElement('button');
        close.className = 'wiki-tab-close';
        close.title = t('tabs.close');
        close.innerHTML = '&times;';
        close.addEventListener('click', async (e) => {
            e.stopPropagation();
            await closeTab(k);
        });
        el.appendChild(close);
        el.addEventListener('click', () => switchTo(k));
        strip.appendChild(el);
    });
    // R9: "+" lives INSIDE the strip, after the last tab, so it is part of
    // the tab sequence (Chrome) — never pinned to the bar's right edge.
    const addBtn = document.createElement('button');
    addBtn.className = 'wiki-tab-add';
    addBtn.title = t('tabs.new-tab');
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => addBlankTab());
    strip.appendChild(addBtn);
    wireTabBarDrag(strip);
    scrollActiveTabIntoView();
};

// R8: keep the active tab inside the visible strip (open-in-new-tab, "+",
// switching and reordering can otherwise leave it scrolled out of view).
// R9: when the active tab is the LAST tab (immediately followed by "+") the
// scroll goal extends to the "+" button, so the next-tab entry point stays
// visible too — Chrome-style, since "+" is part of the tab sequence.
const scrollActiveTabIntoView = () => {
    const bar = ensureBar();
    const strip = bar.querySelector('.wiki-tabs-scroll');
    if (!strip) return;
    const sLeft = strip.scrollLeft;
    const sRight = sLeft + strip.clientWidth;
    const stripLeft = strip.getBoundingClientRect().left;
    const add = strip.querySelector('.wiki-tab-add');
    // Empty strip → make sure the lone "+" is visible.
    const active = strip.querySelector('.wiki-tab.active');
    if (!active) {
        if (add) {
            const aLeft = add.getBoundingClientRect().left - stripLeft + sLeft;
            const aRight = aLeft + add.offsetWidth;
            if (aLeft < sLeft) strip.scrollLeft = Math.max(0, aLeft - 8);
            else if (aRight > sRight) strip.scrollLeft = aRight - strip.clientWidth + 8;
        }
        return;
    }
    const isLastTab = active.nextElementSibling === add;
    // strip is position:static, so offsetLeft is relative to a distant
    // positioned ancestor — use viewport-relative rects instead.
    const tLeft = active.getBoundingClientRect().left - stripLeft + sLeft;
    const tRight = (isLastTab && add)
        ? (add.getBoundingClientRect().left - stripLeft + sLeft + add.offsetWidth)
        : (tLeft + active.offsetWidth);
    if (tLeft < sLeft) {
        strip.scrollLeft = Math.max(0, tLeft - 8);
    } else if (tRight > sRight) {
        strip.scrollLeft = tRight - strip.clientWidth + 8;
    }
};

// Drag to reorder the tabs within the single tab strip (VS Code behaviour).
// (True split panes / drag-out would need loadPage to render into per-pane
// containers — a deep core change — so it is intentionally not implemented;
// see AGENTS.md. Reordering costs nothing and is expected muscle memory.)
let _dragTabEl = null;

const wireTabBarDrag = (bar) => {
    if (bar.dataset.dragWired) return;
    bar.dataset.dragWired = '1';

    bar.addEventListener('dragstart', (e) => {
        const tab = e.target.closest('.wiki-tab');
        if (!tab) return;
        _dragTabEl = tab;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', tab.dataset.tabKey || ''); } catch {}
    });

    bar.addEventListener('dragend', () => {
        if (_dragTabEl) _dragTabEl.classList.remove('dragging');
        _dragTabEl = null;
    });

    bar.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const over = e.target.closest('.wiki-tab');
        if (!over || !_dragTabEl || over === _dragTabEl) return;
        const rect = over.getBoundingClientRect();
        const after = (e.clientX - rect.left) > rect.width / 2;
        bar.insertBefore(_dragTabEl, after ? over.nextSibling : over);
        // Keep `_order` in sync with the DOM so the next renderBar (triggered
        // by switching/closing tabs) doesn't snap the order back (R4 fix).
        _order.length = 0;
        bar.querySelectorAll('.wiki-tab').forEach(el => {
            const k = el.dataset.tabKey;
            if (k) _order.push(k);
        });
    });

    bar.addEventListener('drop', (e) => e.preventDefault());
};

// --- public actions -----------------------------------------------------------
// R8 unified open model (see header): opts.preview (default true) = plain
// click → replaceable preview slot; opts.newTab = explicit "open in new tab"
// (right-click) → permanent tab; opts.preview === false = programmatic
// permanent open (new-file auto-open). Ctrl+click never reaches this function
// (file-tree multi-select owns it).
export const openInTab = async (path, id, tags, opts = {}) => {
    if (path === undefined || path === null) return;
    const space = state.currentSpace || '';
    // Switching space clears tabs (spaces are isolated). The first tab's space
    // stands in for the current space — space switches always reset first.
    const firstTab = _order.length ? _tabs.get(_order[0]) : null;
    if (firstTab && firstTab.space !== space) {
        _tabs.clear(); _order.length = 0; _activeKey = null; _previewKey = null;
    }
    const k = tabKey(space, path);
    // Short-circuit only when the browse state still matches.
    if (k === _activeKey && state.currentPagePath === path) return;

    // Already open → just activate it (identity is space+path). Re-activating
    // from the file tree is still an *open* action, so refresh Recents — but
    // plain tab-bar clicks (switchTo directly) leave Recents untouched.
    if (_tabs.has(k)) {
        try {
            const { trackPageVisit } = await import('../../modules/nav/index.js');
            trackPageVisit(id, path, space);
        } catch {}
        await switchTo(k);
        return;
    }

    const preview = opts.preview !== false;   // plain click = preview slot
    const newTab  = !!opts.newTab;            // explicit "open in new tab"
    // R9: a files-folder is an openable content object (its own tab) — it is
    // routed to loadFilesFolder instead of loadPage, and re-loads on restore
    // (per-row delete handlers). "File Library in a tab" ≠ "files uploaded
    // into the File Library" (the upload flow is untouched).
    const isFilesFolder = opts.type === 'filesfolder';
    const isPreviewSlot = preview && !newTab; // what a NEW tab actually is
    let reuseKey = null;
    const active = _activeKey ? _tabs.get(_activeKey) : null;

    if (active) {
        // A replaceable slot: a clean preview, or an empty workspace tab from
        // "+". A dirty/editing preview must never be replaced silently.
        const emptyWorkspace = !active.path && !active.hasUnsavedChanges && !active.isEditing;
        if (newTab) {
            // Explicit new-tab request: reuse only an EMPTY workspace tab
            // (never steal the preview slot); promote a dirty preview.
            if (emptyWorkspace) reuseKey = _activeKey;
            else if (active.isPreview) promotePreview();
        } else if (preview) {
            // Plain click: reuse the preview/empty slot; a dirty preview gets
            // promoted and a new preview opens instead.
            if ((active.isPreview || !active.path) && !active.hasUnsavedChanges && !active.isEditing) {
                reuseKey = _activeKey;
            } else if (active.isPreview) {
                promotePreview();
            }
        } else {
            // Programmatic permanent open (new-file auto-open): reuse an empty
            // workspace tab, otherwise open a fresh permanent tab.
            if (emptyWorkspace) reuseKey = _activeKey;
            else if (active.isPreview) promotePreview();
        }
    }

    if (reuseKey) {
        // Reuse the active tab's key: same position in _order/bar, only the
        // identity + cached content change.
        const tab = _tabs.get(reuseKey);
        tab.path = path; tab.id = id; tab.tags = tags || [];
        tab.type = isFilesFolder ? 'filesfolder' : null;
        tab.title = path.split('/').filter(Boolean).pop().replace(/\.(md|drawio|list|chat|search|json)$/, '');
        tab.snap = null; tab.stateSnap = null; tab.scrollTop = 0;
        tab.editorValue = ''; tab.selStart = 0; tab.selEnd = 0;
        tab.isEditing = false; tab.hasUnsavedChanges = false;
        tab.isPreview = isPreviewSlot;   // reused slot keeps its open intent
        _tabs.delete(reuseKey);
        _tabs.set(k, tab);
        const idx = _order.indexOf(reuseKey);
        if (idx !== -1) _order[idx] = k;
        _activeKey = k;
        _previewKey = isPreviewSlot ? k : null;
        renderBar();
        await loadPageSuppressed(path, id, tags, isFilesFolder);
        await saveCurrent();
        renderBar();
        return;
    }

    // Brand-new tab.
    await saveCurrent();
    const tab = makeTab(path, id, tags);
    tab.isPreview = isPreviewSlot;
    tab.type = isFilesFolder ? 'filesfolder' : null;
    _tabs.set(k, tab);
    _order.push(k);
    _activeKey = k;
    _previewKey = isPreviewSlot ? k : null;
    renderBar();
    await loadPageSuppressed(path, id, tags, isFilesFolder);
    await saveCurrent();
    renderBar();
};

// R8: turn the active preview tab into a permanent one. Triggered by an edit,
// "open in new tab", or when a plain click needs the slot for a new page.
const promotePreview = () => {
    if (!_activeKey) return;
    const tab = _tabs.get(_activeKey);
    if (!tab || !tab.isPreview) return;
    tab.isPreview = false;
    _previewKey = null;
    renderBar();
};

// R8: "+" button — create an EMPTY permanent workspace tab. Multiple empty
// tabs are allowed (each gets a unique key); the next plain click opens the
// clicked file inside the ACTIVE empty tab.
let _blankSeq = 0;
const blankTabKey = (space) => tabKey(space, '__blank__' + (++_blankSeq));

export const addBlankTab = async () => {
    const space = state.currentSpace || '';
    const active = _activeKey ? _tabs.get(_activeKey) : null;
    if (active && active.isPreview) promotePreview();
    await saveCurrent();
    const tab = makeTab('', null, []);
    tab.isPreview = false;
    const k = blankTabKey(space);
    _tabs.set(k, tab);
    _order.push(k);
    _activeKey = k;
    _previewKey = null;
    renderBar();
    await showBlankPage();
    renderBar();
};

export const switchTo = async (k) => {
    const target = _tabs.get(k);
    if (!target) return;
    // Same tab unless the browse state moved outside tabs (folder view) —
    // then restore it even though the key matches.
    if (k === _activeKey && state.currentPagePath === target.path) return;
    // No discard dialog here: switching tabs snapshots the current tab's full
    // state (unsaved edits included) via saveCurrent(), so nothing is lost —
    // the same VS Code behaviour. Closing a tab is the only action that
    // destroys state, and closeTab guards that. (loadPage's own guard must be
    // suppressed in restoreTab/loadPageSuppressed, or it would double-prompt.)
    await saveCurrent();
    _activeKey = k;
    _previewKey = target.isPreview ? k : null;
    renderBar();
    await restoreTab(target);
};

// loadPage shows a discard dialog when the current page has unsaved edits.
// Under tabs every "navigate away" path first snapshots the old tab
// (saveCurrent), so nothing is lost and the dialog would only double-prompt.
// This helper clears the guard state right before loadPage; the caller has
// already captured the real values in the outgoing tab's snapshot.
// R9: a files-folder is rendered by loadFilesFolder (not loadPage) — see
// openInTab.
const loadPageSuppressed = async (path, id, tags, isFilesFolder) => {
    if (isFilesFolder) {
        await loadFilesFolder(path);
        return;
    }
    const saved = { e: state.isEditing, u: state.hasUnsavedChanges, t: state.currentPageType };
    state.isEditing = false;
    state.hasUnsavedChanges = false;
    state.currentPageType = null;
    await loadPage(path, id, tags);
    // Do NOT restore `saved`: after a fresh loadPage the state belongs to the
    // new page (chat/list/file). The old tab's values live in its snapshot.
    void saved;
};

// Any tab carrying unsaved edits? (Used by script.js before switching space,
// where resetTabs() would otherwise discard them silently.)
export const hasUnsavedTabs = () => Array.from(_tabs.values()).some(t => t.hasUnsavedChanges);

export const closeTab = async (k) => {
    const tab = _tabs.get(k);
    if (!tab) return;
    if (tab.hasUnsavedChanges && !await confirmModal(t('edit.discard-confirm'), {
        message: t('tabs.close-discard'), confirmLabel: t('btn.discard'), dangerous: true, icon: icons.warning,
    })) return;
    const idx = _order.indexOf(k);
    _tabs.delete(k);
    if (_previewKey === k) _previewKey = null;
    if (idx !== -1) _order.splice(idx, 1);
    if (k === _activeKey) {
        const nextKey = _order[idx] || _order[idx - 1] || null;
        if (nextKey) {
            _activeKey = null; // force switchTo to run
            await switchTo(nextKey);
        } else {
            _activeKey = null;
            renderBar();
            await showBlankPage();
            // No page open anymore — clear the stale tree highlight.
            document.querySelectorAll('#file-navigator .file-item.active')
                .forEach(el => el.classList.remove('active'));
        }
    } else {
        renderBar();
    }
};

// Close every tab except `keep`. Each closeTab() still guards unsaved edits.
const closeOthers = async (keep) => {
    for (const k of Array.from(_order)) {
        if (k !== keep) await closeTab(k);
    }
};

// Close every tab to the right of `k` (VS Code "Close to the right").
const closeToRight = async (k) => {
    const idx = _order.indexOf(k);
    if (idx === -1) return;
    for (const k2 of Array.from(_order).slice(idx + 1)) {
        await closeTab(k2);
    }
};

// R4: file renames/moves (from file_ops/move.js) remap the affected open tab so
// the tab keeps the file identity instead of pointing at a now-dead path. The
// snapshot (content/editor/scroll) travels with the tab unchanged.
export const remapTab = (oldPath, newPath) => {
    if (!oldPath || !newPath || oldPath === newPath) return;
    const space = state.currentSpace || '';
    const oldKey = tabKey(space, oldPath);
    const newKey = tabKey(space, newPath);
    const tab = _tabs.get(oldKey);
    if (!tab) return;
    tab.path = newPath;
    tab.title = newPath.split('/').pop().replace(/\.(md|drawio|list|chat|search|json)$/, '');
    _tabs.delete(oldKey);
    _tabs.set(newKey, tab);
    const idx = _order.indexOf(oldKey);
    if (idx !== -1) _order[idx] = newKey;
    if (_previewKey === oldKey) _previewKey = newKey;
    if (_activeKey === oldKey) {
        _activeKey = newKey;
        updateBreadcrumb(newPath, space);
        revealAndSelectFile(newPath);
        // The page-title element shows the tab's identity — refresh it so a
        // rename is reflected immediately (the snapshot re-captures on the
        // next switch, so the new title persists across tabs).
        const titleEl = document.getElementById('current-page-title');
        if (titleEl) titleEl.textContent = tab.title;
    }
    renderBar();
};

// R4: after the currently-open file is deleted (file_ops handleDelete), close
// its tab and show the fallback (start page or blank), so no stale tab lingers.
export const openAfterDelete = async (deletedPath, fallbackPath, fallbackId) => {
    const space = state.currentSpace || '';
    const key = tabKey(space, deletedPath);
    const idx = _order.indexOf(key);
    if (idx !== -1) {
        _tabs.delete(key);
        _order.splice(idx, 1);
        if (_activeKey === key) _activeKey = null;
        renderBar();
    }
    if (fallbackPath) {
        await openInTab(fallbackPath, fallbackId, []);
    } else {
        const { showBlankPage } = await import('../../modules/page_view/index.js');
        await showBlankPage();
    }
};

// Called when the space changes externally (script.js onSpaceChange) so stale
// tabs from the previous space don't linger.
export const resetTabs = () => {
    _tabs.clear();
    _order.length = 0;
    _activeKey = null;
    _previewKey = null;
    renderBar();
};

// Right-click on a tab → close / close others / close right. Right-clicking
// blank bar space shows nothing (the layout belongs to the sidebar, not here).
const wireTabContextMenu = () => {
    const bar = ensureBar();
    if (bar.dataset.ctxWired) return;
    bar.dataset.ctxWired = '1';
    bar.addEventListener('contextmenu', (e) => {
        const tabEl = e.target.closest('.wiki-tab');
        if (!tabEl) return;               // blank bar area: no menu
        e.preventDefault();
        e.stopPropagation();
        const k = tabEl.dataset.tabKey;
        const idx = _order.indexOf(k);
        const last = _order.length - 1;
        showContextMenu([
            { label: t('tabs.close'), onClick: () => closeTab(k) },
            { separator: true },
            { label: t('tabs.close-others'), hidden: _order.length < 2, onClick: () => closeOthers(k) },
            { label: t('tabs.close-right'), hidden: idx < 0 || idx === last, onClick: () => closeToRight(k) },
        ], e.clientX, e.clientY);
    });
};

export const init = () => {
    wireTabContextMenu();
    renderBar(); // renders an empty bar (tabs appear as pages open)
    // R10: re-render the tab strip so tooltips fall back correctly after a
    // language switch (tab labels themselves are file names — user content).
    window.addEventListener('wiki:languagechange', renderBar);
    // R11: keep each tab's `isEditing` (and therefore the italic "editing"
    // style) in lock-step with state.isEditing, no matter which code path
    // flips it — edit button, hotkey, save, cancel, or restoreState. This is
    // the only way to catch every path without touching core modules, and the
    // interception lives entirely inside this plugin (removable with it).
    let _isEditingValue = !!state.isEditing;
    try {
        Object.defineProperty(state, 'isEditing', {
            configurable: true,
            get: () => _isEditingValue,
            set: (v) => {
                _isEditingValue = !!v;
                const tab = _activeKey ? _tabs.get(_activeKey) : null;
                if (tab && tab.path && tab.isEditing !== _isEditingValue) {
                    tab.isEditing = _isEditingValue;
                    renderBar();
                }
            },
        });
    } catch (e) { /* state already locked by another plugin — degrade silently */ }
    // R7: starting to type in the editor promotes the active preview tab to a
    // permanent one (VS Code behaviour — a preview is only for peeking; edits
    // must never be silently dropped).
    document.getElementById('editor-container')?.addEventListener('input', () => {
        const tab = _activeKey ? _tabs.get(_activeKey) : null;
        if (tab && tab.isPreview) { tab.isPreview = false; _previewKey = null; renderBar(); }
    });
    // === local plugins: expose remap helpers to file_ops/move.js via the
    // established window.* delegation pattern (removable — the core calls use
    // optional chaining, so without tabs they are simply no-ops) ===
    window.__tabsRemapTab = remapTab;
    window.__tabsOpenAfterDelete = openAfterDelete;
    // R8: expose the unified open entry point to CORE modules (new_items
    // auto-opens freshly created files through this instead of calling loadPage
    // directly — the old path bypassed tabs and desynced the tab bar). Falls
    // back to plain loadPage when the tabs plugin is removed.
    window.__openInTab = (path, id, tags, opts) => {
        if (typeof openInTab === 'function') return openInTab(path, id, tags, opts);
        return loadPage(path, id, tags || []);
    };
};
// === end local plugin ===
