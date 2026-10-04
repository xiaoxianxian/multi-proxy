#!/bin/bash
# 编译 multi-proxy 原生客户端（AppKit + WKWebView，无 Electron、无依赖）
# 输出：~/Documents/AI项目/multi-proxy/client/build/MultiProxy.app
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
OUT="$SRC/build"
APP="$OUT/MultiProxy.app"
BIN="$APP/Contents/MacOS/MultiProxy"

rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "== 编译 =="
swiftc -O -target "${TARGET:-arm64-apple-macosx12.0}" -o "$BIN" "$SRC/src/main.swift" 2>&1 | tail -20
[ -x "$BIN" ] || { echo "编译失败"; exit 1; }

cp "$SRC/src/Info.plist" "$APP/Contents/Info.plist"
chmod +x "$BIN"

echo "== adhoc 签名（本机无 Developer ID）=="
codesign --force --deep --options runtime -s - "$APP" 2>&1 | tail -3

echo "== 落地 =="
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
echo "产物：$APP"
ls -la "$APP/Contents/MacOS/"
