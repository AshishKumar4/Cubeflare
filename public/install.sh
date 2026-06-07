#!/bin/sh
set -eu

BASE_URL="${CUBEFLARE_INSTALL_BASE_URL:-}"
CLI_DOWNLOAD_URL="${CUBEFLARE_CLI_DOWNLOAD_URL:-https://raw.githubusercontent.com/AshishKumar4/Cubeflare/main/public/downloads/cubeflare}"
EXPLICIT_INSTALL_DIR=""
PROFILE_UPDATED=""

if [ -n "${CUBEFLARE_INSTALL_DIR:-}" ]; then
  EXPLICIT_INSTALL_DIR="1"
fi

path_has_dir() {
  case ":${PATH:-}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_dir() {
  [ -d "$1" ] || mkdir -p "$1" 2>/dev/null
}

usable_path_dir() {
  path_has_dir "$1" && ensure_dir "$1" && [ -w "$1" ]
}

choose_install_dir() {
  if [ -n "${CUBEFLARE_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$CUBEFLARE_INSTALL_DIR"
    return
  fi

  for dir in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin /opt/homebrew/bin; do
    if usable_path_dir "$dir"; then
      printf '%s\n' "$dir"
      return
    fi
  done

  printf '%s\n' "$HOME/.local/bin"
}

profile_target() {
  if [ -n "${CUBEFLARE_PROFILE:-}" ]; then
    printf '%s\n' "$CUBEFLARE_PROFILE"
    return
  fi

  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh) printf '%s\n' "$HOME/.zshrc" ;;
    bash) printf '%s\n' "$HOME/.bashrc" ;;
    fish)
      mkdir -p "$HOME/.config/fish/conf.d"
      printf '%s\n' "$HOME/.config/fish/conf.d/cubeflare.fish"
      ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

profile_line_for() {
  dir="$1"
  shell_name="$(basename "${SHELL:-sh}")"
  if [ "$shell_name" = "fish" ]; then
    printf 'fish_add_path %s\n' "$dir"
    return
  fi
  case "$dir" in
    "$HOME"/*) printf 'export PATH="$HOME/%s:$PATH"\n' "${dir#"$HOME"/}" ;;
    *) printf 'export PATH="%s:$PATH"\n' "$dir" ;;
  esac
}

shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

ensure_profile_path() {
  dir="$1"
  path_has_dir "$dir" && return
  [ -n "$EXPLICIT_INSTALL_DIR" ] && return
  [ "${CUBEFLARE_UPDATE_PROFILE:-1}" = "0" ] && return

  profile="$(profile_target)"
  line="$(profile_line_for "$dir")"
  mkdir -p "$(dirname "$profile")" 2>/dev/null || return
  touch "$profile" 2>/dev/null || return
  if ! grep -F "$dir" "$profile" >/dev/null 2>&1 && ! grep -F "${dir#"$HOME"/}" "$profile" >/dev/null 2>&1; then
    {
      printf '\n# Cubeflare CLI\n'
      printf '%s\n' "$line"
    } >> "$profile" 2>/dev/null || return
    PROFILE_UPDATED="$profile"
  fi
}

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to install cubeflare." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required to run cubeflare." >&2
  echo "Install Node.js, then rerun this installer." >&2
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20 or newer is required; found $(node -v)." >&2
  exit 1
fi

INSTALL_DIR="$(choose_install_dir)"
BIN="$INSTALL_DIR/cubeflare"
MODULE="$INSTALL_DIR/cubeflare.mjs"

ensure_dir "$INSTALL_DIR"
if [ ! -w "$INSTALL_DIR" ]; then
  echo "Cannot write to $INSTALL_DIR." >&2
  echo "Set CUBEFLARE_INSTALL_DIR to a writable directory or rerun with a writable PATH location." >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
TMP_WRAPPER="$(mktemp)"
trap 'rm -f "$TMP_FILE" "$TMP_WRAPPER"' EXIT

if [ -n "$BASE_URL" ]; then
  DOWNLOAD_URL="$BASE_URL/downloads/cubeflare"
else
  DOWNLOAD_URL="$CLI_DOWNLOAD_URL"
fi

curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"
chmod 0644 "$TMP_FILE"
mv "$TMP_FILE" "$MODULE"
{
  printf '%s\n' '#!/bin/sh'
  printf 'CUBEFLARE_DEFAULT_ORIGIN=${CUBEFLARE_DEFAULT_ORIGIN:-%s} exec node %s "$@"\n' "$(shell_quote "$BASE_URL")" "$(shell_quote "$MODULE")"
} > "$TMP_WRAPPER"
chmod 0755 "$TMP_WRAPPER"
mv "$TMP_WRAPPER" "$BIN"
trap - EXIT

ensure_profile_path "$INSTALL_DIR"

echo "cubeflare installed at $BIN"
if path_has_dir "$INSTALL_DIR"; then
  echo "cubeflare is ready on your PATH."
elif [ -n "$PROFILE_UPDATED" ]; then
  echo "Added $INSTALL_DIR to PATH in $PROFILE_UPDATED."
  echo "Open a new terminal, then run: cubeflare auth"
else
  echo "Add $INSTALL_DIR to PATH to run cubeflare from any directory."
fi

echo ""
echo "Next:"
if path_has_dir "$INSTALL_DIR"; then
  if [ -n "$BASE_URL" ]; then
    echo "  cubeflare auth"
  else
    echo "  cubeflare deploy"
  fi
else
  if [ -n "$BASE_URL" ]; then
    echo "  $BIN auth"
  else
    echo "  $BIN deploy"
  fi
fi
if [ -n "$BASE_URL" ]; then
  echo "  cubeflare connect <server name>"
fi
