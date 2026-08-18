#!/usr/bin/env bash
# =============================================================================
#  Astucia Wiki Plugins — installer
#  Usage:  bash install.sh <astucia-wiki-root>
#  e.g.    bash install.sh /var/www/astucia-wiki
#          bash install.sh "E:/sites/astucia-wiki"   (Git Bash on Windows)
#
#  What it does
#   1. Backs up every file it touches into <root>/plugins-backup/ (fixed dir,
#      created on first install; idempotent re-runs never pollute it, so
#      uninstall always restores the pre-install originals)
#   2. Copies the 4 plugins into <root>/plugins/
#   3. Tier 1: applies the anchor-based core patches listed in core/install.index
#      (script.js, index.php, api.php, getfile.php, search_index.php,
#       styles.css, the 8 locale files)
#   4. Tier 2: copies the pre-patched replacement files into <root>/modules/...
#      (file_tree, new_items, file_ops, nav, preferences, spaces, core/api.js,
#       core/icons.js, page_edit, json_view — these files contain both the
#       plugin wiring and small bug fixes; base = upstream v2026.7.40)
#
#  Idempotent: running it twice is a no-op (each block guards on a marker).
#  Safe: if an anchor is missing or ambiguous it skips the block with a clear
#  message — nothing is ever applied to the wrong place.
#
#  Uninstall: see uninstall.sh (restores from the backup dir).
# =============================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"          # package root
INDEX="$HERE/core/install.index"
BLOCKS="$HERE/core/blocks"
REPLACE="$HERE/core/replace"

WIKI="${1:-}"
if [ -z "$WIKI" ]; then
  echo "Usage: bash install.sh <astucia-wiki-root>"; exit 1
fi
WIKI="$(cd "$WIKI" 2>/dev/null && pwd)" || { echo "ERROR: cannot access $1"; exit 1; }
for req in index.php api.php script.js styles.css; do
  [ -f "$WIKI/$req" ] || { echo "ERROR: $WIKI does not look like an Astucia Wiki root (missing $req)."; exit 1; }
done

BAK="$WIKI/plugins-backup"
mkdir -p "$BAK"
echo "Backup directory : $BAK"
echo "Wiki root        : $WIKI"
echo

OK=0; SKIP=0; WARN=0

# -----------------------------------------------------------------------------
# Tier 2 — replacement files (copy; keep a backup of the original first)
# -----------------------------------------------------------------------------
echo "── Tier 2: replacement module files ─────────────────────────────"
if [ -d "$REPLACE" ]; then
  while IFS= read -r -d '' f; do
    rel="${f#"$REPLACE"/}"
    tgt="$WIKI/$rel"
    mkdir -p "$(dirname "$tgt")"
    if [ -f "$tgt" ] && cmp -s "$f" "$tgt"; then
      echo "  [skip] $rel  (already up to date)"
      SKIP=$((SKIP+1)); continue
    fi
    if [ -f "$tgt" ]; then
      mkdir -p "$(dirname "$BAK/$rel")"
      cp "$tgt" "$BAK/$rel"
    fi
    cp "$f" "$tgt"
    echo "  [copy] $rel"
    OK=$((OK+1))
  done < <(find "$REPLACE" -type f -print0)
fi
echo

# -----------------------------------------------------------------------------
# Tier 1 — anchor-based core patches
# -----------------------------------------------------------------------------
echo "── Tier 1: anchor-based core patches ─────────────────────────────"
while IFS=$'\t' read -r rel action anchor codefile guard; do
  [ -n "${rel:-}" ] || continue
  case "$rel" in \#*) continue;; esac

  file="$WIKI/$rel"
  code="$BLOCKS/$codefile"
  if [ ! -f "$file" ]; then echo "  [!!] missing target: $rel"; WARN=$((WARN+1)); continue; fi
  if [ ! -f "$code" ]; then echo "  [!!] missing code block: $codefile"; WARN=$((WARN+1)); continue; fi

  # idempotency: guard already present?
  if [ -n "$guard" ] && grep -qF -- "$guard" "$file" 2>/dev/null; then
    echo "  [skip] $rel  (already installed)"
    SKIP=$((SKIP+1)); continue
  fi

  # anchor must be unique (exact-line count — grep -Fc counts substrings, so
  # an indented anchor would false-positive on more-indented lines)
  n=$(A="$anchor" awk 'BEGIN{n=0} $0==ENVIRON["A"]{n++} END{print n+0}' "$file" 2>/dev/null || echo 0)
  if [ "$n" -eq 0 ]; then
    echo "  [!!] $rel : anchor NOT FOUND — upstream version may differ."
    echo "       anchor: $anchor"
    echo "       See core/blocks/$codefile and install manually."
    WARN=$((WARN+1)); continue
  fi
  if [ "$n" -gt 1 ]; then
    echo "  [!!] $rel : anchor is ambiguous ($n matches) — install manually."
    echo "       anchor: $anchor"
    WARN=$((WARN+1)); continue
  fi

  # backup once per file
  if [ ! -e "$BAK/$rel" ]; then
    mkdir -p "$(dirname "$BAK/$rel")"
    cp "$file" "$BAK/$rel"
  fi

  # Pass anchor/code via ENVIRON so awk never re-interprets backslashes/quotes.
  case "$action" in
    insert)
      A="$anchor" C="$code" awk '
        { print; if ($0 == ENVIRON["A"]) { while ((getline l < ENVIRON["C"]) > 0) print l; close(ENVIRON["C"]) } }
      ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
      ;;
    before)
      A="$anchor" C="$code" awk '
        { if ($0 == ENVIRON["A"]) { while ((getline l < ENVIRON["C"]) > 0) print l; close(ENVIRON["C"]) } print }
      ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
      ;;
    replace)
      A="$anchor" C="$code" awk '
        { if ($0 == ENVIRON["A"]) { while ((getline l < ENVIRON["C"]) > 0) print l; close(ENVIRON["C"]) } else print }
      ' "$file" > "$file.tmp" && mv "$file.tmp" "$file"
      ;;
    *)
      echo "  [!!] unknown action $action for $rel"; WARN=$((WARN+1)); continue;;
  esac
  echo "  [ok ] $rel  ($action @ $anchor)"
  OK=$((OK+1))
done < "$INDEX"
echo

# -----------------------------------------------------------------------------
# Tier 0 — plugin directories
# -----------------------------------------------------------------------------
echo "── Tier 0: plugin files ──────────────────────────────────────────"
if [ -d "$HERE/plugins" ]; then
  mkdir -p "$WIKI/plugins"
  cp -r "$HERE/plugins/." "$WIKI/plugins/"
  echo "  [copy] plugins/ -> $WIKI/plugins/"
fi
echo

echo "=============================== DONE ==============================="
echo "  applied: $OK   skipped(already installed): $SKIP   needs-manual: $WARN"
echo "  backup : $BAK"
if [ "$WARN" -gt 0 ]; then
  echo
  echo "  !!! $WARN block(s) need manual installation (see messages above)."
  echo "  Most likely cause: the wiki is not exactly on upstream v2026.7.40."
fi
