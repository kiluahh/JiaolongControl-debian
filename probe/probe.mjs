#!/usr/bin/env node
/**
 * jlc-probe — JiaoLongControl Debian 移植的只读硬件探针
 *
 * 用法：
 *   node probe/probe.mjs --dry-run          # 不提权，只跑静态检查（自测用）
 *   sudo node probe/probe.mjs               # 完整只读探测
 *   sudo node probe/probe.mjs --skip=acpi,nvidia
 *
 * 纪律：只发 Get(250)，绝不发 Set(251)；不写任何 EC 寄存器；单项失败继续执行。
 * 产物：probe/report.json + probe/report.txt
 */
import fs from 'node:fs'
import path from 'node:path'
import {execFileSync} from 'node:child_process'

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const DRY = flag('dry-run')
const SKIP = new Set(String(value('skip', '')).split(',').filter(Boolean))
const ONLY = new Set(String(value('only', '')).split(',').filter(Boolean))
const want = (sec) => !SKIP.has(sec) && (ONLY.size === 0 || ONLY.has(sec))

const has = (p) => {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}
/** 本机 PATH 不含 /usr/sbin，必须显式解析二进制 */
const resolveBin = (cands) => cands.find(has) ?? cands[cands.length - 1]
const IASL = resolveBin(['/usr/bin/iasl', '/usr/sbin/iasl', 'iasl'])
const ACPIEXEC = resolveBin(['/usr/bin/acpiexec', '/usr/sbin/acpiexec', 'acpiexec'])
const MODPROBE = resolveBin(['/usr/sbin/modprobe', '/sbin/modprobe', 'modprobe'])
const DMESG = resolveBin(['/usr/bin/dmesg', '/bin/dmesg', 'dmesg'])
const SMI = resolveBin(['/usr/bin/nvidia-smi', '/usr/sbin/nvidia-smi', 'nvidia-smi'])

const ROOT = path.resolve(import.meta.dirname, '..')
const WORK = path.join(ROOT, 'probe', '.work')
const OUT_JSON = path.join(ROOT, 'probe', 'report.json')
const OUT_TXT = path.join(ROOT, 'probe', 'report.txt')

const report = {
  schema: 1,
  tool: 'jlc-probe',
  generatedAt: new Date().toISOString(),
  mode: DRY ? 'dry-run' : 'full',
  privileged: process.getuid?.() === 0,
  skip: [...SKIP],
  sections: {},
  verdicts: [],
}

// ── 工具函数 ────────────────────────────────────────────────────────────────
function run(cmd, args = [], opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 15000,
      ...opts,
    })
    return {ok: true, out: String(out).trim()}
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout ?? '').trim(),
      err: String(e.stderr ?? e.message ?? e).trim().split('\n').slice(0, 6).join('\n'),
    }
  }
}

function readText(p, max = 1 << 20) {
  try {
    return fs.readFileSync(p, 'utf8').slice(0, max).trim()
  } catch {
    return null
  }
}

function listDir(p) {
  try {
    return fs.readdirSync(p)
  } catch {
    return []
  }
}

function exists(p) {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

/** 包一层，单项失败也记录成 {error} 而不是中断 */
function section(name, fn) {
  const started = Date.now()
  try {
    report.sections[name] = {ok: true, ms: 0, data: fn()}
  } catch (e) {
    report.sections[name] = {ok: false, error: String(e?.stack ?? e).split('\n').slice(0, 4).join('\n')}
  }
  report.sections[name].ms = Date.now() - started
  const s = report.sections[name]
  process.stderr.write(`[${s.ok ? 'ok  ' : 'FAIL'}] ${name} (${s.ms}ms)\n`)
}

// ── 1. 系统接口清单 ─────────────────────────────────────────────────────────
function hwmonTree() {
  const out = []
  for (const h of listDir('/sys/class/hwmon')) {
    const base = `/sys/class/hwmon/${h}`
    const item = {path: h, name: readText(`${base}/name`)}
    const attrs = {}
    for (const f of listDir(base)) {
      // 只取有数值意义的输入/限制项，避免把 device/ 符号链接等塞进来
      if (!/^(temp|fan|pwm|in|curr|power|energy|freq|voltage)\d*(_\w+)?$/.test(f)) continue
      const v = readText(`${base}/${f}`)
      if (v !== null) attrs[f] = v
    }
    item.attrs = attrs
    out.push(item)
  }
  return out
}

function powerSupply() {
  return listDir('/sys/class/power_supply').map((d) => {
    const base = `/sys/class/power_supply/${d}`
    const want = [
      'type', 'status', 'capacity', 'voltage_now', 'power_now', 'current_now',
      'charge_control_end_threshold', 'charge_control_start_threshold',
      'charge_behaviour', 'cycle_count', 'energy_full', 'energy_now',
    ]
    const fields = {}
    for (const f of want) {
      const v = readText(`${base}/${f}`)
      if (v !== null) fields[f] = v
    }
    return {name: d, fields}
  })
}

function leds() {
  return listDir('/sys/class/leds').map((d) => ({
    name: d,
    brightness: readText(`/sys/class/leds/${d}/brightness`),
    max: readText(`/sys/class/leds/${d}/max_brightness`),
    trigger: readText(`/sys/class/leds/${d}/trigger`)?.slice(0, 120),
  }))
}

function cpufreq() {
  const base = '/sys/devices/system/cpu/cpu0/cpufreq'
  const pick = (f) => readText(`${base}/${f}`)
  return {
    driver: pick('scaling_driver'),
    governor: pick('scaling_governor'),
    availableGovernors: pick('scaling_available_governors'),
    curKHz: pick('scaling_cur_freq'),
    maxKHz: pick('cpuinfo_max_freq'),
    minKHz: pick('cpuinfo_min_freq'),
    amdPstate: exists(`${base}/amd_pstate_status`) ? pick('amd_pstate_status') : null,
  }
}

function thermalZones() {
  return listDir('/sys/class/thermal')
    .filter((d) => d.startsWith('thermal_zone'))
    .map((d) => ({
      name: d,
      type: readText(`/sys/class/thermal/${d}/type`),
      temp: readText(`/sys/class/thermal/${d}/temp`),
    }))
}

function dmesgGrep() {
  const r = run(DMESG, [])
  if (!r.ok) return {ok: false, err: r.err}
  const lines = r.out.split('\n')
  const pat = /(acpi|ec\b|wmi|nvidia|fan|thermal|ryzen)/i
  const hits = lines.filter((l) => pat.test(l))
  const bad = lines.filter((l) => /(acpi error|ae_not_found|fail|timeout|denied)/i.test(l))
  return {ok: true, total: lines.length, relevant: hits.slice(-80), suspicious: bad.slice(-40)}
}

function systemSection() {
  const dmi = {}
  for (const f of ['sys_vendor', 'product_name', 'product_version', 'board_vendor', 'board_name', 'bios_version', 'bios_date']) {
    dmi[f] = readText(`/sys/class/dmi/id/${f}`)
  }
  return {
    osRelease: readText('/etc/os-release'),
    kernel: run('uname', ['-a']).out,
    dmi,
    cpus: {
      model: readText('/proc/cpuinfo')?.match(/model name\s*:\s*(.+)/)?.[1] ?? null,
      count: listDir('/sys/devices/system/cpu').filter((d) => /^cpu\d+$/.test(d)).length,
    },
    modules: (readText('/proc/modules') ?? '')
      .split('\n')
      .map((l) => l.split(' ')[0])
      .filter(Boolean),
    hwmon: hwmonTree(),
    leds: leds(),
    backlight: listDir('/sys/class/backlight').map((d) => ({
      name: d,
      brightness: readText(`/sys/class/backlight/${d}/brightness`),
      max: readText(`/sys/class/backlight/${d}/max_brightness`),
    })),
    powerSupply: powerSupply(),
    platformProfile: readText('/sys/firmware/acpi/platform_profile'),
    platformProfileChoices: readText('/sys/firmware/acpi/platform_profile_choices'),
    cpufreq: cpufreq(),
    thermal: thermalZones(),
    dmesg: DRY ? {ok: false, err: 'dry-run 跳过'} : dmesgGrep(),
  }
}

// ── 2. ACPI 表：找 MiInterface 所在设备路径 ─────────────────────────────────
function copyAcpiTables(dir) {
  fs.mkdirSync(dir, {recursive: true})
  const src = '/sys/firmware/acpi/tables'
  const copied = []
  for (const f of listDir(src)) {
    if (!/^(DSDT|SSDT\d*)$/.test(f)) continue
    try {
      fs.copyFileSync(path.join(src, f), path.join(dir, f))
      copied.push(f)
    } catch (e) {
      copied.push(`${f}:FAILED:${e.code}`)
    }
  }
  return copied
}

/**
 * 在 iasl 反编译出的 .dsl 里定位包含 MiInterface 的 Device，返回它的绝对 ACPI 路径。
 * 做法：逐行扫描，用大括号深度维护 Scope/Device 栈；命中目标时把栈拼成路径。
 */
function findAcpiPath(dslText) {
  const lines = dslText.split('\n')
  const stack = []
  let depth = 0
  const results = []

  const blockRe = /^\s*(Scope|Device|Method|ThermalZone)\s*\(\s*([\\A-Za-z0-9_.^]+)\s*[,)]/

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = line.match(blockRe)
    if (m) {
      stack.push({kind: m[1], name: m[2], depth})
    }
    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    depth += opens

    if (/MiInterface/.test(line) || /MIFS_0/.test(line)) {
      const dev = [...stack].reverse().find((s) => s.kind === 'Device' || s.kind === 'Scope')
      if (dev) {
        const parts = stack
          .filter((s) => s.kind === 'Device' || s.kind === 'Scope')
          .map((s) => s.name.replace(/^\\/, '').replace(/\^+/, ''))
          .filter(Boolean)
        const p = '\\' + parts.join('.')
        results.push({hit: line.trim().slice(0, 120), line: i + 1, path: p, stack: [...stack].map((s) => `${s.kind}:${s.name}`)})
      }
    }

    depth -= closes
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
  }
  return results
}

/**
 * 用 acpiexec 加载全部表并 dump 命名空间，直接拿到 MiInterface 的绝对路径。
 * 比在 .dsl 里用正则拼 Scope 栈可靠得多；失败则退回 findAcpiPath。
 */
function acpiNamespace(dir, copied) {
  const tables = copied.filter((c) => !c.includes('FAILED')).map((c) => path.join(dir, c))
  if (!tables.length) return {ok: false, err: 'no tables'}
  const r = run(ACPIEXEC, ['-b', 'namespace', ...tables], {cwd: dir, timeout: 30000})
  const text = r.out || ''
  if (!text) return {ok: false, err: r.err ?? 'no output'}
  const hits = text.split('\n').filter((l) => /MiInterface|MIFS/i.test(l))
  const methodPaths = []
  for (const l of hits) {
    for (const m of l.matchAll(/\\[A-Za-z0-9_.\\]+/g)) {
      const p = m[0].replace(/\\+$/, '')
      if (/MiInterface$/i.test(p) && !methodPaths.includes(p)) methodPaths.push(p)
    }
  }
  return {ok: true, methodPaths, raw: hits.slice(0, 40)}
}

function acpiSection() {
  const dir = path.join(WORK, 'acpi')
  const copied = copyAcpiTables(dir)
  const iasl = run(IASL, ['-v'])
  const nav = acpiNamespace(dir, copied)
  const data = {
    copied,
    iaslAvailable: iasl.ok,
    iaslVersion: iasl.ok ? iasl.out.split('\n').slice(0, 3).join(' | ') : iasl.err,
    acpiexecAvailable: nav.ok,
    methodPaths: nav.methodPaths ?? [],
    namespaceRaw: nav.raw ?? nav.err,
    decompiled: [],
    rawHits: {},
    paths: [],
    snippets: [],
  }

  // 原始表里的字符串命中（不需要 iasl）
  const raw = {}
  for (const f of copied.filter((c) => !c.includes('FAILED'))) {
    try {
      const buf = fs.readFileSync(path.join(dir, f))
      for (const kw of ['MIFS_0', 'MIFS', 'MiInterface', 'PNP0C14', 'PNP0C09', 'HID_EVENT']) {
        const n = buf.toString('latin1').split(kw).length - 1
        if (n > 0) raw[kw] = (raw[kw] ?? 0) + n
        if (n > 0 && !data.rawTables) data.rawTables = []
        if (n > 0 && !data.rawTables.includes(f)) data.rawTables.push(f)
      }
    } catch {}
  }
  data.rawHits = raw

  if (!iasl.ok) return data

  for (const f of copied.filter((c) => !c.includes('FAILED'))) {
    const r = run(IASL, ['-d', path.join(dir, f)], {cwd: dir})
    const dsl = path.join(dir, `${f}.dsl`)
    data.decompiled.push({table: f, ok: r.ok || exists(dsl), err: r.ok ? null : r.err})
    if (!exists(dsl)) continue
    const text = fs.readFileSync(dsl, 'utf8')
    const hits = findAcpiPath(text)
    if (hits.length) {
      data.paths.push(...hits.map((h) => ({table: f, ...h})))
      // 保留命中点前后 25 行，便于人工核对设备定义
      const lines = text.split('\n')
      for (const h of hits.slice(0, 3)) {
        data.snippets.push({
          table: f,
          line: h.line,
          text: lines.slice(Math.max(0, h.line - 25), h.line + 5).join('\n'),
        })
      }
    }
    // EC 设备（PNP0C09）
    if (/PNP0C09/.test(text)) {
      const i = text.indexOf('PNP0C09')
      data.ecDeviceSnippet = text.split('\n').slice(Math.max(0, text.slice(0, i).split('\n').length - 30), text.slice(0, i).split('\n').length + 3).join('\n')
    }
  }
  return data
}

// ── 3. acpi_call 调 MiInterface（只 Get） ───────────────────────────────────
const MIFS_GETS = [
  [8, 'SystemPerMode', '性能模式 0=平衡 1=性能 2=安静'],
  [9, 'GpuMode', '显卡模式 0=混合 1=独显'],
  [10, 'RgbKeyboardStatus', '键盘 RGB 开关状态'],
  [11, 'FnLock', 'Fn 锁'],
  [12, 'TPLock', '触摸板锁'],
  [13, 'CPUGPUFanSpeed', '双风扇转速 (字节 4..7)'],
  [15, 'Ambientlight', 'logo 灯状态'],
  [17, 'RGBKeyboardColor', '键盘颜色 (字节 4..6)'],
  [18, 'RGBKeyboardBrightness', '键盘亮度 0..3'],
  [19, 'SystemAcType', '供电类型'],
  [20, 'MaxFanSpeedSwitch', '全速风扇开关'],
  [21, 'MaxFanSpeed', '最大风扇转速'],
  [22, 'CPUThermometer', 'EC 温度'],
]

function parseAcpiCallResult(text) {
  const t = String(text).trim()
  const hex = []
  for (const m of t.matchAll(/0x([0-9a-fA-F]{1,2})/g)) hex.push(parseInt(m[1], 16))
  const ints = [...t.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1]))
  return {raw: t.slice(0, 400), hex, ints: hex.length ? hex : ints, error: /error|not found|not supported/i.test(t) ? t : null}
}

function ensureAcpiCall() {
  const pre = {
    procExists: exists('/proc/acpi/call'),
    loaded: (readText('/proc/modules') ?? '').includes('acpi_call'),
    modprobe: null,
    dkms: run('dkms', ['status']).out,
  }
  if (pre.procExists) return pre
  if (DRY) return pre
  pre.modprobe = run(MODPROBE, ['acpi_call'])
  pre.procExists = exists('/proc/acpi/call')
  return pre
}

function callMifs(methodPath, methodId) {
  const buf = Buffer.alloc(32)
  buf[1] = 250 // MethodType.Get
  buf[3] = methodId
  const arg = '{' + [...buf].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', ') + '}'
  try {
    fs.writeFileSync('/proc/acpi/call', `${methodPath} ${arg}`)
  } catch (e) {
    return {cmd: methodPath, error: `write: ${e.code || e.message}`}
  }
  const res = parseAcpiCallResult(readText('/proc/acpi/call') ?? '')
  return {cmd: methodPath, ...res}
}

const FALLBACK_EC_PATHS = [
  '\\_SB.PCI0.LPC0.EC0',
  '\\_SB.PCI0.LPCB.EC0',
  '\\_SB.PCI0.LPC.EC0',
  '\\_SB.PCI0.EC0',
  '\\_SB.EC0',
  '\\_SB.PCI0.SBRG.EC0',
]

/** 把"设备路径"展开成可能的 MiInterface 方法路径 */
function expandDevicePaths(devPaths) {
  const out = []
  for (const d of devPaths) {
    for (const suffix of ['.MiInterface', '.MIFS.MiInterface', '.MIFS_0.MiInterface']) {
      out.push(d + suffix)
    }
  }
  return out
}

function mifsSection(acpiData) {
  const out = {acpiCall: null, triedPaths: [], results: [], decoded: {}}
  if (DRY) {
    out.skipped = 'dry-run'
    return out
  }
  out.acpiCall = ensureAcpiCall()

  const override = value('mifs-path', null)
  const candidates = []
  if (override) candidates.push(/MiInterface$/i.test(override) ? override : `${override}.MiInterface`)
  for (const p of acpiData?.methodPaths ?? []) if (!candidates.includes(p)) candidates.push(p)
  const devPaths = [
    ...(acpiData?.paths ?? []).map((h) => h.path).filter(Boolean),
    ...FALLBACK_EC_PATHS,
  ]
  for (const p of expandDevicePaths([...new Set(devPaths)])) {
    if (!candidates.includes(p)) candidates.push(p)
  }

  // 先用 Get(8) 试探，第一个有响应的路径即锁定
  let chosen = null
  for (const p of candidates) {
    const r = callMifs(p, 8)
    out.triedPaths.push({path: p, ok: !r.error, raw: r.raw ?? null})
    if (!r.error && r.hex.length >= 4) {
      chosen = p
      out.results.push({id: 8, name: 'SystemPerMode', note: MIFS_GETS[0][2], ...r})
      break
    }
  }
  out.chosenPath = chosen
  if (!chosen) return out

  for (const [id, name, note] of MIFS_GETS) {
    if (id === 8) continue
    out.results.push({id, name, note, ...callMifs(chosen, id)})
  }

  // 只做可自证的解码，其余保留原始字节
  const get = (n) => out.results.find((r) => r.name === n)
  const fan = get('CPUGPUFanSpeed')
  if (fan?.hex?.length >= 8) {
    out.decoded.CPUGPUFanSpeed = {
      rawBytes4to7: fan.hex.slice(4, 8),
      // 上游 GetValue<Tuple<int,int>>: item1=(data[5]<<8)+data[4], item2=(data[7]<<8)+data[6]
      a: (fan.hex[5] << 8) + fan.hex[4],
      b: (fan.hex[7] << 8) + fan.hex[6],
      note: 'a/b 的含义待与 FanController 映射核对',
    }
  }
  for (const n of ['SystemPerMode', 'GpuMode', 'Ambientlight', 'RGBKeyboardBrightness', 'SystemAcType', 'MaxFanSpeedSwitch', 'CPUThermometer']) {
    const r = get(n)
    if (r?.hex?.length >= 5) out.decoded[n] = r.hex[4]
  }
  return out
}

// ── 4. EC 端口读（复刻 Blding64 的读路径，不写） ────────────────────────────
const EC_ADDR_PORT = 0x4e
const EC_DATA_PORT = 0x4f

function ecPortSection() {
  const out = {available: exists('/dev/port'), reads: {}, notes: []}
  if (DRY) {
    out.skipped = 'dry-run'
    return out
  }
  let fd
  try {
    fd = fs.openSync('/dev/port', 'r+')
  } catch (e) {
    out.error = `open /dev/port: ${e.code || e.message}`
    return out
  }
  const w = (addr, val) => fs.writeSync(fd, Buffer.from([val & 0xff]), 0, 1, addr)
  const r = (addr) => {
    const b = Buffer.alloc(1)
    fs.readSync(fd, b, 0, 1, addr)
    return b[0]
  }

  // 与 Blding64.EcSelectRegister 完全一致：0x2E/0x11→高字节, 0x2E/0x10→低字节, 0x2E/0x12 提交
  const readEc = (reg) => {
    const hi = (reg >> 8) & 0xff
    const lo = reg & 0xff
    w(EC_ADDR_PORT, 0x2e); w(EC_DATA_PORT, 0x11)
    w(EC_ADDR_PORT, 0x2f); w(EC_DATA_PORT, hi)
    w(EC_ADDR_PORT, 0x2e); w(EC_DATA_PORT, 0x10)
    w(EC_ADDR_PORT, 0x2f); w(EC_DATA_PORT, lo)
    w(EC_ADDR_PORT, 0x2e); w(EC_DATA_PORT, 0x12)
    w(EC_ADDR_PORT, 0x2f)
    return r(EC_DATA_PORT)
  }

  const targets = {
    '0x2000_chipID': 0x2000,
    '0x1060_flag': 0x1060,
    '0x0B20_fan_enable': 0x0b20,
    '0xC83C_cpuFanSet': 0xc83c,
    '0xC83D_gpuFanSet': 0xc83d,
  }
  for (const [k, reg] of Object.entries(targets)) {
    try {
      const v = readEc(reg)
      out.reads[k] = {addr: '0x' + reg.toString(16), value: v, hex: '0x' + v.toString(16).padStart(2, '0')}
    } catch (e) {
      out.reads[k] = {error: String(e.message).slice(0, 120)}
    }
  }

  const chip = out.reads['0x2000_chipID']?.value
  if (chip === 0x55) out.notes.push('chip id 0x55：与上游 EC_init 的判断一致，EC 应答正常')
  else if (chip === 0xff) out.notes.push('chip id 0xFF：端口无应答（可能被 ACPI EC 独占，或该端口在 Linux 下不可直访）')
  else if (chip === 0) out.notes.push('chip id 0x00：读回全 0，可疑')
  else out.notes.push(`chip id 0x${Number(chip).toString(16)}：与上游期望的 0x55 不同，需核对`)

  try {
    fs.closeSync(fd)
  } catch {}
  return out
}

// ── 5. Ryzen SMU ────────────────────────────────────────────────────────────
function smuSection() {
  const base = '/sys/kernel/ryzen_smu_drv'
  const files = listDir(base)
  const data = {present: files.length > 0, files, values: {}, ryzenadj: has('/usr/bin/ryzenadj') || has('/usr/local/bin/ryzenadj')}
  for (const f of files) {
    if (['version', 'smu_version', 'mp1_smu_cmd', 'rsmu_cmd', 'codename', 'bios_if_version'].includes(f)) {
      data.values[f] = readText(`${path.join(base, f)}`)
    }
  }
  data.dmesg = (readText('/var/log/kern.log') ?? '').split('\n').filter((l) => /ryzen_smu/.test(l)).slice(-10)
  return data
}

// ── 6. NVIDIA ───────────────────────────────────────────────────────────────
function gpuSection() {
  const out = {loadedBefore: (readText('/proc/modules') ?? '').includes('nvidia')}
  if (DRY) {
    out.skipped = 'dry-run'
    return out
  }
  if (!out.loadedBefore) out.modprobe = run(MODPROBE, ['nvidia'])
  out.loadedAfter = (readText('/proc/modules') ?? '').includes('nvidia')
  out.procVersion = readText('/proc/driver/nvidia/version')
  const q = [
    'name', 'driver_version', 'memory.total', 'clocks.current.graphics', 'clocks.current.memory',
    'clocks.max.graphics', 'power.draw', 'power.limit', 'temperature.gpu', 'utilization.gpu',
    'fan.speed', 'pstate',
  ]
  const r = run(SMI, [`--query-gpu=${q.join(',')}`, '--format=csv,noheader'])
  out.query = r.ok ? r.out : null
  out.queryError = r.ok ? null : r.err
  const lg = run(SMI, ['-q', '-d', 'SUPPORTED_CLOCKS'])
  out.supportedClocks = lg.ok ? lg.out.split('\n').slice(0, 40).join('\n') : null
  return out
}

// ── 7. 判定汇总 ─────────────────────────────────────────────────────────────
function verdicts() {
  const s = report.sections
  const sys = s.system?.data
  const v = []
  const add = (id, level, title, detail) => v.push({id, level, title, detail})

  const hwmonNames = (sys?.hwmon ?? []).map((h) => h.name)
  const hasCpuTemp = hwmonNames.includes('k10temp') || hwmonNames.includes('zenpower')
  add(
    'metrics.cpu',
    hasCpuTemp ? 'ok' : 'warn',
    'CPU 温度/频率监控',
    hasCpuTemp ? `hwmon: ${hwmonNames.filter((n) => ['k10temp', 'zenpower'].includes(n)).join(',')}；cpufreq driver=${sys?.cpufreq?.driver}` : '未发现 k10temp，需确认',
  )

  const fans = (sys?.hwmon ?? []).some((h) => Object.keys(h.attrs ?? {}).some((k) => k.startsWith('fan')))
  add('metrics.fan', fans ? 'ok' : 'warn', '风扇转速（标准接口）', fans ? 'hwmon 中存在 fan*_input' : '无 hwmon 风扇节点 → 必须走 MiInterface 或 EC')

  const mifs = s.mifs?.data
  const mifsOk = mifs?.chosenPath
  add(
    'control.mifs',
    mifsOk ? 'ok' : 'fail',
    'WMI MiInterface 通路',
    mifsOk
      ? `路径 ${mifsOk}；已读到 ${mifs.results.filter((r) => r.hex?.length).length}/${MIFS_GETS.length} 个方法`
      : DRY ? 'dry-run 未测' : '所有候选路径均失败：详见 sections.mifs.triedPaths',
  )

  const ec = s.ec?.data
  const ecChip = ec?.reads?.['0x2000_chipID']?.value
  add(
    'control.ec',
    ecChip === 0x55 ? 'ok' : ecChip === undefined ? 'warn' : 'warn',
    'EC 端口直读',
    ecChip === undefined ? '无结果' : `chip id = 0x${Number(ecChip).toString(16)}（上游期望 0x55）`,
  )

  const smu = s.smu?.data
  add('control.smu', smu?.present ? 'ok' : 'warn', 'Ryzen SMU', smu?.present ? `ryzen_smu 已加载，版本 ${smu.values?.smu_version ?? '?'}` : 'ryzen_smu 未安装（可后续 DKMS 构建）')

  const gpu = s.gpu?.data
  add('gpu', gpu?.query ? 'ok' : 'warn', 'NVIDIA 监控', gpu?.query ? String(gpu.query).split('\n')[0] : gpu?.modprobe?.err || gpu?.queryError || '未取到')

  report.verdicts = v
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
fs.mkdirSync(WORK, {recursive: true})

// 依赖安装（显式开关，默认不动系统）
if (flag('install') && !DRY) {
  const APT = resolveBin(['/usr/bin/apt-get', '/usr/sbin/apt-get', 'apt-get'])
  section('install', () => {
    const need = []
    if (!has(IASL)) need.push('acpica-tools')
    if (!has('/proc/acpi/call')) need.push('acpi-call-dkms')
    if (!need.length) return {needed: [], note: '依赖已就绪'}
    const r = run(APT, ['install', '-y', ...need], {timeout: 300000})
    const mod = has('/proc/acpi/call') ? null : run(MODPROBE, ['acpi_call'])
    return {needed: need, apt: r, modprobe: mod, acpiCallPresent: has('/proc/acpi/call')}
  })
}

if (want('system')) section('system', systemSection)
const acpiData = want('acpi') && !DRY ? (section('acpi', acpiSection), report.sections.acpi.data) : null
if (want('mifs') && !DRY) section('mifs', () => mifsSection(acpiData))
if (want('ec')) section('ec', ecPortSection)
if (want('smu')) section('smu', smuSection)
if (want('gpu')) section('gpu', gpuSection)

verdicts()

// ── 落盘 ────────────────────────────────────────────────────────────────────
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n')

const ic = {ok: '✅', warn: '⚠️ ', fail: '❌'}
const lines = [
  `JiaoLongControl 探针报告  ${report.generatedAt}  mode=${report.mode}  root=${report.privileged}`,
  '',
  ...report.verdicts.map((v) => `${ic[v.level] ?? '?'} ${v.title}: ${v.detail}`),
  '',
  '── 分组耗时 ──',
  ...Object.entries(report.sections).map(([k, s]) => `  ${s.ok ? 'ok' : 'FAIL'} ${k} ${s.ms}ms${s.error ? ' :: ' + s.error.split('\n')[0] : ''}`),
  '',
  `完整数据: ${OUT_JSON}`,
]
fs.writeFileSync(OUT_TXT, lines.join('\n') + '\n')

process.stdout.write('\n' + lines.join('\n') + '\n')
if (!report.privileged && !DRY) {
  process.stdout.write('\n⚠️  未以 root 运行，ACPI/EC/NVIDIA 部分会失败。请用: sudo node probe/probe.mjs\n')
}
