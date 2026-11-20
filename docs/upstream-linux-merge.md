# 与上游 Linux 分支（Linux/X86-64）的对比与合并计划

日期：2026-11-20。对比对象：`GaoXanSheng/JiaoLongControl` 的 `Linux/X86-64` 分支（提交 `5640161`，2026-08-26）。

## 1. 两条分支是什么关系

| | 上游 `Linux/X86-64` | 我们的 `debian/amd64` |
|---|---|---|
| 起点 | 从 `599407d`（2026-03-31）拉出 | 从上游 **windows/X86-64**（2026-11-19，比上面新 **175 个提交**）拉出 |
| 客户端 | 2026-03-31 的前端 + 约 10 个 Linux 适配提交 | 2026-11-19 的前端（更新，含 OSD/主题/EditableValue/SparklineCard/通用设置卡） |
| 后端 | 纯 Python 1,074 行（`JiaoLongControl/Server/`）+ `linux-port/` | Node 2,600 行（`daemon/`） |
| 目标机 | 蛟龙16 Pro MRID6（7745HX + RTX 4060，2023 款） | X6DR55xx-B2（8940HX + RTX 5060） |

结论先放这里：**它的客户端比我们旧，后端硬件层在我们机器上不可用；能直接拿的东西很少。**

## 2. 硬件通路：为什么寄存器一行都复用不了

| | 上游 | 本机 |
|---|---|---|
| EC 通路 | `/dev/mem` @ `0xFE800400`（ECF2，256B）+ `/dev/port` 0x4E/0x4F（Blding64） | 两条都被 `lockdown=integrity` 封死（open EPERM）；走 `acpi_call` → `\_SB.INOU.ECRR/ECRW`（EC RAM @ `0xFED50000`） |
| 性能档 | `TFLG 0xD0 = 0x55` → `ITSM 0xE4`（0=性能 1=安静 2=平衡） | `0x0751` bit4=性能 / bit7=安静 + `PMSF()`；枚举值与我们**完全相反** |
| 风扇 | 端口 `0xC83C/0xC83D`（档位 0..68）+ `0xB20=0x0A` | `0x1804/0x1809`（0..200）+ `0x0751` bit6 |
| 键盘 | `LEDM 0xE8` / RGB `0xE9-0xEB` / `KBNL 0x9A` | `0x0767` / `0x0769-6b` / `0x078c`（0..50，需 apply 位 `0x10`） |
| Logo/FnLock/触摸板/显卡模式 | ECF2 `0xE2 bit0`、`0x20 bit3`、`0x25 bit0`、`0xD2` | 无对应寄存器（FnLock 已实测不存在）；触摸板走 gsettings |

实测反证：把它的 ECF2 偏移当 EC RAM 地址读，`0x1C`（温度）=0、`0xD0/0xD1/0xD2`（触发/显卡模式）全是 `0x7B`、`0x9A`（键盘亮度）=0。**两代 EC，地址无交集。**

## 3. 前端对比：几乎没有可搬的

- 上游独有的设置组件（`AdvancedFanControlSystem` / `BootCPUAutoStart` / `BootGPUAutoStart` / `BootCurveOptimizerAllAutoStart` / `FanCurveMerge`）都是**旧版**的每项一张卡；我们已用 `Settings.vue` 的 `toggleCards[] + SettingToggle` 统一覆盖，功能等价。
- `LogoLight.vue` / `GPUDirectConnection.vue` / `PawnIODriverMode.vue` / `ThemeSetting.vue` 两边都有，内容一致（只差格式化）。
- 我们多出来的：`Osd.vue`、`General.vue`、`EditableValue`、`SparklineCard`、`SettingToggle`、`CpuDie`、`useFanCurveEditor`、`useRingBuffer`、`theme/`、`locks` store、10 项导航。
- 上游有而我们没有的 bridge 方法全部是**声明了但页面 0 处调用**的死代码（`Keyboard.GetMode/SetMode`、`Power.GetCPUMaxFrequency/SetCPUMaxState`、`NvidiaGpu.LockGpuClockRange`、`RyzenSmu.SetTdcLimit*`）。
- 唯一值得看的 UI 差异：`RyzenSmu.vue` 的 TDC/EDC 两张遥测卡（但本机没有可靠数据源），以及 `Home.vue` 的「自定义档」（我们的 CUME 寄存器只读）。

## 4. 后端对比：可移植性分级

### A 类：纯 sysfs，可直接搬（这也是我们唯一真正缺的）

| 能力 | 上游实现 | 我们的现状 |
|---|---|---|
| EPP（`energy_performance_preference`） | `cpu_power.py:62-71`，写所有 policy，先查 `available` | **缺失**（本机可写：`default/performance/balance_performance/balance_power/power`） |
| governor（`scaling_governor`） | `cpu_power.py:72-78` | 只读不写（本机 `performance/powersave`） |
| 频率墙复位（写回 `cpuinfo_max_freq`） | `cpu_power.py:47-53` | 无显式端点（`SetCPUMaxFrequency(0)` 可间接复位） |
| 内存条信息（`dmidecode -t 17`） | `system_info.py` | 只有 `MemTotal/MemAvailable` |

### B 类：思路可搬，地址/单位/枚举要换

性能档（枚举相反）、风扇（我们已实测：见 §6）、键盘（量程 255→50）、SMU 命令表（他们是 RSMU 0x56/0x57/0x58，我们是 MP1 0x4F/0x3E/0x5F；**不能照搬**）、配置路径与自启方式。

### C 类：搬不了

`/dev/mem`、`/dev/port`、MIFS mailbox `0xBAEAF000`、Logo 灯、FnLock、显卡模式（MUX）、GPU VF 曲线偏移、TDC/EDC 电流、CPU 电压、HTTP+CLI 架构。

## 5. 上游 README 与实际代码不符的三处（重要）

1. **「GPU 核心频率锁定 ✅」不成立**：`bridge.py:83` 把参数拆成两个 argv（`["--lock-gpu-clocks=", "1500"]`），实测 `ERROR: Option 1500 is not recognized`；`ResetGpuClock` 用 `--lock-gpu-clocks=reset` 也不是合法值。我们今天的实现（`-lgc target,max` + 档位吸附）才真正生效。
2. **「自动风扇：交叉散热 / 温度平滑 / 速率限制 / 共享热管同步」不存在**：`autofan.py` 只有 6 点阶梯曲线 + 2 秒轮询，GPU 曲线还用 CPU 温度。
3. **「解锁 DB」不存在**：全仓库搜不到相关代码。

## 6. 顺带查出的我们自己的问题

| 问题 | 状态 |
|---|---|
| 风扇曲线/手动转速单位不一致（前端 RPM，daemon 当百分比 → 恒满转） | ✅ 已修（`daemon/hw/fan.mjs` + 旧配置迁移，10 个单测） |
| **手动调速在本机完全不生效**（0x1804、0x0f20 风扇表、驱动 old-path 序列三条都试过，转速不变；只有 `0x0751` bit6 全速位有效） | ⏳ 待改界面（见下） |
| `boot.mjs` 的 GPU 分支仍写死「无 NVAPI，跳过」，但 `-lgc/-lmc` 已能落地 | 待修 |
| `GetMaxFanSpeedSwitch` 读的是 `0x078e` 能力位，不是开关状态 | 待修 |
| `SetFanSpeed` 不停止自动风扇（API 直调有竞态） | 待修（若保留手动通路） |
| SMU 缺单位白名单，将来补端点容易重演上游 `85℃→85000` 的错 | 待修 |
| `sysfs.cpuFreqMhz()` 只读 cpu0，空载偏低 | 待修 |
| `cpuInfo().BaseFreqMhz` 实际返回的是最大频率，语义错 | 待修 |

## 7. 合并计划（按价值/成本排序）

1. **风扇页面改成诚实的形态**：只保留「全速风扇」开关（`0x0751` bit6），滑条与曲线编辑器标注「本机 EC 不支持按转速调速」；`Fan.SetFanSpeed` / `AutoFan.Start` 返回明确失败。
2. **CPU 补 EPP + governor**（A 类，80 行）：`Power.GetEpp/SetEpp/GetGovernor/SetGovernor`，按钮接在 CPU 页（可选）。
3. **boot 补 GPU 锁频**：`boot.mjs` 的 GPU 分支改为重放 `GpuClock` / `MemoryClock`。
4. **修 CPU 频率显示**：`cpuFreqMhz()` 改成 32 个 policy 求平均；`BaseFreqMhz` 改名/改语义。
5. **不合并**：整个 Python 后端、EC 寄存器表、SMU 命令表、HTTP/CLI 架构。
