#!/usr/bin/env bash
# 构建 .deb 安装包（离线、可重复，不依赖 electron-builder / fpm）
#
#   ./packaging/build-deb.sh
#
# 产物：dist/jiaolongcontrol_<版本>_amd64.deb
#
# 打包内容：
#   /opt/jiaolongcontrol/{app,client/dist,daemon,electron}
#   /usr/bin/jiaolongcontrol              启动器
#   /usr/lib/systemd/system/jlc-daemon.service
#   /usr/share/applications/jiaolongcontrol.desktop + 图标
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NAME="jiaolongcontrol"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('package.json','utf8')).version" )"
ARCH="amd64"
ELECTRON_DIST="$ROOT/app/node_modules/electron/dist"
OUT="$ROOT/dist"

die() { echo "错误：$*" >&2; exit 1; }

command -v dpkg-deb >/dev/null || die "缺少 dpkg-deb（apt install dpkg）"
[ -x "$ELECTRON_DIST/electron" ] || die "未找到 Electron，请先执行：cd app && npm install"

echo "==> 版本 $VERSION"

if [ ! -f client/dist/index.html ]; then
  echo "==> 构建前端"
  (cd client && npm run build)
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APPDIR="$STAGE/opt/$NAME"
mkdir -p "$APPDIR"/{app,daemon/hw,client/dist,client/src/assets/icon,electron}
mkdir -p "$STAGE/usr/bin" "$STAGE/usr/lib/systemd/system" \
         "$STAGE/usr/share/applications" "$STAGE/usr/share/doc/$NAME" \
         "$STAGE/DEBIAN"

echo "==> 收集应用文件"
for f in main.mjs preload.cjs shim.cjs bridge.mjs shellCalls.mjs osd.mjs osd-core.mjs osd.html package.json; do
  [ -f "app/$f" ] || die "缺少 app/$f"
  install -m 0644 "app/$f" "$APPDIR/app/$f"
done

cp -a client/dist/. "$APPDIR/client/dist/"
install -m 0644 client/src/assets/icon/icon.png "$APPDIR/client/src/assets/icon/icon.png"

for f in daemon/*.mjs; do
  case "$f" in *.test.mjs) continue ;; esac
  install -m 0644 "$f" "$APPDIR/daemon/"
done
for f in daemon/hw/*.mjs; do
  case "$f" in *.test.mjs) continue ;; esac
  install -m 0644 "$f" "$APPDIR/daemon/hw/"
done

echo "==> 收集 Electron（只保留中英文语言包）"
cp -a "$ELECTRON_DIST/." "$APPDIR/electron/"
rm -rf "$APPDIR/electron/locales"
mkdir -p "$APPDIR/electron/locales"
for l in en-US.pak zh-CN.pak; do
  [ -f "$ELECTRON_DIST/locales/$l" ] && cp "$ELECTRON_DIST/locales/$l" "$APPDIR/electron/locales/"
done
# 注意：resources/default_app.asar 必须保留，删掉后 Electron 启动即失败
chmod 0755 "$APPDIR/electron/electron"
# Chromium 的 setuid 沙箱助手：4755 root:root
chmod 4755 "$APPDIR/electron/chrome-sandbox"

echo "==> 启动器与桌面入口"
cat > "$STAGE/usr/bin/jiaolongcontrol" <<'LAUNCHER'
#!/bin/sh
# JiaoLong Control 启动器。硬件后端由 systemd 服务 jlc-daemon 提供。
if [ ! -S /run/jlc.sock ] && [ -d /run/systemd/system ]; then
  systemctl --no-pager --quiet start jlc-daemon.service 2>/dev/null || true
fi
exec /opt/jiaolongcontrol/electron/electron /opt/jiaolongcontrol/app "$@"
LAUNCHER
chmod 0755 "$STAGE/usr/bin/jiaolongcontrol"

install -m 0644 packaging/deb/jlc-daemon.service "$STAGE/usr/lib/systemd/system/jlc-daemon.service"
install -m 0644 packaging/deb/jiaolongcontrol.desktop "$STAGE/usr/share/applications/jiaolongcontrol.desktop"
install -m 0644 packaging/deb/copyright "$STAGE/usr/share/doc/$NAME/copyright"

echo "==> 图标"
ICON_SRC="client/src/assets/icon/icon.png"
for size in 48 64 128 256; do
  dir="$STAGE/usr/share/icons/hicolor/${size}x${size}/apps"
  mkdir -p "$dir"
  ffmpeg -v error -y -i "$ICON_SRC" -vf "scale=${size}:${size}:flags=lanczos" "$dir/$NAME.png"
  chmod 0644 "$dir/$NAME.png"
done

echo "==> 控制文件"
INSTALLED_KB="$(du -sk "$APPDIR" "$STAGE/usr" | awk '{s+=$1} END {print s}')"
sed -e "s/@VERSION@/$VERSION/" -e "s/@ARCH@/$ARCH/" -e "s/@INSTALLED_KB@/$INSTALLED_KB/" \
  packaging/deb/control.in > "$STAGE/DEBIAN/control"

install -m 0755 packaging/deb/postinst "$STAGE/DEBIAN/postinst"
install -m 0755 packaging/deb/prerm "$STAGE/DEBIAN/prerm"
install -m 0755 packaging/deb/postrm "$STAGE/DEBIAN/postrm"

# md5sums
(cd "$STAGE" && find . -path ./DEBIAN -prune -o -type f -print0 |
  sort -z | xargs -0 md5sum | sed 's# \./#  #' > "$STAGE/DEBIAN/md5sums")

echo "==> 打包"
mkdir -p "$OUT"
DEB="$OUT/${NAME}_${VERSION}_${ARCH}.deb"
rm -f "$DEB"
dpkg-deb --build --root-owner-group -Zxz "$STAGE" "$DEB" >/dev/null
echo "完成：$DEB（$(du -h "$DEB" | cut -f1)）"
dpkg-deb --field "$DEB" Package Version Architecture Installed-Size Depends Recommends
