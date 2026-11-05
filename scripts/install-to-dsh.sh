#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Parse optional arguments
QUICK_MODE=false
for arg in "$@"; do
  case "$arg" in
    --quick|--fast|-q)
      QUICK_MODE=true
      shift
      ;;
  esac
done

# 1. Resolve DSH Home path ($DSH_HOME or default ~/.dsh)
RESOLVED_DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
RESOLVED_DSH_HOME="${RESOLVED_DSH_HOME/#\~/$HOME}"

# 2. Locate dsh CLI binary across known environments
find_dsh_bin() {
  if [ -n "${DSH_BIN:-}" ] && [ -x "$DSH_BIN" ]; then
    echo "$DSH_BIN"
    return 0
  fi
  if command -v dsh >/dev/null 2>&1; then
    command -v dsh
    return 0
  fi
  local CANDIDATES=(
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
    "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
    "$REPO_ROOT/../deepseek-harness/apps/cli/bin/dsh"
    "$HOME/project/deepseek-harness/apps/cli/bin/dsh"
  )
  for candidate in "${CANDIDATES[@]}"; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

RESOLVED_DSH_BIN="$(find_dsh_bin || true)"
DAEMON_BIN="$REPO_ROOT/packages/daemon/bin/dsh-daemon"
PROTO_TGZ="$REPO_ROOT/packages/protocol/dsh-hid-protocol-1.0.0.tgz"
SERVER_TGZ="$REPO_ROOT/packages/server/dsh-plugin-peripheral-server-1.0.0.tgz"

echo "==> [1/4] Building packages and native daemon..."
pnpm --dir "$REPO_ROOT" build

# Check if both desktop & web profiles already have the plugin registered
PROFILES_REGISTERED=true
for PROFILE in desktop web; do
  TARGET_PKG="$RESOLVED_DSH_HOME/profiles/$PROFILE/package.json"
  if [ ! -f "$TARGET_PKG" ] || ! grep -q "dsh-plugin-peripheral-server" "$TARGET_PKG"; then
    PROFILES_REGISTERED=false
    break
  fi
done

if [ "$QUICK_MODE" = true ] && [ "$PROFILES_REGISTERED" = true ]; then
  echo "==> [Quick Mode] Profiles already registered; skipping tarball packaging & dsh plugin add."
else
  echo "==> [2/4] Packing @dsh-hid/protocol..."
  cd "$REPO_ROOT/packages/protocol"
  pnpm pack >/dev/null

  echo "==> [3/4] Packing dsh-plugin-peripheral-server..."
  cd "$REPO_ROOT/packages/server"
  pnpm pack >/dev/null

  # Inject local protocol file dependency into server package.json inside tarball
  TMP_DIR="$(mktemp -d /tmp/dsh-server-pack-XXXXXX)"
  tar -xzf "$SERVER_TGZ" -C "$TMP_DIR"
  node -e "
const fs = require('fs');
const pkgPath = '$TMP_DIR/package/package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies['@dsh-hid/protocol'] = 'file:$PROTO_TGZ';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
"
  tar -czf "$SERVER_TGZ" -C "$TMP_DIR" package
  rm -rf "$TMP_DIR"

  if [ -n "$RESOLVED_DSH_BIN" ]; then
    echo "==> Registering plugin with DeepSeek Harness CLI: $RESOLVED_DSH_BIN"
    "$RESOLVED_DSH_BIN" plugin --profile desktop add "$SERVER_TGZ"
    "$RESOLVED_DSH_BIN" plugin --profile web add "$SERVER_TGZ"
  else
    echo "==> DeepSeek Harness CLI not found; relying on direct profile node_modules sync."
  fi
fi

echo "==> [4/4] Synchronizing runtime files & configuring profile patches..."
for PROFILE in desktop web; do
  PROFILE_DIR="$RESOLVED_DSH_HOME/profiles/$PROFILE"
  PLUGIN_DIR="$PROFILE_DIR/node_modules/dsh-plugin-peripheral-server"

  [ -d "$PROFILE_DIR" ] || continue

  # A. Cleanly sync only distribution and metadata files (exclude dev node_modules, tests, and src)
  mkdir -p "$PLUGIN_DIR"
  rm -rf "$PLUGIN_DIR"/*
  cp -r "$REPO_ROOT/packages/server/dist" "$PLUGIN_DIR/"
  cp -r "$REPO_ROOT/packages/server/locale" "$PLUGIN_DIR/"
  cp "$REPO_ROOT/packages/server/package.json" "$PLUGIN_DIR/"
  cp "$REPO_ROOT/packages/server/cordis.patch.yml" "$PLUGIN_DIR/"
  [ -f "$REPO_ROOT/packages/server/README.md" ] && cp "$REPO_ROOT/packages/server/README.md" "$PLUGIN_DIR/"
  [ -f "$REPO_ROOT/packages/server/README.zh.md" ] && cp "$REPO_ROOT/packages/server/README.zh.md" "$PLUGIN_DIR/"

  # Fix workspace protocol to local file protocol for runtime resolution
  node -e "
const fs = require('fs');
const p = '$PLUGIN_DIR/package.json';
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.dependencies['@dsh-hid/protocol'] = 'file:$PROTO_TGZ';
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
"

  # B. Safely update cordis.patch.yml:
  # - Strip any legacy nested '- insert: ... peripheral-server' entries (which double-bind ports)
  # - Replace or append a clean override block with current daemonPath and options
  PATCH_FILE="$PROFILE_DIR/cordis.patch.yml"
  [ -f "$PATCH_FILE" ] || continue

  node -e "
const fs = require('fs');
const file = '$PATCH_FILE';
const daemon = '$DAEMON_BIN';

let text = fs.readFileSync(file, 'utf8');

const targetBlock = [
  '# HID peripheral bridge: the bundle mounts this id already; override, do not insert.',
  '- id: peripheral-server',
  '  config:',
  '    port: 45678',
  '    autoBindSlots: true',
  '    autoStartDaemon: true',
  '    daemonPath: ' + JSON.stringify(daemon),
].join('\n');

// 1. Remove legacy standalone insert block with peripheral-server
let cleaned = text.replace(
  /(?:^|\n)-\s*insert:\s*\n\s*-\s*id:\s*[\"']?peripheral-server[\"']?[\s\S]*?(?=\n-\s*id:|\n*$)/g,
  ''
);

// 2. Remove existing peripheral-server override block if present
cleaned = cleaned.replace(
  /(?:^|\n)(?:#\s*HID peripheral bridge[^\n]*\n)?-\s*id:\s*[\"']?peripheral-server[\"']?[\s\S]*?(?=\n-\s*id:|\n*$)/g,
  ''
);

cleaned = cleaned.trim();
let result;
if (cleaned === '' || cleaned === '[]') {
  result = targetBlock + '\n';
} else {
  result = cleaned + '\n' + targetBlock + '\n';
}

fs.writeFileSync(file, result);
"
done

echo "==> Successfully installed and configured dsh-plugin-peripheral-server in $RESOLVED_DSH_HOME/profiles"

# Check if DeepSeek Harness is currently running
if pgrep -f "DeepSeek Harness" >/dev/null 2>&1; then
  echo "==> Notice: DeepSeek Harness appears to be running. Please restart the app to load the latest changes."
fi
