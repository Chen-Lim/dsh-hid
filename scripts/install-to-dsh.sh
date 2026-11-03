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
  rm -rf "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-peripheral-server"
  cp -r "$REPO_ROOT/packages/server" "$HOME/.dsh/profiles/desktop/node_modules/dsh-plugin-peripheral-server"
  rm -rf "$HOME/.dsh/profiles/web/node_modules/dsh-plugin-peripheral-server"
  cp -r "$REPO_ROOT/packages/server" "$HOME/.dsh/profiles/web/node_modules/dsh-plugin-peripheral-server"

  echo "==> Successfully installed into DeepSeek Harness profiles!"
else
  echo "Warning: DeepSeek Harness binary not found at $DSH_BIN"
fi
