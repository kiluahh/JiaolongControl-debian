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

---

## 11. 第一轮探针实测结论（2026-11-20，已推翻原假设）

| 项 | 结果 | 影响 |
|---|---|---|
| ACPI 表 | 23 张全部反编译，`MIFS`/`MiInterface`/`MIFS_0` **零命中** | 上游 WMI 路径在本机**不存在**，全部 Set/Get 方法号作废 |
| `/dev/port` | root 下 open 返回 `EPERM`；`/sys/kernel/security/lockdown` = `[integrity]` | 内核 lockdown 封死用户态端口 I/O，上游 EC 直写（0x4E/0x4F）**永久不可用** |
| WMI 设备 | `PNP0C14:00` = `\_SB.AMW0`（`_UID 1`，1 字节实例透传）、`AOD`（SSDT8，AMD SMU 邮箱） | 与上游 `MIFS_0` 是两代不同接口 |
| **EC 控制接口** | `Device (INOU)`，`_HID "INOU0000"`，提供 `ECRR(addr)` / `ECRW(addr,val)`，EC RAM 映射在 `0xFED50000` | **这是本机唯一可用的控制通路**；属 Uniwill/Tongfang 平台标准接口 |
| NVIDIA | `modprobe nvidia` 后 `nvidia-smi` 正常：RTX 5060 Laptop, 8151 MiB, 590.48.01 | GPU 监控可用，未受 Secure Boot 影响 |

### 结论

1. 硬件层从"复刻 `MiInterface`"改为"用 `acpi_call` 调 `\_SB.INOU.ECRR/ECRW`"。
2. 不需要写内核模块，也不需要 DKMS：`/proc/acpi/call` 不受 lockdown 限制。
3. root 仍然必需（`/proc/acpi/call` 仅 root 可写），架构里的 `jlc-daemon` 保持不变。
4. EC 地址表来自同平台驱动（mechrevo-drivers / TUXEDO uniwill）与本机 DSDT 的 `PL1L..PL4L` 字段，需用第二轮探针实测确认。

### 已知地址（待第二轮验证）

| 地址 | 含义 | 来源 |
|---|---|---|
| 0x043e / 0x044f | CPU / GPU EC 温度 | mechrevo-drivers 实机验证 |
| 0x0464/0x0465、0x046c/0x046d | CPU / GPU 风扇转速高/低字节 | 同上 |
| 0x0740 | 机种 ID | 同上 |
| 0x0727 | 自定义性能档 | uniwill 接口定义 |
| 0x074e | Fn 锁 | 同上 |
| 0x0767 / 0x0769-0x076b | 键盘 RGB 模式 / R,G,B | 同上 |
| 0x078c / 0x078e | 键盘背光状态 / 风扇控制能力位（0x40） | 同上 |
| 0x006a/0x006b/0x006e/0x006f | PL1/PL2/PL3/PL4 | 本机 DSDT `ECXP` 字段 |
| 0x008a/0x008b/0x008f | EC 命令邮箱 LDAT/HDAT/CMDL | 本机 DSDT `WECM` |

## 12. 第二轮验证结果（EC RAM，2026-11-20）

`\_SB.INOU.ECRR` 读取 22 个关键地址 + 4 个窗口，全部成功。

**锚点成立**：`0x043e` = 71，`k10temp` = 71°C，**相差 0°C** → 地址表可信。

| 观测 | 值 | 结论 |
|---|---|---|
| CPU / GPU 温度 | 0x043e=71、0x044f=57 | 与 k10temp / nvidia-smi 一致 |
| CPU 风扇 | 0x0464=12、0x0465=21 → `hi<<8\|lo` = **3093 RPM** | 字节序确定为高字节在前 |
| GPU 风扇 | 0x046c=11、0x046d=162 → 2978 RPM（反向解读得 41483，不合理） | 同上，交叉印证 |
| 0x078e | `0xec`，bit6 置位 | **支持通用风扇控制** |
| 0x0751 | `0xa0` | 性能档/手动风扇控制位（0x80=模式使能，0x40=手动） |
| 0x0741 | `0x04` | 模式使能相关 |
| 0x0767 / 0x078c | `0x80` / `0x80` | 键盘处于彩虹模式 |
| 0x0740 | `0x1a` | 机种 ID 不在社区表（0x09~0x18）内 → **本机是新机种，需自行适配** |
| 0x006a..0x006f | 全 0 | PL1..PL4 不在此 EC 空间 → **TDP 只能走 SMU（AOD WMI 或 ryzen_smu）** |

### 控制寄存器（依据 uniwill/tuxedo 源码，待写入验证）

| 地址 | 用途 | 取值 |
|---|---|---|
| 0x1804 / 0x1809 | CPU / GPU 风扇占空比 | 0..0xC8（200 = 100%） |
| 0x0751 | 模式 + 手动风扇位 | 0x40 = 手动；模式 0xA0/0x00/0x10 |
| 0x07c5 / 0x07c6 | 自定义风扇表使能 | bit7 / bit2 |
| 0x0f20 / 0x0f50 | 自定义风扇表端点 | 占空比 |

### 风险边界

- 风扇写入需 `ECRW`，属真实控制；必须先记录原值、写入后回读、失败立即回滚。
- 0x0751 是模式与手动位复用寄存器，写入必须 **read-modify-write**，不可整字节覆盖。

## 13. 性能档机制（已实机验证，2026-11-20）

DSDT 的 `ECMG` 区域（`OperationRegion (ECMG, SystemMemory, 0xFED50000, 0x1000)`）直接映射 EC RAM，
其中定义了模式字段：

```asl
Offset (0x727), , 6, CUME, 1                                  // 自定义档（白灯）
Offset (0x751), , 4, TBME, 1, , 2, UFME, 1                    // 性能 / 安静

Method (PMSC) {
    If (CUME)                  PMDD = 3   // 自定义
    ElseIf (TBME && !UFME)     PMDD = 2   // 性能
    ElseIf (!TBME && UFME)     PMDD = 0   // 安静
    ElseIf (!TBME && !UFME)    PMDD = 1   // 平衡
}
```

实机结果（写入后回读稳定 2s 以上）：

| 档位 | 写入值 | 指示灯 | 风扇 |
|---|---|---|---|
| 平衡 | `0x0751 = 0x20` | 蓝 | 正常 |
| 性能 | `0x0751 = 0x30` | 紫 | 正常 |
| 安静 | `0x0751 = 0xa0` | 绿 | 明显变安静 |
| 自定义 | `0x0727` bit6 = 1 | 白 | 官方工具专属，界面未做 |

切档流程：**read-modify-write 位 → 调 `\_SB.PCI0.SBRG.EC0.PMSF()`**。
手动风扇位 `0x40` 与模式位可共存，切档时清除。

未完成：`APTC`（温度墙，`0x0783` 低 7 位，理论值 0x57/0x5A/0x5F）始终为 0。
`PMSF` 里这段被 `\_SB.INOU.CSTM == 1` 挡住，调用 `CTAF(1)` 也未能打开——温度墙目前仍由 EC 自管。
