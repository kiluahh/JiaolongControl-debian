#!/usr/bin/env bash
# 安装 JiaoLongControl Debian 版（需要 root）
set -euo pipefail

PREFIX=/opt/jiaolong

if [[ $EUID -ne 0 ]]; then
  echo "请用 root 运行：sudo ./install.sh" >&2
  exit 1
fi

echo "==> 依赖检查"
for cmd in node; do
  command -v "$cmd" >/dev/null || { echo "缺少 $cmd"; exit 1; }
done
[[ -e /proc/acpi/call ]] || modprobe acpi_call || echo "警告：acpi_call 未加载"

echo "==> 开机自动加载 ryzen_smu"
echo ryzen_smu > /etc/modules-load.d/jiaolong.conf

echo "==> 创建 jlc 组"
getent group jlc >/dev/null || groupadd --system jlc

echo "==> 安装到 $PREFIX"
install -d "$PREFIX/daemon/hw"
install -m 0644 daemon/*.mjs "$PREFIX/daemon/"
install -m 0644 daemon/hw/*.mjs "$PREFIX/daemon/hw/"

echo "==> 安装 systemd 服务"
install -m 0644 daemon/jlc-daemon.service /etc/systemd/system/jlc-daemon.service
systemctl daemon-reload
systemctl enable --now jlc-daemon.service

echo "==> 把 $SUDO_USER 加入 jlc 组（重新登录后生效）"
[[ -n "${SUDO_USER:-}" ]] && usermod -aG jlc "$SUDO_USER"

echo
echo "完成。检查状态：systemctl status jlc-daemon"
echo "调试调用：node daemon/client.mjs CPU GetCpuInfo"
