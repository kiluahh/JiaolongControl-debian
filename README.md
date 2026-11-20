# JiaoLongControl — Debian 版

蛟龙 16 Pro 控制中心的 Linux/Debian 移植。上游是 Windows 专用（WPF + WebView2 + 内核驱动），
本项目保留它的 Vue 前端，重写硬件层与外壳。

目标机：`MECHREVO JIAOLONG Series-X6DR55xx-B2`（Ryzen 9 8940HX + RTX 5060 Mobile），Debian 13 trixie / GNOME Wayland。

## 为什么要重写后端

上游的两条硬件通路在这台机器上都不存在：

| 上游做法 | 本机实际情况 |
|---|---|
| WMI `MiInterface`（`ACPI\PNP0C14\MIFS_0`） | 23 张 ACPI 表里**零命中**，本机固件没有这个接口 |
| 内核驱动直写 EC 端口 `0x4E/0x4F` | 内核 `lockdown=integrity`（Secure Boot）封死 `/dev/port`，`open()` 直接 `EPERM` |

本机真正的接口是 Uniwill/Tongfang 平台标准的 `INOU0000`：

```asl
Device (INOU) {
    Name (_HID, "INOU0000")
    Method (ECRR, 1)  // 读 EC RAM: read8(0xFED50000 + addr)
    Method (ECRW, 2)  // 写 EC RAM
}
```

因此通过 `acpi_call`（`/proc/acpi/call`）即可读写，**不需要内核模块**，也不受 lockdown 影响。

## 架构

```
Vue (client/)  ──window.chrome.webview.hostObjects.bridge──▶  app/ (Electron, 用户身份)
                                                                  │ IPC
                                                                  ▼
                                                        /run/jlc.sock (0660 root:jlc)
                                                                  ▼
                                                     daemon/ (root, systemd)
                                                                  │ ECRR/ECRW · sysfs · nvidia-smi
```

前端**一行未改**：`app/preload.cjs` 注入一个形状完全一致的 WebView2 shim，
`bridge.CPU.GetCpuUsage().toJson()` 照旧可用。

## 快速试跑

一个命令搞定（会提示输入一次 sudo 密码）：

```bash
./run.sh
```

若 Electron 报 SUID sandbox 错误：`./run.sh --no-sandbox`。
停止后台 daemon：`sudo pkill -f daemon/index.mjs`。

正式安装（systemd 服务 + `/opt/jiaolong`）：

```bash
sudo ./install.sh
```

## 功能现状

| 功能 | 状态 | 说明 |
|---|---|---|
| CPU 温度 / 频率 / 占用 / 内存 | ✅ | EC `0x043e` + `k10temp` + `/proc` |
| 风扇转速 | ✅ | EC `0x0464/65`、`0x046c/6d`，高字节在前 |
| 风扇手动 / 曲线 | ✅ | `0x1804`/`0x1809` 占空比 0..200 + `0x0751` bit6；已实机验证 |
| 性能档（平衡/性能/安静） | ✅ | `0x0751` bit4/bit7 + `PMSF()`；实机验证指示灯与风扇同步变化 |
| 键盘 RGB 颜色 | ⚠️ | `0x0769-6b` + `0x0767` bit5，未实测 |
| 键盘背光亮度 | ❌ | 寄存器未确认 |
| logo 灯 | ❌ | 寄存器未确认 |
| GPU 监控 | ✅ | `nvidia-smi` |
| GPU 曲线超频 | ❌ | Linux 无 NVAPI VF 曲线接口 |
| CPU TDP / PBO / CO | ❌ | 需走 SMU（SSDT8 的 `AOD` WMI 或 `ryzen_smu`），未实现 |
| 屏幕 OSD 覆盖层 | ❌ | Wayland 不允许应用自定位窗口 |
| 托盘 | ⚠️ | GNOME 需 AppIndicator 扩展 |

## 目录

```
client/            Vue 前端（来自上游，仅改 vite base 与 outDir）
app/               Electron 外壳 + WebView2 兼容 shim
daemon/            root 守护进程（EC/sysfs/NVIDIA + JSON-RPC）
probe/             只读探针与可回滚写入测试
reference/         上游快照（协议参考，不参与构建）
docs/superpowers/specs/   设计与实测记录
```

## 已验证的 EC 地址

见 `daemon/ec.mjs` 的 `REG` 表，以及 `docs/superpowers/specs/2026-11-20-jiaolong-debian-port-design.md` 第 12 节。
