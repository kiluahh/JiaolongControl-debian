#!/usr/bin/env node
/**
 * jlc-fan-table — 验证「风扇表」手动通路（TUXEDO uniwill_keyboard.h 的 new fancontrol）。
 *
 * 背景：本机一直用 0x1804/0x1809 + 0x0751 bit6 做手动风扇，但实测**完全不随写入值变化**
 * （duty 10 和 duty 200 都是 ~5600 RPM）。查 TUXEDO 驱动源码发现：
 *
 *   0x0751 bit6 (0x40) = full fan mode（全速），不是"手动占空比"
 *   bit6 置位时 uw_set_fan() 什么都不做 → 风扇被钉在全速
 *   真正的转速控制在 bit6 **清零**时，写自定义风扇表的速度端点：
 *     0x07c5 bit7 = CPU 用自定义表
 *     0x07c6 bit2 = 使能 0x0fxx 风扇表
 *     0x0f00 / 0x0f10 / 0x0f20..0x0f2f = CPU 表的 end_temp / start_temp / speed
 *     0x0f30 / 0x0f40 / 0x0f50..0x0f5f = GPU 同上
 *
 * 本探针按驱动原样建表（0..115℃ 一个可控区间，116℃ 以上全部 200 保底），
 * 然后逐档写速度端点并读回 RPM。**所有改动都会在退出时还原**（含 Ctrl-C）。
 *
 * 用法：sudo node probe/fan-table.mjs [--speeds=20,60,120,200] [--settle=6]
 */
import fs from 'node:fs'
import path from 'node:path'

import {Ec, REG} from '../daemon/ec.mjs'

const OUT = path.join(import.meta.dirname, 'fan-table.json')
const argv = process.argv.slice(2)
const argOf = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : dflt
}
const SPEEDS = String(argOf('speeds', '20,60,120,200'))
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0 && n <= 200)
const SETTLE_MS = Number(argOf('settle', '6')) * 1000

// 驱动里的常量
const FULL_FAN_BIT = 0x40 // 0x0751 bit6
const MODE = 0x0751
const TBL_CPU = {end: 0x0f00, start: 0x0f10, speed: 0x0f20}
const TBL_GPU = {end: 0x0f30, start: 0x0f40, speed: 0x0f50}
const TBL_LEN = 0x10
const USE_CUSTOM_0 = 0x07c5 // bit7
const USE_CUSTOM_1 = 0x07c6 // bit2
const FAN_SPEED_MAX = 200

const ec = new Ec()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(s)

function rpm() {
  return {
    cpu: ec.readWord(REG.CPU_RPM_HI, REG.CPU_RPM_LO),
    gpu: ec.readWord(REG.GPU_RPM_HI, REG.GPU_RPM_LO),
    temp: ec.readByte(REG.CPU_TEMP),
    mode: ec.readByte(MODE),
  }
}

/** 读一段 EC RAM */
function dump(addr, len) {
  const out = []
  for (let i = 0; i < len; i++) out.push(ec.readByte(addr + i))
  return out
}

/** 带重试的写（驱动用 3 次） */
function writeRetry(addr, value, tries = 3) {
  let last
  for (let i = 0; i < tries; i++) {
    try {
      ec.writeByte(addr, value)
      return true
    } catch (e) {
      last = e
      sleepMs(5)
    }
  }
  throw last ?? new Error(`写 0x${addr.toString(16)} 失败`)
}

const sleepMs = (ms) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    /* 忙等：探针步骤之间要严格同步，且不需要事件循环 */
  }
}

/** 保存现场 */
function snapshot() {
  return {
    mode: ec.readByte(MODE),
    use0: ec.readByte(USE_CUSTOM_0),
    use1: ec.readByte(USE_CUSTOM_1),
    cpu: dump(TBL_CPU.end, TBL_LEN * 3),
    gpu: dump(TBL_GPU.end, TBL_LEN * 3),
  }
}

/** 还原现场 */
function restore(snap) {
  const put = (addr, bytes) => bytes.forEach((v, i) => writeRetry(addr + i, v))
  put(TBL_CPU.end, snap.cpu)
  put(TBL_GPU.end, snap.gpu)
  writeRetry(USE_CUSTOM_0, snap.use0)
  writeRetry(USE_CUSTOM_1, snap.use1)
  writeRetry(MODE, snap.mode)
}

/** 按驱动 uw_init_fan 建表：一个可控区间 0..115℃，其余区间全是满速保底 */
function initTables(cpuSpeed, gpuSpeed) {
  // 退出 full fan mode
  const mode = ec.readByte(MODE)
  if (mode & FULL_FAN_BIT) writeRetry(MODE, mode & ~FULL_FAN_BIT)

  // 启用自定义表
  const use0 = ec.readByte(USE_CUSTOM_0)
  if (!((use0 >> 7) & 1)) writeRetry(USE_CUSTOM_0, use0 | 0x80)
  const use1 = ec.readByte(USE_CUSTOM_1)
  if (!((use1 >> 2) & 1)) writeRetry(USE_CUSTOM_1, use1 | 0x04)

  // CPU / GPU 第 0 段
  writeRetry(TBL_CPU.end, 115)
  writeRetry(TBL_CPU.start, 0)
  writeRetry(TBL_CPU.speed, cpuSpeed)
  writeRetry(TBL_GPU.end, 120)
  writeRetry(TBL_GPU.start, 0)
  writeRetry(TBL_GPU.speed, gpuSpeed)

  // 第 1..15 段：不可达的高温区间，统一满速保底（防止温度越界后风扇反而停转）
  for (let i = 1; i <= 0xf; i++) {
    writeRetry(TBL_CPU.end + i, 115 + i + 1)
    writeRetry(TBL_CPU.start + i, 115 + i)
    writeRetry(TBL_CPU.speed + i, FAN_SPEED_MAX)
    writeRetry(TBL_GPU.end + i, 115 + i + 1)
    writeRetry(TBL_GPU.start + i, 115 + i)
    writeRetry(TBL_GPU.speed + i, FAN_SPEED_MAX)
  }
}

function setBothSpeeds(v) {
  writeRetry(TBL_CPU.speed, v)
  writeRetry(TBL_GPU.speed, v)
}

const state = {snap: null, restored: false}
function cleanup() {
  if (state.restored) return
  state.restored = true
  try {
    if (state.snap) restore(state.snap)
    log('\n[restore] EC 风扇表 / 模式寄存器已还原为测试前状态')
  } catch (e) {
    log(`\n[restore] 还原失败：${e.message} —— 请重启机器让 EC 重新初始化`)
  }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`\n收到 ${sig}`)
    cleanup()
    process.exit(130)
  })
}

async function main() {
  if (process.getuid?.() !== 0) {
    console.error('需要 root（acpi_call 写 EC）')
    process.exit(1)
  }
  const before = rpm()
  log(`起始：CPU ${before.cpu} / GPU ${before.gpu} RPM，CPU ${before.temp}℃，0x0751=0x${before.mode.toString(16)}`)
  if (before.mode & FULL_FAN_BIT) log('  ⚠ full fan 位（bit6）当前置位 → 风扇被钉在全速')

  const result = {at: new Date().toISOString(), before, steps: [], speeds: SPEEDS}
  state.snap = snapshot()
  result.snapshot = state.snap

  try {
    log('\n== 建表（0..115℃ 可控区间，116℃+ 满速保底）==')
    initTables(SPEEDS[0] ?? 20, SPEEDS[0] ?? 20)
    log('   表已写入，起始速度 ' + (SPEEDS[0] ?? 20) + '/200')

    for (const v of SPEEDS) {
      setBothSpeeds(v)
      log(`\n== 速度端点 ${v}/200（${Math.round((v / FAN_SPEED_MAX) * 100)}%）==`)
      await sleep(SETTLE_MS)
      const now = rpm()
      log(`   CPU ${now.cpu} RPM / GPU ${now.gpu} RPM，CPU ${now.temp}℃`)
      result.steps.push({speed: v, ...now})
    }

    // 判定：不同速度之间 CPU RPM 是否有明显差异
    const bySpeed = result.steps.map((s) => s.cpu)
    const spread = bySpeed.length >= 2 ? Math.max(...bySpeed) - Math.min(...bySpeed) : 0
    result.spread = spread
    result.pass = spread >= 300
    log('\n== 结论 ==')
    if (result.pass) {
      log(`   ✓ 风扇表通路有效：不同端点之间 CPU 转速差 ${spread} RPM`)
      log('     → 手动风扇/曲线应该走 0x0f20 / 0x0f50，而不是 0x1804 + full fan 位')
    } else {
      log(`   ✗ 转速几乎不随端点变化（差 ${spread} RPM）`)
      log('     → 这台机器可能不是「通用 EC 风扇控制」机型，或需要先关掉别的调速通路')
    }
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
    log(`\n证据：${OUT}`)
  } finally {
    cleanup()
  }
}

main()
