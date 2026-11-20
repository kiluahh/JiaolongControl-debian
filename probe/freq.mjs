#!/usr/bin/env node
/**
 * jlc-freq — 频率上限写入的时间线诊断。
 *
 * 复刻 daemon 的写入方式（fs.writeFileSync），但分别在 0/50/500/2000ms 后回读，
 * 判断"写入被忽略"还是"异步生效"。
 *
 * 用法：sudo node probe/freq.mjs [MHz]   默认 4700
 * 结束时会恢复原值。
 */
import fs from 'node:fs'

const wantMhz = Number(process.argv[2] ?? '4700')
const BASE = '/sys/devices/system/cpu/cpufreq'
const POLICY = `${BASE}/policy0`

const read = (f) => {
  try {
    return fs.readFileSync(`${POLICY}/${f}`, 'utf8').trim()
  } catch (e) {
    return `(${e.code})`
  }
}
const write = (f, v) => {
  try {
    fs.writeFileSync(`${POLICY}/${f}`, String(v))
    return 'ok'
  } catch (e) {
    return e.code ?? e.message
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (process.getuid?.() !== 0) {
  console.error('需要 root')
  process.exit(1)
}

const policies = fs.readdirSync(BASE).filter((d) => d.startsWith('policy'))
console.log(`policy 数量: ${policies.length}`)
console.log(`driver=${read('scaling_driver')} governor=${read('scaling_governor')}`)
console.log(`cpuinfo: ${read('cpuinfo_min_freq')} .. ${read('cpuinfo_max_freq')}`)
console.log(`scaling: ${read('scaling_min_freq')} .. ${read('scaling_max_freq')}`)

const before = Number(read('scaling_max_freq'))
const target = Math.round(wantMhz * 1000)
console.log(`\n原值 ${before} → 目标 ${target}`)

const t0 = Date.now()
console.log(`write → ${write('scaling_max_freq', target)}`)
for (const wait of [0, 50, 250, 1000, 2000]) {
  await sleep(wait)
  const v = read('scaling_max_freq')
  console.log(`  +${String(Date.now() - t0).padStart(5)}ms  scaling_max=${v}${Number(v) === target ? '  ✓' : ''}`)
}

console.log(`\n恢复 → ${write('scaling_max_freq', before)}`)
await sleep(100)
console.log(`恢复后 scaling_max=${read('scaling_max_freq')}`)

// 再检查一次 boost 与会影响上限的其它接口
console.log(`\nboost=${read('../../cpufreq/boost')}`)
console.log(`energy_performance_preference=${read('energy_performance_preference')}`)
console.log(`available epp=${read('energy_performance_available_preferences')}`)
