#!/usr/bin/env bash
# =============================================================================
#  Astucia Wiki Plugins — uninstaller
#  Usage:  bash uninstall.sh <astucia-wiki-root>
#
#  Restores every file touched by install.sh from the newest
#  <root>/plugins-backup/ directory, then removes the 4 plugin
#  directories. If no backup is found it only removes the plugins and tells
#  you which core files were modified (restore them from git manually).
# =============================================================================
set -u

WIKI="${1:-}"
if [ -z "$WIKI" ]; then echo "Usage: bash uninstall.sh <astucia-wiki-root>"; exit 1; fi
WIKI="$(cd "$WIKI" 2>/dev/null && pwd)" || { echo "ERROR: cannot access $1"; exit 1; }

BAK="$WIKI/plugins-backup"
if [ -n "$BAK" ]; then
  echo "Restoring from backup: $BAK"
  while IFS= read -r -d '' f; do
    rel="${f#"$BAK"/}"
    # `[ -f ... ]` must check against $WIKI, NOT the caller's CWD (the script
    # may be run from anywhere). Previously this always failed when the
    # uninstaller was invoked from a different directory -> nothing restored.
    [ -f "$WIKI/$rel" ] || continue
    cp "$f" "$WIKI/$rel" && echo "  [restore] $rel"
  done < <(find "$BAK" -type f -print0)
else
  echo "No backup found. Modified core files were NOT restored; restore them from git:"
  echo "  script.js index.php api.php getfile.php search_index.php styles.css"
  echo "  modules/i18n/locales/*.js"
fi

for p in context_menu sidebar_tab_order tabs tree_drag_move; do
  rm -rf "$WIKI/plugins/$p" && echo "  [remove] plugins/$p"
done
# remove the plugins dir itself if it is now empty
rmdir "$WIKI/plugins" 2>/dev/null && echo "  [remove] plugins/"

echo
echo "Done. Clear your browser cache, then reload the wiki."
echo "Tier-2 replacement files (modules/...) were restored only if a backup"
echo "existed. Verify with: git status"
