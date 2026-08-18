// === local plugin: context_menu ===
// Minimal shared right-click context menu used by the tab bar and the file
// tree. It only renders a menu — the item list (label / icon / danger /
// separator / hidden / onClick) is supplied by each caller, so every plugin
// keeps its own actions and this component stays removable.
//
// Menu items:
//   { label, icon?, danger?, separator?, hidden?, onClick() }
//   - separator: renders a divider line and ignores everything else.
//   - hidden:    the item is skipped (lets callers build one static list and
//                enable/disable entries contextually).
//
// Visual language matches the existing .file-actions-menu (see styles.css):
// same 6px radius, 4px padding, hover row, danger color, 1px separator.
//
// Removability: delete this directory + the CSS block (.ctx-menu*) + remove
// the imports in the plugins that use it (sidebar_tab_order / tabs /
// tree_drag_move).

let _el = null;
let _onDocMouseDown = null;
let _onDocKeyDown = null;

export const closeContextMenu = () => {
    if (_el) { _el.remove(); _el = null; }
    if (_onDocMouseDown) { document.removeEventListener('mousedown', _onDocMouseDown); _onDocMouseDown = null; }
    if (_onDocKeyDown) { document.removeEventListener('keydown', _onDocKeyDown); _onDocKeyDown = null; }
};

/**
 * Show a context menu at viewport (x, y), clamped to the window.
 * @param {Array<object>} items
 * @param {number} x
 * @param {number} y
 */
export const showContextMenu = (items, x, y) => {
    closeContextMenu();
    const visible = items.filter(i => !i.separator && !i.hidden);
    if (!visible.length) return;

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    items.forEach(item => {
        if (item.separator) {
            const sep = document.createElement('div');
            sep.className = 'ctx-menu-sep';
            menu.appendChild(sep);
            return;
        }
        if (item.hidden) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ctx-menu-item' + (item.danger ? ' ctx-menu-item-danger' : '');
        btn.innerHTML = (item.icon ? `<span class="ctx-menu-icon">${item.icon}</span>` : '') +
            `<span>${item.label}</span>`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            closeContextMenu();
            item.onClick && item.onClick();
        });
        menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    _el = menu;

    // Clamp to the viewport (menu opens near the cursor, so it should never
    // overflow the window edge).
    const r = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - r.width - 8);
    const top  = Math.min(y, window.innerHeight - r.height - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top  = Math.max(8, top) + 'px';

    // Close on outside mousedown (deferred so the opening right-click's own
    // mousedown — already dispatched — doesn't immediately close it) and Esc.
    _onDocMouseDown = (e) => { if (_el && !_el.contains(e.target)) closeContextMenu(); };
    _onDocKeyDown = (e) => { if (e.key === 'Escape') closeContextMenu(); };
    setTimeout(() => document.addEventListener('mousedown', _onDocMouseDown), 0);
    document.addEventListener('keydown', _onDocKeyDown);
};

// Re-close any open menu when a plugin re-shows one (avoids stacking menus).
export const isContextMenuOpen = () => !!_el;
// === end local plugin ===
