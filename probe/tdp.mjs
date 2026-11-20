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
import {cpuTempC} from '../daemon/hw/sysfs.mjs'

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
    raw.push({w, freq: avgFreqMhz(), temp: cpuTempC()})
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
  }
}

function save(data) {
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2))
  log(`\n证据: ${OUT}`)
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
  log(`限值: 低 ${LOW}W / 高 ${HIGH}W，预热 ${WARMUP_MS / 1000}s，采样 ${SAMPLE_MS / 1000}s\n`)

  const result = {low: LOW, high: HIGH, domain: sampler.domain, phases: {}, at: new Date().toISOString()}
  const restore = restoreValues()
  result.restore = restore
  let stopLoad = null
  let touched = false
  try {
    // ── 空载基线 ──
    log('== 空载基线 ==')
    sampler.sample() // 建立基线
    await sleep(IDLE_MS)
    const idle = sampler.sample()
    result.idleWatts = idle
    log(`   整包功耗 ${idle ?? '?'} W`)

    // ── 低限值 ──
    log(`\n== 阶段 1：限值 ${LOW}W ==`)
    const lowSet = setTdp(LOW)
    touched = true
    for (const r of lowSet) log(`   ${r.key} → ${r.ok ? 'OK' : '失败: ' + r.message}`)
    stopLoad = startLoad()
    log(`   已启动 ${os.cpus().length} 个压测进程，预热中…`)
    await sleep(WARMUP_MS)
    const low = await samplePhase(sampler, stopLoad)
    stopLoad = null
    log(
      `   实测 ${low.wattsAvg} W（峰值 ${low.wattsMax}）  ${low.freqAvgMhz} MHz  ${low.tempAvgC} ℃  [${low.samples} 样本]`,
    )
    result.phases.low = {target: LOW, ...low}

    await sleep(3000) // 让温度/频率回落

    // ── 高限值 ──
    log(`\n== 阶段 2：限值 ${HIGH}W ==`)
    const highSet = setTdp(HIGH)
    for (const r of highSet) log(`   ${r.key} → ${r.ok ? 'OK' : '失败: ' + r.message}`)
    stopLoad = startLoad()
    log('   已启动压测，预热中…')
    await sleep(WARMUP_MS)
    const high = await samplePhase(sampler, stopLoad)
    stopLoad = null
    log(
      `   实测 ${high.wattsAvg} W（峰值 ${high.wattsMax}）  ${high.freqAvgMhz} MHz  ${high.tempAvgC} ℃  [${high.samples} 样本]`,
    )
    result.phases.high = {target: HIGH, ...high}

    // ── 判定 ──
    log('\n== 对比 ==')
    const rows = [
      ['空载', null, null, null],
      [`${LOW}W 设定`, low.wattsAvg, low.freqAvgMhz, low.tempAvgC],
      [`${HIGH}W 设定`, high.wattsAvg, high.freqAvgMhz, high.tempAvgC],
    ]
    log('   阶段        实测功耗   平均频率   温度')
    for (const [label, w, f, t] of rows) {
      log(`   ${String(label).padEnd(10)}  ${String(w ?? '-').padStart(6)}   ${String(f ?? '-').padStart(6)}   ${t ?? '-'}`)
    }

    const delta = low.wattsAvg !== null && high.wattsAvg !== null ? high.wattsAvg - low.wattsAvg : null
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
      log('     → SMU 限值可能只被接受、未真正执行（或该平台由别的寄存器生效）')
      result.conclusion = `差值 ${delta}W，未通过判据`
    }
    save(result)
    process.exit(pass ? 0 : 1)
  } catch (e) {
    console.error(`\n失败: ${e.message}`)
    result.error = e.message
    save(result)
    process.exit(1)
  } finally {
    if (stopLoad) stopLoad()
    if (touched) {
      const restored = setLongShort(restore.long, restore.short)
      const bad = restored.filter((r) => !r.ok)
      log(`\n[restore] 已恢复限值 长 ${restore.long}W / 短 ${restore.short}W（来源: ${restore.source}）`)
      if (bad.length) log(`[restore] 部分失败: ${bad.map((r) => `${r.key}: ${r.message}`).join('; ')}`)
    }
  }
}

main()
