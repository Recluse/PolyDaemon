# shellcheck shell=bash
# ui.sh: the dialog layer. Three backends with one interface:
#   ui_menu  <title> <text> <tag> <item> [<tag> <item>...]  -> prints chosen tag
#   ui_yesno <title> <text>                                 -> exit status
#   ui_msg   <title> <text>
# Every call returns non-zero on Cancel/Esc so callers can `|| return`.
# Backend: PD_UI=auto picks dialog, then whiptail, then a plain bash `select`.

PD_BACKTITLE="${PD_BACKTITLE:-PolyDaemon · $(hostname -s 2>/dev/null)}"

ui_init() {
  case "$PD_UI" in
    auto)
      if command -v dialog >/dev/null 2>&1; then PD_UI=dialog
      elif command -v whiptail >/dev/null 2>&1; then PD_UI=whiptail
      else PD_UI=plain; fi ;;
    dialog|whiptail) command -v "$PD_UI" >/dev/null 2>&1 || pd_die "$PD_UI not installed" ;;
    plain) ;;
    *) pd_die "PD_UI must be auto, dialog, whiptail or plain" ;;
  esac
  # Unicode box lines instead of VT100 line drawing: the latter turns into
  # "qqqq" in some SSH clients (PuTTY, mosh) under a UTF-8 locale.
  export NCURSES_NO_UTF8_ACS=1
  # Bundled colour theme unless the user has their own ~/.dialogrc.
  if [ "$PD_UI" = dialog ] && [ -z "${DIALOGRC:-}" ] && [ ! -f "$HOME/.dialogrc" ] \
     && [ -f "$PD_HOME/theme/dialogrc" ]; then
    export DIALOGRC="$PD_HOME/theme/dialogrc"
  fi
}

# Terminal size, for whiptail which cannot autosize menus.
ui__size() {
  local size
  size=$(stty size 2>/dev/null </dev/tty) || size=''
  if [[ "$size" =~ ^([1-9][0-9]*)[[:space:]]+([1-9][0-9]*)$ ]]; then
    UI_LINES=${BASH_REMATCH[1]}; UI_COLS=${BASH_REMATCH[2]}
  else
    UI_LINES=$(tput lines 2>/dev/null || echo 24)
    UI_COLS=$(tput cols 2>/dev/null || echo 80)
  fi
}

# Reserve space for title, prompt and buttons; do not let dialog guess list height.
ui__menu_size() {
  ui__size
  UI_MENU_WIDTH=$((UI_COLS - 4))
  [ "$UI_MENU_WIDTH" -lt 20 ] && UI_MENU_WIDTH=20
  local capacity=$((UI_LINES - 12))
  [ "$capacity" -lt 1 ] && capacity=1
  UI_MENU_ROWS=$1
  [ "$UI_MENU_ROWS" -gt "$capacity" ] && UI_MENU_ROWS=$capacity
  [ "$UI_MENU_ROWS" -lt 1 ] && UI_MENU_ROWS=1
  UI_MENU_HEIGHT=$((UI_MENU_ROWS + 8))
}

ui_menu() {
  local title=$1 text=$2; shift 2
  local rc out
  case "$PD_UI" in
    dialog)
      ui__menu_size "$(( $# / 2 ))"
      # dialog draws on the terminal and writes the answer to stderr: swap them.
      out=$(dialog --clear --no-tags --colors --backtitle "$PD_BACKTITLE" \
              --title " $title " --cancel-label 'Назад' --ok-label 'Выбрать' \
              --menu "$text" "$UI_MENU_HEIGHT" "$UI_MENU_WIDTH" "$UI_MENU_ROWS" "$@" 3>&1 1>&2 2>&3); rc=$?
      clear >&2 ;;
    whiptail)
      ui__menu_size "$(( $# / 2 ))"
      out=$(whiptail --notags --backtitle "$PD_BACKTITLE" --title "$title" \
              --cancel-button 'Назад' --ok-button 'Выбрать' \
              --menu "$text" "$UI_MENU_HEIGHT" "$UI_MENU_WIDTH" "$UI_MENU_ROWS" "$@" 3>&1 1>&2 2>&3); rc=$?
      clear >&2 ;;
    plain)
      local -a tags=() items=()
      while [ $# -gt 1 ]; do tags+=("$1"); items+=("$2"); shift 2; done
      printf '\n== %s ==\n%s\n' "$title" "$text" >&2
      local i
      for i in "${!items[@]}"; do printf '%3d) %s\n' $((i + 1)) "${items[$i]}" >&2; done
      printf '  q) назад\n> ' >&2
      local ans; read -r ans || return 1
      [ "$ans" = q ] || [ -z "$ans" ] && return 1
      [[ "$ans" =~ ^[0-9]+$ ]] && [ "$ans" -ge 1 ] && [ "$ans" -le ${#tags[@]} ] || return 1
      out=${tags[$((ans - 1))]}; rc=0 ;;
  esac
  [ $rc -eq 0 ] || return 1
  printf %s "$out"
}

ui_yesno() {
  case "$PD_UI" in
    dialog)   dialog --clear --backtitle "$PD_BACKTITLE" --title " $1 " \
                --yes-label 'Да' --no-label 'Нет' --yesno "$2" 0 0; local rc=$?; clear >&2; return $rc ;;
    whiptail) ui__size; whiptail --backtitle "$PD_BACKTITLE" --title "$1" \
                --yes-button 'Да' --no-button 'Нет' --yesno "$2" 12 $((UI_COLS > 90 ? 80 : UI_COLS - 8)) ;;
    plain)    printf '\n%s\n%s [y/N] ' "$1" "$2" >&2; local a; read -r a; [[ "$a" =~ ^[yYдД] ]] ;;
  esac
}

ui_msg() {
  case "$PD_UI" in
    dialog)   dialog --clear --backtitle "$PD_BACKTITLE" --title " $1 " --msgbox "$2" 0 0; clear >&2 ;;
    whiptail) ui__size; whiptail --backtitle "$PD_BACKTITLE" --title "$1" \
                --msgbox "$2" $((UI_LINES > 30 ? 24 : UI_LINES - 4)) $((UI_COLS > 110 ? 100 : UI_COLS - 8)) ;;
    plain)    printf '\n== %s ==\n%s\n[Enter] ' "$1" "$2" >&2; read -r _ ;;
  esac
}

# Short non-blocking notice ("Запускаю…").
ui_info() {
  case "$PD_UI" in
    dialog)   dialog --backtitle "$PD_BACKTITLE" --title " $1 " --infobox "$2" 0 0 ;;
    whiptail) ui__size; TERM=${TERM:-xterm} whiptail --backtitle "$PD_BACKTITLE" --title "$1" \
                --infobox "$2" 8 $((UI_COLS > 90 ? 80 : UI_COLS - 8)) ;;
    plain)    printf '%s: %s\n' "$1" "$2" >&2 ;;
  esac
}
