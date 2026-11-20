#!/usr/bin/env node
/**
 * jlc-tdp — 客观验证 TDP 写入是否真的生效。
 *
 * 背景：daemon 写 SMU（STAPM/Fast/Slow）只拿到 status=1，这是"命令被接受"，
 * 不等于"功耗真的被限制"。本探针用 RAPL 实测整包功耗来做判据：
 *
 *   同一台机器、同一负载（每逻辑核一个死循环）、同一时间窗口，
 *   只改变 SMU 限值（低 / 高两档），比较：
 *     · RAPL package-0 能量差分（真实整包瓦数）
 *     · 平均频率（/sys/.../scaling_cur_freq）
 *     · CPU 温度（k10temp）
 *
 * 判据：高限值阶段实测功耗明显更高（≥8W），且低限值阶段实测功耗
 *       不超过设定值的 1.25 倍（否则说明限值没被真正执行）。
 *
 * 用法：
 *   sudo node probe/tdp.mjs                 # 45W vs 75W
 *   sudo node probe/tdp.mjs --low=35 --high=65
 *
 * 结束后按配置文件里当前 CPU 档位的数值恢复限值（找不到配置就用 55/75）。
 * 压测进程在 finally 里一定杀掉。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawn} from 'node:child_process'

import * as smu from '../daemon/hw/smu.mjs'
import {createPowerSampler} from '../daemon/hw/rapl.mjs'
import {loadConfig} from '../daemon/hw/config.mjs'
import {cpuTempC, cpuUsage} from '../daemon/hw/sysfs.mjs'
import {Ec, REG, MODE_BIT, CUME_BIT} from '../daemon/ec.mjs'

const OUT = path.join(import.meta.dirname, 'tdp.json')
const argv = process.argv.slice(2)
const argNum = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  const v = hit ? Number(hit.slice(name.length + 3)) : NaN
  return Number.isFinite(v) && v > 0 ? v : dflt
}

const LOW = argNum('low', 45)
const HIGH = argNum('high', 75)
const WARMUP_MS = argNum('warmup', 12) * 1000
const SAMPLE_MS = argNum('sample', 10) * 1000
const IDLE_MS = 3000
const PROFILE_KEY = {default: 'Default', performance: 'Performance', saving: 'Saving', custom: 'Custom'}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(s)

// ── SMU 限值 ────────────────────────────────────────────────────────────────
const LIMITS = ['stapmLimit', 'fastLimit', 'slowLimit']

/** 把 STAPM/Fast/Slow 三处限值都设成同一个瓦数，返回每条命令的结果 */
function setTdp(watts) {
  const out = []
  for (const key of LIMITS) {
    const c = smu.CMD[key]
    if (!c) {
      out.push({key, ok: false, message: '命令表里没有该键'})
      continue
    }
    try {
      smu.sendAny(c.mp1, c.rsmu, Math.round(watts * 1000))
      out.push({key, ok: true})
    } catch (e) {
      out.push({key, ok: false, message: e.message})
    }
  }
  return out
}

/** 恢复限值：优先读配置里当前档位的长/短时功耗 */
function restoreValues() {
  try {
    const cfg = loadConfig()
    const key = PROFILE_KEY[cfg?.Cpu?.CpuProfile] ?? 'Default'
    const p = cfg?.Cpu?.[key] ?? cfg?.Cpu?.Default
    const long = Number(p?.CpuLongPower)
    const short = Number(p?.CpuShortPower)
    if (Number.isFinite(long) && Number.isFinite(short) && long > 0 && short > 0) {
      return {long, short, source: `配置 ${cfg.Cpu.CpuProfile ?? 'default'}`}
    }
  } catch {
    /* 读不到配置就退回保守默认值 */
  }
  return {long: 55, short: 75, source: '默认值（未找到配置）'}
}

/** 分别设长/短时限值（STAPM=长、Fast/Slow=短） */
function setLongShort(longW, shortW) {
  const results = []
  const apply = (key, watts) => {
    const c = smu.CMD[key]
    try {
      smu.sendAny(c.mp1, c.rsmu, Math.round(watts * 1000))
      results.push({key, watts, ok: true})
    } catch (e) {
      results.push({key, watts, ok: false, message: e.message})
    }
  }
  apply('stapmLimit', longW)
  apply('fastLimit', shortW)
  apply('slowLimit', shortW)
  return results
}

// ── 频率上限与性能档 ────────────────────────────────────────────────────────
const CPUFREQ = '/sys/devices/system/cpu/cpufreq'

/** 所有 policy 的 scaling_max_freq 与硬件上限（kHz） */
function freqCap() {
  let cur = 0
  let hw = 0
  let policies = 0
  let entries
  try {
    entries = fs.readdirSync(CPUFREQ)
  } catch {
    return {cur: 0, hw: 0, policies: 0}
  }
  for (const entry of entries) {
    if (!/^policy\d+$/.test(entry)) continue
    const c = Number(fs.readFileSync(`${CPUFREQ}/${entry}/scaling_max_freq`, 'utf8').trim())
    const h = Number(fs.readFileSync(`${CPUFREQ}/${entry}/cpuinfo_max_freq`, 'utf8').trim())
    if (Number.isFinite(c)) cur = Math.max(cur, c)
    if (Number.isFinite(h)) hw = Math.max(hw, h)
    policies++
  }
  return {cur, hw, policies}
}

/** 把所有 policy 的 scaling_max_freq 写成同一个值 */
function setMaxFreqAll(khz) {
  const out = []
  for (const entry of fs.readdirSync(CPUFREQ)) {
    if (!/^policy\d+$/.test(entry)) continue
    try {
      fs.writeFileSync(`${CPUFREQ}/${entry}/scaling_max_freq`, String(khz))
      out.push({policy: entry, ok: true})
    } catch (e) {
      out.push({policy: entry, ok: false, message: e.message})
    }
  }
  return out
}

/** EC 里当前性能档（平衡/性能/安静/自定义），只读 */
function readPerfMode(ec) {
  try {
    const m = ec.readByte(REG.MODE)
    const c = ec.readByte(REG.CUME)
    const raw = `0x0751=0x${m.toString(16).padStart(2, '0')} 0x0727=0x${c.toString(16).padStart(2, '0')}`
    if (c & CUME_BIT) return {label: '自定义档', raw}
    if (m & MODE_BIT.TBME) return {label: '性能档', raw}
    if (m & MODE_BIT.UFME) return {label: '安静档', raw}
    return {label: '平衡档', raw}
  } catch (e) {
    return {label: '读不到', raw: e.message}
  }
}

// ── 采样 ────────────────────────────────────────────────────────────────────
function avgFreqMhz() {
  const base = '/sys/devices/system/cpu'
  let sum = 0
  let n = 0
  for (const entry of fs.readdirSync(base)) {
    if (!/^cpu\d+$/.test(entry)) continue
    try {
      const v = Number(fs.readFileSync(path.join(base, entry, 'cpufreq', 'scaling_cur_freq'), 'utf8').trim())
      if (Number.isFinite(v) && v > 0) {
        sum += v / 1000
        n++
      }
    } catch {
      /* 离线核心跳过 */
    }
  }
  return n ? Math.round(sum / n) : null
}

function startLoad(workers = os.cpus().length) {
  const procs = []
  for (let i = 0; i < workers; i++) {
    try {
      // yes 是单线程死循环，stdout 丢到 /dev/null
      procs.push(spawn('yes', [], {stdio: 'ignore'}))
    } catch {
      /* 单个失败不影响其它 */
    }
  }
  return () => {
    for (const p of procs) {
      try {
        p.kill('SIGKILL')
      } catch {}
    }
  }
}

/** 采样一段时间，返回稳态均值（丢掉前 2 个样本） */
async function samplePhase(sampler, stopLoad) {
  const raw = []
  const t0 = Date.now()
  while (Date.now() - t0 < SAMPLE_MS) {
    await sleep(500)
    const w = sampler.sample()
    if (w === null) continue
    raw.push({w, freq: avgFreqMhz(), temp: cpuTempC(), usage: cpuUsage()})
  }
  if (stopLoad) stopLoad()
  const steady = raw.slice(2)
  const avg = (arr, key) => {
    const vals = arr.map((x) => x[key]).filter((v) => Number.isFinite(v))
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }
  return {
    samples: raw.length,
    wattsAvg: avg(steady, 'w') === null ? null : Math.round(avg(steady, 'w') * 10) / 10,
    wattsMax: steady.length ? Math.max(...steady.map((x) => x.w)) : null,
    freqAvgMhz: avg(steady, 'freq') === null ? null : Math.round(avg(steady, 'freq')),
    tempAvgC: avg(steady, 'temp') === null ? null : Math.round(avg(steady, 'temp')),
    usageAvgPct: avg(steady, 'usage') === null ? null : Math.round(avg(steady, 'usage')),
  }
}

function save(data) {
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2))
  log(`\n证据: ${OUT}`)
}

// ── 恢复现场 ────────────────────────────────────────────────────────────────
/**
 * 恢复所需的状态放在模块作用域，由 cleanup() 统一收尾：
 * 原来用 process.exit() 结束，而 process.exit() 直接终止进程、**不会执行 finally**，
 * 于是"临时抬高的频率上限"和"测试用的 SMU 限值"都留在了机器上（实测踩到过一次）。
 * 现在改成设置 process.exitCode 后 return，让 finally 正常跑；
 * 再额外接管 SIGINT/SIGTERM，按 Ctrl-C 也一定恢复。
 */
const state = {stopLoad: null, capBefore: 0, freqRaised: false, limitsTouched: false, restore: null, done: false}

function cleanup() {
  if (state.done) return
  state.done = true
  if (state.stopLoad) {
    try {
      state.stopLoad()
    } catch {
      /* 压测进程可能已经退出 */
    }
    state.stopLoad = null
  }
  if (state.freqRaised) {
    const r = setMaxFreqAll(state.capBefore)
    const bad = r.filter((x) => !x.ok)
    log(`[restore] 频率上限已恢复为 ${state.capBefore} kHz${bad.length ? `（${bad.length} 个失败）` : ''}`)
  }
  if (state.limitsTouched && state.restore) {
    const restored = setLongShort(state.restore.long, state.restore.short)
    const bad = restored.filter((r) => !r.ok)
    log(`\n[restore] 已恢复限值 长 ${state.restore.long}W / 短 ${state.restore.short}W（来源: ${state.restore.source}）`)
    if (bad.length) log(`[restore] 部分失败: ${bad.map((r) => `${r.key}: ${r.message}`).join('; ')}`)
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`\n收到 ${sig}，先恢复现场再退出`)
    cleanup()
    process.exit(130)
  })
}

async function main() {
  if (process.getuid?.() !== 0) {
    console.error('需要 root（RAPL energy_uj 与 SMU 都要 root）：sudo node probe/tdp.mjs')
    process.exit(1)
  }
  if (!smu.available()) {
    console.error('ryzen_smu 模块不可用：sudo modprobe ryzen_smu')
    process.exit(1)
  }
  const sampler = createPowerSampler()
  if (!sampler.available) {
    console.error('找不到 RAPL package 域（/sys/class/powercap）')
    process.exit(1)
  }
  log(`RAPL 域: ${sampler.domain}`)
  log(`SMU: ${JSON.stringify(smu.info())}`)
  log(`限值: 低 ${LOW}W / 高 ${HIGH}W，预热 ${WARMUP_MS / 1000}s，采样 ${SAMPLE_MS / 1000}s`)

  // 性能档与频率上限：这两者都会盖过 SMU 限值，必须先看清楚
  const ec = new Ec()
  const perfMode = readPerfMode(ec)
  log(`EC 性能档: ${perfMode.label}（${perfMode.raw}）`)
  const cap0 = freqCap()
  log(`频率上限: scaling_max_freq=${cap0.cur} kHz / cpuinfo_max_freq=${cap0.hw} kHz`)
  const cappedLow = cap0.cur > 0 && cap0.hw > 0 && cap0.cur < cap0.hw * 0.95
  if (cappedLow) {
    log(`   ⚠ CPU 上限 ${(cap0.cur / 1e6).toFixed(2)} GHz 低于硬件 ${(cap0.hw / 1e6).toFixed(2)} GHz：`)
    log('     高限值阶段的功耗可能被频率上限先压住，测不出真实差值')
    log(`     本次临时抬到硬件上限 ${(cap0.hw / 1e6).toFixed(2)} GHz，结束恢复`)
  }
  log('')

  const result = {low: LOW, high: HIGH, domain: sampler.domain, phases: {}, at: new Date().toISOString()}
  result.perfMode = perfMode
  result.freqCapBefore = cap0
  const restore = restoreValues()
  result.restore = restore
  state.capBefore = cap0.cur
  state.restore = restore
  try {
    if (cappedLow) {
      const r = setMaxFreqAll(cap0.hw)
      const bad = r.filter((x) => !x.ok)
      state.freqRaised = bad.length === 0
      log(`[freq] 已把 ${r.length} 个 policy 的上限抬到 ${cap0.hw} kHz${bad.length ? `（${bad.length} 个失败）` : ''}`)
    }
    // ── 空载基线 ──
    // 刚跑完压测/刚抬过频率时测一次会明显偏高（实测 57W vs 稳态 26W），
    // 所以取 3 个 1 秒窗口的最小值，代表真正的空闲底噪。
    log('== 空载基线 ==')
    sampler.sample() // 建立基线
    await sleep(IDLE_MS)
    let idle = null
    for (let i = 0; i < 3; i++) {
      const w = sampler.sample()
      if (w !== null && (idle === null || w < idle)) idle = w
      await sleep(1000)
    }
    result.idleWatts = idle
    log(`   整包功耗 ${idle ?? '?'} W（取 3 秒窗口最小值；当前 CPU 占用 ${cpuUsage() ?? '?'}%）`)

    // ── 低限值 ──
    log(`\n== 阶段 1：限值 ${LOW}W ==`)
    const lowSet = setTdp(LOW)
    state.limitsTouched = true
    for (const r of lowSet) log(`   ${r.key} → ${r.ok ? 'OK' : '失败: ' + r.message}`)
    state.stopLoad = startLoad()
    log(`   已启动 ${os.cpus().length} 个压测进程，预热中…`)
    await sleep(WARMUP_MS)
    const low = await samplePhase(sampler, state.stopLoad)
    state.stopLoad = null
    log(
      `   实测 ${low.wattsAvg} W（峰值 ${low.wattsMax}）  ${low.freqAvgMhz} MHz  ${low.tempAvgC} ℃  CPU ${low.usageAvgPct}%  [${low.samples} 样本]`,
    )
    result.phases.low = {target: LOW, ...low}

    await sleep(3000) // 让温度/频率回落

    // ── 高限值 ──
    log(`\n== 阶段 2：限值 ${HIGH}W ==`)
    const highSet = setTdp(HIGH)
    for (const r of highSet) log(`   ${r.key} → ${r.ok ? 'OK' : '失败: ' + r.message}`)
    state.stopLoad = startLoad()
    log('   已启动压测，预热中…')
    await sleep(WARMUP_MS)
    const high = await samplePhase(sampler, state.stopLoad)
    state.stopLoad = null
    log(
      `   实测 ${high.wattsAvg} W（峰值 ${high.wattsMax}）  ${high.freqAvgMhz} MHz  ${high.tempAvgC} ℃  CPU ${high.usageAvgPct}%  [${high.samples} 样本]`,
    )
    result.phases.high = {target: HIGH, ...high}

    // ── 判定 ──
    log('\n== 对比 ==')
    const rows = [
      ['空载', idle, null, null],
      [`${LOW}W 设定`, low.wattsAvg, low.freqAvgMhz, low.tempAvgC],
      [`${HIGH}W 设定`, high.wattsAvg, high.freqAvgMhz, high.tempAvgC],
    ]
    log('   阶段        实测功耗   平均频率   温度')
    for (const [label, w, f, t] of rows) {
      log(`   ${String(label).padEnd(10)}  ${String(w ?? '-').padStart(6)}   ${String(f ?? '-').padStart(6)}   ${t ?? '-'}`)
    }

    const rawDelta = low.wattsAvg !== null && high.wattsAvg !== null ? high.wattsAvg - low.wattsAvg : null
    const delta = rawDelta === null ? null : Math.round(rawDelta * 10) / 10
    const lowWithin = low.wattsAvg !== null ? low.wattsAvg <= LOW * 1.25 : false
    const pass = delta !== null && delta >= 8 && lowWithin
    result.delta = delta
    result.lowWithinLimit = lowWithin
    result.pass = pass

    log('\n== 结论 ==')
    if (pass) {
      log(`   ✓ TDP 生效：高限值比低限值实测多 ${delta} W，且低限值阶段未超出设定值 25%`)
      log(`     频率 ${low.freqAvgMhz} → ${high.freqAvgMhz} MHz，温度 ${low.tempAvgC} → ${high.tempAvgC} ℃`)
      result.conclusion = `TDP 生效，实测差值 ${delta}W`
    } else if (delta === null) {
      log('   ✗ 采样不足，无法判定')
      result.conclusion = '采样不足'
    } else {
      log(`   ✗ 判定不成立：实测差值 ${delta} W，低限值阶段 ${low.wattsAvg} W（设定 ${LOW}W）`)
      log('     排查顺序：')
      log(`       1. EC 性能档=${perfMode.label}：平衡/安静档可能由固件限死，切到"性能"再测`)
      log(`       2. 频率上限=${(cap0.cur / 1e6).toFixed(2)} GHz（硬件 ${(cap0.hw / 1e6).toFixed(2)} GHz）：限频时 TDP 永远不成为瓶颈`)
      log('       3. 若两者都正常仍无差值 → STAPM/Fast/Slow 只是被 SMU 接受未执行，需换寄存器')
      result.conclusion = `差值 ${delta}W，未通过判据`
    }
    save(result)
    process.exitCode = pass ? 0 : 1
  } catch (e) {
    console.error(`\n失败: ${e.message}`)
    result.error = e.message
    save(result)
    process.exitCode = 1
  } finally {
    cleanup()
  }
}

main()
