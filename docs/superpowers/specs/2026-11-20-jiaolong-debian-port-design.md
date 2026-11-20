# JiaoLongControl Debian 移植 — 设计

日期：2026-11-20
状态：已确认（骨架 + Phase 0 探针）
目标机型：MECHREVO `JIAOLONG Series-X6DR55xx-B2`（Ryzen 9 8940HX + RTX 5060 Mobile），Debian 13 trixie

## 1. 背景

上游 `kiluahh/JiaolongControl-debian` 只有 `windows/X86-64` 一个分支，内容是纯 Windows 程序：

- 外壳：.NET 8 WPF + WebView2（约 1450 行 C#/XAML）
- 硬件层：C# P/Invoke 直写 EC 端口、WMI `MiInterface`、PawnIO(Ryzen SMU)、NVAPI/NVML、CoreAudio（约 6000 行）
- 前端：Vue 3.5 + Vite + Pinia + ECharts + Arco（7149 行，可复用）

本机与上游开发机不同：CPU 是 8940HX（Dragon Range，family 19h model 61h），GPU 是 RTX 5060 Mobile（GB206M），BIOS `N.1.18MRO15`。固件协议是否一致必须实测。

## 2. 目标

把该项目做成能在本机 Debian 13 / GNOME Wayland 上原生运行的控制中心，硬件控制真实可用。

## 3. 非目标

- 不改上游 Windows 版行为，不向上游提 PR
- 不追求与 Windows 版功能逐项对齐：Linux 无 NVAPI VF 曲线接口，GPU 曲线超频/降压做不到
- 不在 Wayland 上复刻"贴屏中央的无边框 OSD 覆盖层"（合成器不允许应用自定位窗口）

## 4. 硬件事实（实测）

| 项 | 结果 |
|---|---|
| DMI | `MECHREVO` / `JIAOLONG Series` / 板号 `JIAOLONG Series-X6DR55xx-B2` / BIOS `N.1.18MRO15` |
| CPU | Ryzen 9 8940HX，16C/32T，family 25(0x19) model 97(0x61) |
| GPU | `01:00.0` GB206M RTX 5060 Mobile（nvidia 590.48.01 已装，模块未加载）+ 核显 Raphael |
| ACPI | `PNP0C14:00`、`PNP0C14:01` 存在；WMI 总线上只有 Microsoft 标准 GUID |
| 风扇 | 无 hwmon 风扇节点，无 lm-sensors |
| EC 控制通路 | 上游走 WMI `MiInterface`（32 字节缓冲，`[1]`=250/251，`[3]`=方法号）；风扇转速直写端口 `0x4E/0x4F` |
| 工具链 | Node 24.22 ✅ / Python 3.13 / dkms 3.4.4 / build-essential / 内核 headers 6.12.117 ✅ / dotnet 无 |
| 提权 | agent shell `NoNewPrivs=1`、`CapEff=0`，无法提权；root 操作必须由用户手动执行 |

## 5. 架构

```
Vue (Client/)  ──window.chrome.webview.hostObjects.bridge──▶  app (Electron, 用户身份)
                                                                  │ preload shim: IPC
                                                                  ▼
                                                        /run/jlc.sock (0660 root:jlc)
                                                                  ▼
                                                     jlc-daemon (root, systemd)
                                                                  │
                                              sysfs / procfs / acpi_call / dev/port / nvidia-smi
```

### 5.1 组件

**`Client/`（Vue，不改）** — 仅依赖 `window.chrome.webview.hostObjects.bridge` 与 `postMessage`。

**`app/`（Electron）**

- 主窗口：无边框，保留 `TitleBar.vue` 的自绘标题栏；`window-drag/minimize/maximize/close` 由 preload 转发
- 托盘：`Tray` + 菜单（显示主界面 / 退出）
- 自启：写 `~/.config/autostart/jiaolong.desktop`
- 通知：`Notification`，替代原 OSD 的提示类消息
- preload：实现 WebView2 兼容 shim（见 5.2）

**`daemon/`（root，纯 Node，无第三方依赖）**

- 唯一接触硬件的地方
- 通过 UNIX socket 提供换行分隔 JSON-RPC 2.0，方法名与 `BridgeApi` 同名同参
- 只监听 `/run/jlc.sock`，不开放 TCP
- 1s 轮询快照 + 按方法缓存 1s/30s（与前端 `bridge.ts` 的 TTL 语义对齐）

**`probe/`（Phase 0 交付物）**

- 只读探针，`sudo node probe/probe.mjs`，产出 `probe/report.json` + `report.txt`

### 5.2 WebView2 兼容 shim

前端 `bridge.ts` 里的形态是：

```ts
const p = window.chrome.webview.hostObjects.bridge.CPU.GetCpuUsage()  // 可 await
JSON.parse(await p.toJson())
```

shim 用 `Proxy` 拦截任意 `Group.Method`，返回一个带 `toJson()` 的 thenable：

```ts
toJson(): Promise<string>  // 内部 ipcRenderer.invoke('bridge', {group, method, args})
```

因此 `bridge.ts` 与全部页面代码零改动。`CommandResult` 的形状仍为
`{ Success: boolean, Message: string, Data?: T }`。

### 5.3 硬件层分工（混合路线）

| 功能 | 通路 |
|---|---|
| 温度、频率、占用、内存 | sysfs（`k10temp`、`cpufreq`、`/proc/stat`、`/proc/meminfo`） |
| 风扇 RPM、性能档、背光、充电阈值 | 优先标准 sysfs（hwmon / platform_profile / led / power_supply）；缺失时回落 daemon 私有通路 |
| logo 灯、RGB 颜色/亮度、FnLock、触摸板锁 | daemon 私有通路（`MiInterface` Get/Set） |
| 自动风扇曲线 | daemon 内 1s 控制环，写风扇占空比 |
| Ryzen SMU（PPT/EDC/Tjmax/CO） | `ryzen_smu` DKMS 暴露的 `/sys/kernel/ryzen_smu_drv` |
| GPU 监控 | `nvidia-smi --query-gpu`；核显走 `amdgpu` hwmon |
| GPU 曲线超频 | 不做 |

## 6. 数据流与错误处理

一次调用：`Vue → bridge.X.Y(args)` → preload → `{group:'X',method:'Y',args}` → socket → daemon → 硬件 → `{Success,Message,Data}` → JSON 字符串 → 前端。

- daemon 单次硬件操作超时 500ms，超时返回 `{Success:false,Message:"timeout"}`
- socket 不可达时 preload 返回 `{Success:false,Message:"jlc-daemon 未运行"}`，前端已有失败分支，不会白屏
- daemon 启动失败（如 EC 不可用）不退出，降级为只读监控，并把能力写进 `GET /capabilities` 等价物（`Sys.Capabilities` 方法）
- 权限：socket 属主 `root:jlc`，模式 `0660`；用户加入 `jlc` 组

## 7. 测试

- `probe/`：`--dry-run` 不接触硬件，可在无 root 下跑，用于验证解析与 JSON 结构；真跑结果作为 Phase 1 的输入事实
- `daemon/`：方法表按 `BridgeApi` 生成契约测试；每个 `hw/*.mjs` 用桩文件系统做单元测试（跑在临时目录的假 sysfs 树）
- `Client/`：沿用现有 `vitest`（`number.spec.ts`）
- 端到端：`app` 以 `--smoke` 启动，加载本地 dist，断言 shim 能拿到 `GetCpuInfo`

## 8. 阶段计划

| 阶段 | 内容 | 出口条件 |
|---|---|---|
| **P0** | 只读探针 | `report.json` 有 7 项结论，且每项附证据 |
| P1 | daemon 骨架 + sysfs 只读方法 + Electron shim，跑通监控页 | 首页 CPU/内存/温度曲线出真实数据 |
| P2 | `MiInterface` Get 全量 + Set（性能模式、RGB、logo、锁） | 设置项能改并能读回 |
| P3 | 风扇曲线 + 自动风扇控制环 | 手动占空比与曲线均生效，可一键恢复自动 |
| P4 | `ryzen_smu` 集成 | PPT/EDC/Tjmax 可读可写，CO 逐核 |
| P5 | 托盘、自启、通知、热键 | 关窗最小化到托盘，开机自启 |

## 9. 风险

| 风险 | 缓解 |
|---|---|
| 本机固件与上游协议不同，`MiInterface` 方法号/长度不一致 | P0 先验证；不一致则按反编译的 DSDT 重建方法表 |
| 写 EC 导致风扇失控或 EC 挂死 | Set 操作只在 P2 之后做，且逐项可回滚；先记录原值再写 |
| Wayland 下无 tray/OSD | 托盘依赖 GNOME 扩展（或降级为通知）；OSD 用系统自带或应用内 toast |
| NVIDIA 模块未加载 | 属独立问题；P0 记录，P1 不阻塞 |
| 用户 sudo 不可用 | 全部 root 步骤由用户手动执行，daemon 以 systemd 服务安装 |

## 10. Phase 0 探针规格

`sudo node probe/probe.mjs [--dry-run] [--skip=acpi,mifs,ec,smu,nvidia]`

| # | 检查 | 判定 |
|---|---|---|
| 1 | DMI / 内核 / 模块 / hwmon / leds / backlight / power_supply / cpufreq / thermal / dmesg | 标准接口清单 |
| 2 | 导出 DSDT+SSDT → `iasl -d` → 定位 `MIFS`/`MiInterface` 绝对路径、EC 设备、`PNP0C09` | WMI 是否可寻址 |
| 3 | `acpi-call-dkms` → 对 `MiInterface` 发 Get(250)：性能模式(8)、GPU 模式(9)、RGB 状态(10)、logo 灯(13)、风扇转速(14)、EC 温度(15) | 真实值是否合理 |
| 4 | `/dev/port` 复刻 EC 读：chip id `0x2000`、`0x1060`、`0xB20`、`0xC83C`、`0xC83D` | EC 直写通路可行性（只读） |
| 5 | `/sys/kernel/ryzen_smu_drv/*`、dmesg | SMU 是否已可用 |
| 6 | `modprobe nvidia` + `nvidia-smi` 关键字段 | GPU 数据源 |
| 7 | 汇总判定表 ✅/⚠️/❌ + 证据 | 直接决定 P1 范围 |

纪律：**只发 Get 不发 Set**；单项失败继续执行；所有命令输出与错误写入报告。
