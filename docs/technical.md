# 技术说明

面向想改代码、换机型或排查硬件问题的读者。普通安装使用见 [README](../README.md)。

## 为什么硬件层要重写

上游 JiaoLongControl 是 Windows 专用（WPF + WebView2 + 内核驱动），它的两条硬件通路在这台机器上都不存在：

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

判断自己的机器是否同一套接口：

```bash
ls /sys/bus/acpi/devices | grep -i inou    # 期望看到 INOU0000:00
ls /proc/acpi/call                          # 期望存在（acpi_call 已加载）
```

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

- **前端一行未改**：`app/preload.cjs` 注入一个形状完全一致的 WebView2 shim，`bridge.CPU.GetCpuUsage().toJson()` 照旧可用。
- **daemon** 是唯一接触硬件的进程，以 root 由 `jlc-daemon.service` 拉起；界面以普通用户身份运行，通过 `jlc` 组访问 socket。
- **OSD** 是外壳里的一个独立置顶透明窗（XWayland），点击穿透、不抢焦点、不进任务栏；Wayland 没有全局按键钩子，所以靠轮询 EC / gsettings 状态变化来触发。

## 已验证的 EC 地址

完整表见 `daemon/ec.mjs` 的 `REG` 常量，主要项：

| 功能 | 地址 | 说明 |
|---|---|---|
| CPU 温度 | `0x043e` | 摄氏度 |
| 风扇转速 | `0x0464/0x0465`、`0x046c/0x046d` | 高字节在前 |
| 性能模式 | `0x0751` bit4 / bit7 + `PMSF()` | 平衡/性能/安静，实机验证指示灯与风扇同步 |
| 风扇全速 | `0x0751` bit6 | 唯一有效的风扇控制位 |
| 键盘背光 | `0x078c` bits[7:5] | 档位 0–4，写入须带 apply 位 `0x10` |
| 键盘 RGB | `0x0769-0x076b` | 通道 0–50，`0x0767` 触发；bit7 = 呼吸 |

协议取自 TUXEDO 的 GPL 驱动并本机实测复核。

### 风扇：为什么只有「自动 / 全速」

本机 EC **不接受按转速写入**，以下三路实测转速都不变：

- `0x1804/0x1809` 占空比（10..200）
- `0x0f20/0x0f50` 自定义风扇表
- 驱动 old-path 时序

只有 `0x0751` bit6 的全速位有效。界面据此只提供开关，按转速写入的接口返回失败。证据脚本：`probe/fan-table.mjs`。

### 其它做不到的事

| 功能 | 原因 |
|---|---|
| GPU 曲线超频 | Linux 没有 NVAPI VF 曲线接口 |
| Caps/Num 锁「切换」 | 需 uinput 注入虚拟键盘，评估后不做，面板改为提示按物理键 |
| Logo 灯 | 寄存器未确认 |
| 逐键 RGB | 需要 ITE HID 设备，本机没有 |

## 开发与调试

```bash
# 依赖：node ≥ 20、acpi-call-dkms、ryzen_smu（可选）
npm --prefix client install && npm --prefix client run build
npm --prefix app install

./run.sh                      # 一键起 daemon（/tmp/jlc.sock）+ 界面
sudo npm test                 # 单元测试（node:test）
```

调试 daemon：

```bash
node daemon/client.mjs CPU GetCpuInfo
node daemon/client.mjs Sys Capabilities
journalctl -u jlc-daemon -e -f
```

只读探针与可回滚的写入实验都在 `probe/` 下，例如：

```bash
node probe/probe.mjs --dry-run        # 环境总览
node probe/fan-table.mjs              # 风扇表写入实验
node probe/tdp.mjs                    # SMU 写入 + RAPL 客观验证
```

## 打包

`packaging/build-deb.sh` 会离线收集前端产物、daemon、Electron 运行时，生成 `dist/jiaolongcontrol_<版本>_amd64.deb`（含 systemd 服务、桌面入口、图标、`jlc` 组初始化）。不需要 electron-builder / fpm。

## 与上游的关系

本仓库跟踪上游 `Linux/X86-64` 分支的思路与界面，但硬件层是独立实现。上游分支对比与合并计划见 [upstream-linux-merge.md](upstream-linux-merge.md)。
