# probe — 只读硬件探针

Phase 0 交付物。它只回答一个问题：**这台机器的 MiInterface / EC / SMU / GPU 在 Linux 下到底能不能用**，
以及每个结论的证据。

## 怎么跑

```bash
# 1) 自测：不提权，只跑静态检查（开发时用，不会碰硬件）
node probe/probe.mjs --dry-run

# 2) 真跑：自动装依赖并探测
sudo node probe/probe.mjs --install

# 3) 真跑：依赖已装好
sudo node probe/probe.mjs

# 可选：跳过某些分组
sudo node probe/probe.mjs --skip=acpi,mifs
```

产出：

- `probe/report.json` — 完整结构化数据
- `probe/report.txt` — 人读摘要
- `probe/.work/acpi/` — 导出的 DSDT/SSDT 与反编译结果（不提交）

## 它会做什么

| # | 分组 | 行为 |
|---|---|---|
| 1 | `system` | 读 `/proc`、`/sys`：DMI、hwmon、leds、backlight、电源、cpufreq、thermal、dmesg |
| 2 | `acpi` | 复制 DSDT/SSDT 到 `.work/acpi`，`acpiexec -b namespace` 取 `MiInterface` 绝对路径，`iasl -d` 反编译留档 |
| 3 | `mifs` | 通过 `acpi_call` 向 `MiInterface` 发 **Get(250)**，共 13 个方法 |
| 4 | `ec` | 用 `/dev/port` 复刻 `Blding64` 的读时序，读 5 个寄存器 |
| 5 | `smu` | 检查 `/sys/kernel/ryzen_smu_drv` |
| 6 | `gpu` | `modprobe nvidia` + `nvidia-smi --query-gpu` |

## 它不会做什么

- **不发 Set(251)**，不写任何 EC 寄存器——风扇、灯光、功耗一个字节都不改
- 不安装 TUXEDO / mechrevo 驱动
- 不写 `config.yaml`，不动你的桌面设置
- 只有加 `--install` 才会 `apt-get install acpica-tools acpi-call-dkms`

## 依赖

- `acpica-tools`：提供 `iasl` / `acpiexec`
- `acpi-call-dkms`：提供 `/proc/acpi/call`，用来从用户态调用 ACPI 方法

两者都通过 DKMS 构建内核模块。本机 Secure Boot 已启用，但 `DKMS Module Signing Key`
已在 MOK 中登记，`/etc/dkms/framework.conf` 也配好了 `mok_signing_key`，因此构建出的
模块会自动签名并可加载——不需要重启去 Enroll MOK。

## 如果失败

每项失败都写进 `report.json` 的 `sections.<name>.error`，不中断后续检查。
常见的三种：

1. `mifs.triedPaths` 全部失败 → 本机 `MiInterface` 路径或参数与上游不同，需要按 `.work/acpi/*.dsl` 重建
2. `ec.reads.0x2000_chipID` 读到 `0xFF` → 端口被 ACPI EC 独占，EC 直写路线走不通，只能走 WMI
3. `gpu.modprobe.err` 提示签名被拒 → Secure Boot 与模块签名不匹配（需要单独处理）
