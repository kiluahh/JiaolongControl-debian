#!/usr/bin/env bash
# 一键启动：daemon（root，后台）+ 图形界面（前台）
# 用法：./run.sh            正常启动
#       ./run.sh --no-sandbox   Electron 报 SUID sandbox 错误时用
set -euo pipefail
cd "$(dirname "$0")"

SOCK="${JLC_SOCKET:-/tmp/jlc.sock}"
mkdir -p .run

if [[ ! -f client/dist/index.html ]]; then
  echo "==> 构建前端"
  (cd client && npx vite build)
fi

if pgrep -f "daemon/index.mjs" >/dev/null 2>&1; then
  echo "==> 停止旧 daemon"
  sudo pkill -f "daemon/index.mjs" || true
  sleep 0.5
fi

echo "==> 启动 daemon（需要 root，会提示输入一次密码）"
sudo -v
sudo nohup env JLC_CONFIG="$PWD/.run/config.json" JLC_SOCKET="$SOCK" \
  node daemon/index.mjs --socket="$SOCK" --dev >"$PWD/.run/daemon.log" 2>&1 &
sleep 2

if ! pgrep -f "daemon/index.mjs" >/dev/null 2>&1; then
  echo "daemon 启动失败，日志：" >&2
  tail -20 .run/daemon.log >&2
  exit 1
fi
echo "==> daemon 就绪：$SOCK"

echo "==> 启动界面"
JLC_SOCKET="$SOCK" exec ./app/node_modules/.bin/electron app "$@"
