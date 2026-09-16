#!/bin/bash
# P5 GUI 桌面壳启动脚本
# 用法: ./launch-gui.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 检查 Electron
if [ ! -f "node_modules/electron/dist/Electron.app" ]; then
    echo "⚠️  Electron 未安装，正在安装..."
    ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
    echo "✓ Electron 安装完成"
fi

# 清 quarantine
xattr -r -d com.apple.quarantine node_modules/electron/dist/Electron.app 2>/dev/null || true

# 检查后端
if ! curl -s http://127.0.0.1:18792/ > /dev/null 2>&1; then
    echo "⚠️  后端未运行，正在启动..."
    ./manage.sh manager start
fi

echo "✓ 后端运行中 (http://127.0.0.1:18792)"
echo ""
echo "启动桌面壳..."
echo ""
echo "【注意】如果是第一次运行，macOS 可能弹出"来自身份不明的开发者"警告"
echo "      去 系统设置 → 隐私与安全性 → 安全性 点击"仍要打开""
echo ""
exec node_modules/electron/dist/Electron.app/Contents/MacOS/Electron main.js
