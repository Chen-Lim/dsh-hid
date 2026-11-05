#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_BIN="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

echo "==> [1/4] Building all packages and Swift 6 native daemon..."
pnpm --dir "$REPO_ROOT" build

echo "==> [2/4] Packing @dsh-hid/protocol..."
cd "$REPO_ROOT/packages/protocol"
pnpm pack
PROTO_TGZ="$REPO_ROOT/packages/protocol/dsh-hid-protocol-1.0.0.tgz"

echo "==> [3/4] Packing dsh-plugin-peripheral-server..."
cd "$REPO_ROOT/packages/server"
pnpm pack
SERVER_TGZ="$REPO_ROOT/packages/server/dsh-plugin-peripheral-server-1.0.0.tgz"

# Inject local protocol file dependency into server package.json inside tarball
TMP_DIR="$(mktemp -d /tmp/dsh-server-pack-XXXXXX)"
tar -xzf "$SERVER_TGZ" -C "$TMP_DIR"
node -e "
const fs = require('fs');
const pkgPath = '$TMP_DIR/package/package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.dependencies['@dsh-hid/protocol'] = 'file:$PROTO_TGZ';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
"
tar -czf "$SERVER_TGZ" -C "$TMP_DIR" package
rm -rf "$TMP_DIR"

echo "==> [4/4] Installing into DeepSeek Harness desktop & web profiles..."
if [ -x "$DSH_BIN" ]; then
  # Install into desktop profile (used by DeepSeek Harness.app GUI)
  "$DSH_BIN" plugin --profile desktop add "$SERVER_TGZ"
  # Install into web profile (used by dsh web / CLI)
  "$DSH_BIN" plugin --profile web add "$SERVER_TGZ"

  # Sync fresh server files directly into profiles to avoid pnpm tarball cache
  DAEMON_BIN="$REPO_ROOT/packages/daemon/bin/dsh-daemon"
  for PROFILE in desktop web; do
    PLUGIN_DIR="$HOME/.dsh/profiles/$PROFILE/node_modules/dsh-plugin-peripheral-server"
    rm -rf "$PLUGIN_DIR"
    cp -r "$REPO_ROOT/packages/server" "$PLUGIN_DIR"
    # The copied tree keeps the workspace protocol, which a profile cannot resolve.
    node -e "
const fs = require('fs');
const p = '$PLUGIN_DIR/package.json';
const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
pkg.dependencies['@dsh-hid/protocol'] = 'file:$PROTO_TGZ';
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\\n');
"
  done

  # `dsh plugin add` registers the package as a profile bundle, whose own
  # cordis.patch.yml already mounts it once. A second insert with the same id
  # would double-bind the WebSocket port, so the user layer only overrides the
  # config, and only points the plugin at this checkout's compiled daemon —
  # DaemonManager's auto-discovery looks for ~/project/dsh-hid, not this path.
  for PROFILE in desktop web; do
    PATCH_FILE="$HOME/.dsh/profiles/$PROFILE/cordis.patch.yml"
    [ -f "$PATCH_FILE" ] || continue
    node -e "
const fs = require('fs');
const file = '$PATCH_FILE';
const daemon = '$DAEMON_BIN';
let text = fs.readFileSync(file, 'utf8');
if (/id:\s*peripheral-server/.test(text)) process.exit(0);
const block = [
  '# HID peripheral bridge: the bundle mounts this id already; override, do not insert.',
  '- id: peripheral-server',
  '  config:',
  '    port: 45678',
  '    autoBindSlots: true',
  '    autoStartDaemon: true',
  '    daemonPath: \"' + daemon + '\"',
].join('\n');
// A patch layer is a YAML array; an empty \`[]\` placeholder must be replaced, not extended.
text = /^\[\]\s*$/m.test(text)
  ? text.replace(/^\[\]\s*$/m, block)
  : text.trimEnd() + '\n' + block;
fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n');
"
  done

  echo "==> Successfully installed into DeepSeek Harness profiles!"
else
  echo "Warning: DeepSeek Harness binary not found at $DSH_BIN"
fi
