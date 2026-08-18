// === local plugin: sidebar_tab_order ===
// Sidebar pane-tab "layout editor". Two explicit modes:
//
//  NORMAL MODE — tabs are inert (never draggable, so they can't be reordered
//  by accident). The tab bar carries no visible buttons; right-clicking it
//  opens a context menu whose "Edit tab layout" item enters the editor.
//  Hidden tabs (per-user setting) stay hidden here.
//
//  EDIT MODE — entered via the context menu; the tab bar gets a distinct
//  .editing style so the mode is obvious. Every visible tab gains a drag
//  handle (⠿) and is draggable; each tab has a visibility toggle; hidden tabs
//  disappear from the bar and are listed under an "Add tab" menu so they can
//  be brought back. "Done" saves (order + hidden) to localStorage AND to the
//  server (users.json sidebarTabOrder / sidebarTabHidden) when authenticated;
//  "Cancel" restores the pre-edit snapshot. Both are offered again through the
//  context menu (right-click while editing); Esc also cancels. Both exit.
//
// Storage: localStorage wins (per-browser, works with auth off), then the
// server-side values (window.WIKI_SIDEBAR_TAB_ORDER / _HIDDEN) for the logged
// in user. Per-user isolation: localStorage is per-browser; server fields
// follow the account across devices.
//
// Forward-compat: tab ids are read live from the DOM. Unknown ids in saved
// data are ignored; tabs missing from a saved order append at the end; tabs
// added by a future upstream build appear automatically and are visible by
// default. An empty hidden set means "show everything".
//
// The Preferences dialog's drag-reorder list remains a secondary entry point
// (order only; visibility is managed here).
//
// Removability: delete this directory, the script.js import/init, the marked
// blocks in index.php (WIKI_SIDEBAR_TAB_ORDER/HIDDEN + the import-map scan),
// the preferences/index.js calls, the api.php sidebarTabOrder/Hidden handling,
// the i18n keys (tab-order.*, prefs.tab-order-*), and the CSS block.

import { api } from '../../modules/core/api.js';
import { showToast } from '../../modules/core/utils.js';
import { t } from '../../modules/i18n/index.js';
import { showContextMenu } from '../context_menu/index.js';

const ORDER_KEY  = 'wiki_pane_tab_order';
const HIDDEN_KEY = 'wiki_pane_tab_hidden';

// Feather-style inline icons (stroke = currentColor), matching the sidebar's
// existing low-contrast icon buttons (see .sidebar-toggle-btn).
const ICON_GEAR  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const ICON_X     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
const ICON_PLUS  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

// ── Storage ───────────────────────────────────────────────────────────────────

const loadLocal = (key) => {
    try {
        const v = JSON.parse(localStorage.getItem(key) || 'null');
        return Array.isArray(v) ? v : null;
    } catch { return null; }
};
const saveLocal = (key, arr) => {
    try { localStorage.setItem(key, JSON.stringify(arr)); } catch {}
};

const loadLocalOrder  = () => loadLocal(ORDER_KEY);
const loadLocalHidden = () => loadLocal(HIDDEN_KEY);

// Best-effort server sync (no-op when unauthenticated).
const syncToServer = async (order, hidden) => {
    if (!window.WIKI_USER_SUB) return;
    try {
        await api.call('user_save_preferences', {
            sidebarTabOrder: JSON.stringify(order || []),
            sidebarTabHidden: JSON.stringify(hidden || []),
        }, 'POST');
    } catch {}
};

// ── DOM helpers ───────────────────────────────────────────────────────────────

const tabBar = () => document.querySelector('.pane-tabs');
const panesWrap = () => document.querySelector('.sidebar-panes');

const readTabsFromDom = () => {
    const tabs = Array.from(document.querySelectorAll('.pane-tab'));
    return tabs.map(tab => {
        const id = tab.dataset.pane || '';
        // Label = the tab's own text only (exclude child spans such as the
        // edit-mode visibility toggle), falling back to the title attribute.
        const label = Array.from(tab.childNodes)
            .filter(n => n.nodeType === Node.TEXT_NODE)
            .map(n => n.textContent).join('').trim()
            || tab.getAttribute('title') || id;
        return { id, label };
    });
};

// Reorder .pane-tab buttons and their .pane-content panels to match `order`
// (array of pane ids). Tabs not in `order` keep DOM order, appended. Active
// pane state is preserved (we only move nodes).
export const applySidebarTabOrder = (order) => {
    if (!Array.isArray(order) || order.length === 0) return;
    const bar = tabBar();
    if (!bar) return;

    const tabs = Array.from(bar.querySelectorAll('.pane-tab'));
    const tabMap = new Map(tabs.map(x => [x.dataset.pane, x]));
    const seen = new Set();
    const orderedTabs = [];
    order.forEach(id => {
        const tab = tabMap.get(id);
        if (tab && !seen.has(id)) { orderedTabs.push(tab); seen.add(id); }
    });
    tabs.forEach(x => { if (!seen.has(x.dataset.pane)) orderedTabs.push(x); });
    orderedTabs.forEach(x => bar.appendChild(x));

    const wrap = panesWrap();
    if (wrap) {
        const contents = Array.from(wrap.querySelectorAll('.pane-content'));
        const contentMap = new Map(contents.map(c => [c.id, c]));
        const seenC = new Set();
        const orderedC = [];
        order.forEach(id => {
            const c = contentMap.get(id + '-pane');
            if (c && !seenC.has(c.id)) { orderedC.push(c); seenC.add(c.id); }
        });
        contents.forEach(c => { if (!seenC.has(c.id)) orderedC.push(c); });
        orderedC.forEach(c => wrap.appendChild(c));
    }
};

// Hide the given pane ids: their .pane-tab buttons get display:none. If the
// currently-active pane ends up hidden, switch to the first visible one.
export const applySidebarTabHidden = (hidden) => {
    const set = new Set(Array.isArray(hidden) ? hidden : []);
    const bar = tabBar();
    if (!bar) return;
    let activeHidden = false;
    bar.querySelectorAll('.pane-tab').forEach(tab => {
        const hide = set.has(tab.dataset.pane);
        tab.classList.toggle('pane-tab-hidden', hide);
        tab.style.display = hide ? 'none' : '';
        if (hide && tab.classList.contains('active')) activeHidden = true;
    });
    if (activeHidden) {
        const firstVisible = Array.from(bar.querySelectorAll('.pane-tab'))
            .find(t => t.style.display !== 'none');
        firstVisible?.click();
    }
};

const currentOrderFromDom = () => readTabsFromDom().map(x => x.id);
const currentHiddenFromDom = () => Array.from(document.querySelectorAll('.pane-tab.pane-tab-hidden'))
    .map(tab => tab.dataset.pane).filter(Boolean);

// ── Boot ──────────────────────────────────────────────────────────────────────

// Apply the effective order + hidden on boot (localStorage → server → default).
const applyBootState = () => {
    try {
        const localOrder = loadLocalOrder();
        const serverOrder = window.WIKI_SIDEBAR_TAB_ORDER;
        if (Array.isArray(localOrder)) applySidebarTabOrder(localOrder);
        else if (Array.isArray(serverOrder)) applySidebarTabOrder(serverOrder);

        const localHidden = loadLocalHidden();
        const serverHidden = window.WIKI_SIDEBAR_TAB_HIDDEN;
        if (Array.isArray(localHidden)) applySidebarTabHidden(localHidden);
        else if (Array.isArray(serverHidden)) applySidebarTabHidden(serverHidden);
    } catch {}
};

// ── Edit mode ─────────────────────────────────────────────────────────────────

let _editing = false;
let _snapOrder = null;   // pre-edit DOM order
let _snapHidden = null;  // pre-edit hidden set
let _dragTabEl = null;

// Single re-usable drag wiring on the tab bar; the handlers no-op unless the
// bar is in edit mode, so tabs are never draggable outside the editor.
const wireTabBarDrag = () => {
    const bar = tabBar();
    if (!bar || bar.dataset.tabDragWired) return;
    bar.dataset.tabDragWired = '1';

    bar.addEventListener('dragstart', (e) => {
        if (!_editing) { e.preventDefault(); return; }
        const tab = e.target.closest('.pane-tab');
        if (!tab) return;
        _dragTabEl = tab;
        tab.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', tab.dataset.pane || ''); } catch {}
    });

    bar.addEventListener('dragend', () => {
        if (_dragTabEl) _dragTabEl.classList.remove('dragging');
        _dragTabEl = null;
    });

    bar.addEventListener('dragover', (e) => {
        if (!_editing) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const over = e.target.closest('.pane-tab');
        if (!over || !_dragTabEl || over === _dragTabEl) return;
        const rect = over.getBoundingClientRect();
        const after = (e.clientX - rect.left) > rect.width / 2;
        bar.insertBefore(_dragTabEl, after ? over.nextSibling : over);
    });

    bar.addEventListener('drop', (e) => { if (_editing) e.preventDefault(); });
};

const setTabDraggable = (on) => {
    document.querySelectorAll('.pane-tab').forEach(tab => { tab.draggable = on; });
};

// Render a visibility toggle (span, not a button — .pane-tab is a <button>,
// so nested <button> would be invalid HTML) into each tab while editing.
// The drag handle is drawn with CSS ::before so it never pollutes the label.
const renderVisToggles = () => {
    document.querySelectorAll('.pane-tab').forEach(tab => {
        const id = tab.dataset.pane;
        if (!id || tab.querySelector('.pane-tab-vis-toggle')) return;
        const vis = document.createElement('span');
        vis.className = 'pane-tab-vis-toggle';
        vis.dataset.pane = id;
        vis.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleTabVisibility(id);
        });
        tab.appendChild(vis);
    });
    refreshVisToggles();
};

const refreshVisToggles = () => {
    const hidden = new Set(currentHiddenFromDom());
    document.querySelectorAll('.pane-tab-vis-toggle').forEach(btn => {
        const hiddenNow = hidden.has(btn.dataset.pane);
        btn.textContent = hiddenNow ? '○' : '✓';
        btn.title = hiddenNow ? t('tab-order.show') : t('tab-order.hide');
        btn.classList.toggle('off', hiddenNow);
    });
};

const toggleTabVisibility = (id) => {
    const hidden = new Set(currentHiddenFromDom());
    if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
    // Apply hidden state to the DOM bar (hidden tabs vanish from the bar; they
    // reappear through the "Add tab" menu while editing).
    applySidebarTabHidden(Array.from(hidden));
    refreshVisToggles();
    renderAddMenu();
};

// "Add tab" menu: lists the currently-hidden panes so they can be re-shown.
const renderAddMenu = () => {
    const menu = document.getElementById('pane-tab-add-menu');
    if (!menu) return;
    const hidden = new Set(currentHiddenFromDom());
    const allTabs = readTabsFromDom();
    const addable = allTabs.filter(x => hidden.has(x.id));
    menu.innerHTML = '';
    if (!addable.length) {
        const empty = document.createElement('div');
        empty.className = 'pane-tab-add-empty';
        empty.textContent = t('tab-order.add-empty');
        menu.appendChild(empty);
        return;
    }
    addable.forEach(item => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'pane-tab-add-item';
        row.textContent = item.label || item.id;
        row.addEventListener('click', () => {
            const h = new Set(currentHiddenFromDom());
            h.delete(item.id);
            applySidebarTabHidden(Array.from(h));
            refreshVisToggles();
            renderAddMenu();
        });
        menu.appendChild(row);
    });
};

const toggleAddMenu = () => {
    const menu = document.getElementById('pane-tab-add-menu');
    if (!menu) return;
    renderAddMenu();
    menu.classList.toggle('hidden');
};

const enterEditMode = () => {
    if (_editing) return;
    _editing = true;
    _snapOrder = currentOrderFromDom();
    _snapHidden = currentHiddenFromDom();
    const bar = tabBar();
    if (bar) bar.classList.add('editing');
    renderVisToggles();
    setTabDraggable(true);
};

const exitEditMode = () => {
    if (!_editing) return;
    _editing = false;
    const bar = tabBar();
    if (bar) {
        bar.classList.remove('editing');
        bar.querySelectorAll('.pane-tab-vis-toggle').forEach(el => el.remove());
    }
    setTabDraggable(false);
    document.getElementById('pane-tab-add-menu')?.classList.add('hidden');
    _snapOrder = null;
    _snapHidden = null;
};

const cancelEditMode = () => {
    if (_snapOrder) applySidebarTabOrder(_snapOrder);
    if (_snapHidden !== null) applySidebarTabHidden(_snapHidden);
    exitEditMode();
};

const saveEditMode = async () => {
    const order = currentOrderFromDom();
    const hidden = currentHiddenFromDom();
    saveLocal(ORDER_KEY, order);
    saveLocal(HIDDEN_KEY, hidden);
    // Dragging only moved the tab buttons; re-sync the pane-content panels.
    applySidebarTabOrder(order);
    await syncToServer(order, hidden);
    exitEditMode();
    showToast(t('tab-order.saved'), 'success');
};

// ── Tab-bar context menu ─────────────────────────────────────────────────────
//
// R4: the dedicated Edit / Done / Cancel / Add buttons were removed so the tab
// bar stays clean. Right-clicking the tab bar opens a context menu instead:
//   normal mode → "Edit tab layout" (enters edit mode)
//   edit mode   → "Done" (save) / "Cancel" (restore snapshot) / "Add tab"
// Esc still cancels the editor.
const buildTabContextMenu = () => {
    const bar = tabBar();
    if (!bar || bar.dataset.ctxWired) return;
    bar.dataset.ctxWired = '1';

    // "Add tab" dropdown (lists hidden panes) — kept as the menu's sub-action.
    const menu = document.createElement('div');
    menu.id = 'pane-tab-add-menu';
    menu.className = 'pane-tab-add-menu hidden';
    bar.appendChild(menu);

    bar.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const items = _editing ? [
            { label: t('tab-order.done'), icon: ICON_CHECK, onClick: () => saveEditMode() },
            { label: t('tab-order.cancel'), icon: ICON_X, onClick: () => cancelEditMode() },
            { separator: true },
            { label: t('tab-order.add-tab'), icon: ICON_PLUS, onClick: () => toggleAddMenu() },
        ] : [
            { label: t('tab-order.edit'), icon: ICON_GEAR, onClick: () => enterEditMode() },
        ];
        showContextMenu(items, e.clientX, e.clientY);
    });

    // Esc cancels the editor (desktop convention) — kept independent of the menu.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && _editing) cancelEditMode();
    });
};

// ── Preferences dialog (secondary entry) ──────────────────────────────────────

let _draggedItem = null;

const makeRow = ({ id, label }) => {
    const li = document.createElement('li');
    li.className = 'pref-tab-order-row';
    li.draggable = true;
    li.dataset.pane = id;

    const handle = document.createElement('span');
    handle.className = 'pref-tab-order-handle';
    handle.textContent = '⠿';
    handle.title = t('prefs.tab-order-handle');

    const name = document.createElement('span');
    name.className = 'pref-tab-order-name';
    name.textContent = label || id;

    li.appendChild(handle);
    li.appendChild(name);

    li.addEventListener('dragstart', (e) => {
        _draggedItem = li;
        li.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', id); } catch {}
    });
    li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        _draggedItem = null;
    });
    li.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!_draggedItem || _draggedItem === li) return;
        const rect = li.getBoundingClientRect();
        const after = (e.clientY - rect.top) > rect.height / 2;
        li.parentNode.insertBefore(_draggedItem, after ? li.nextSibling : li);
    });
    li.addEventListener('drop', (e) => e.preventDefault());

    return li;
};

export const renderTabOrderList = (savedOrder) => {
    const ul = document.getElementById('pref-tab-order-list');
    if (!ul) return;
    const tabs = readTabsFromDom();
    const ordered = [];
    const seen = new Set();
    if (Array.isArray(savedOrder)) {
        savedOrder.forEach(id => {
            const tab = tabs.find(x => x.id === id);
            if (tab && !seen.has(id)) { ordered.push(tab); seen.add(id); }
        });
    }
    tabs.forEach(x => { if (!seen.has(x.id)) ordered.push(x); });
    ul.innerHTML = '';
    ordered.forEach(x => ul.appendChild(makeRow(x)));
};

export const getTabOrderFromList = () => {
    const ul = document.getElementById('pref-tab-order-list');
    if (!ul) return null;
    return Array.from(ul.querySelectorAll('.pref-tab-order-row'))
        .map(li => li.dataset.pane)
        .filter(Boolean);
};

// Called from preferences save: persist locally too so auth-off users and the
// current browser agree with the server immediately.
export const persistLocalOrder = (order) => {
    if (Array.isArray(order) && order.length) {
        saveLocal(ORDER_KEY, order);
        applySidebarTabOrder(order);
    }
};

export const init = () => {
    wireTabBarDrag();
    buildTabContextMenu();
    applyBootState();
};
// === end local plugin ===
