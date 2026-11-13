#!/usr/bin/env bash
# These globals are consumed by the sourced sizing function.
# Overrides are invoked indirectly by ui__menu_size.
# shellcheck disable=SC2034,SC2329
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ui.sh
source "$HERE/lib/ui.sh"
ui__size() { UI_LINES=50; UI_COLS=160; }
ui__menu_size 4
test "$UI_MENU_ROWS" = 4
ui__menu_size 31
test "$UI_MENU_ROWS" = 31
test "$UI_MENU_WIDTH" = 156
ui__size() { UI_LINES=24; UI_COLS=80; }
ui__menu_size 31
test "$UI_MENU_ROWS" = 12
test "$UI_MENU_HEIGHT" = 20
echo 'Menu sizing PASS'
