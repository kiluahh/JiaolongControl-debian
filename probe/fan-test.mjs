#!/usr/bin/env node
/**
 * jlc-fan-test — 受控的风扇写入验证（可回滚）
 *
 * 目的：验证 0x0751 的 manual 位 + 0x1804/0x1809 占空比写入是否真的能改变转速。
 *
 * 步骤：
 *   1. 记录原值：0x0751、0x1804、0x1809、双风扇 RPM、双路温度
 *   2. 置 0x0751 bit6（full/manual fan mode）
 *   3. 写 0x1804/0x1809 = duty（默认 150 / 200 = 75%）
 *   4. 3 秒内每 500ms 采样 RPM
 *   5. finally：写回 0x1804/0x1809 原值，写回 0x0751 原值
 *   6. 再采样 3 秒，确认转速回落
 *
 * 用法：
 *   node probe/fan-test.mjs                 # 只打印计划，不动硬件
 *   sudo node probe/fan-test.mjs --apply    # 真正执行
 *   sudo node probe/fan-test.mjs --apply --duty=200
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const value = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}
const APPLY = flag('apply')
const DUTY = Math.max(0, Math.min(200, Number(value('duty', '150'))))

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT_JSON = path.join(ROOT, 'probe', 'fan-test.json')
const OUT_TXT = path.join(ROOT, 'probe', 'fan-test.txt')
const CALL = '/proc/acpi/call'
const READ = '\\_SB.INOU.ECRR'
const WRITE = '\\_SB.INOU.ECRW'

const REG = {
  MODE: 0x0751,
  FAN_CTRL_STATUS: 0x078e,
  DUTY_CPU: 0x1804,
  DUTY_GPU: 0x1809,
  RPM_CPU_HI: 0x0464,
  RPM_CPU_LO: 0x0465,
  RPM_GPU_HI: 0x046c,
  RPM_GPU_LO: 0x046d,
  TEMP_CPU: 0x043e,
  TEMP_GPU: 0x044f,
}

let saved = null
let rolledBack = false

const log = []
const rec = (s) => {
  log.push(`[${new Date().toISOString().slice(11, 23)}] ${s}`)
  process.stderr.write(s + '\n')
}

function ecRead(addr) {
  fs.writeFileSync(CALL, `${READ} 0x${addr.toString(16)}`)
  const t = fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
  const m = t.match(/^0x([0-9a-fA-F]+)$/)
  if (!m) throw new Error(`ECRR 0x${addr.toString(16)} 返回异常: ${JSON.stringify(t)}`)
  return parseInt(m[1], 16)
}

function ecWrite(addr, val) {
  fs.writeFileSync(CALL, `${WRITE} 0x${addr.toString(16)} 0x${(val & 0xff).toString(16)}`)
}

/** 同步回滚：任何退出路径（正常/异常/Ctrl-C）都必须调用 */
function rollbackSync(reason) {
  if (!saved || rolledBack) return
  rolledBack = true
  const p = []
  try {
    ecWrite(REG.MODE, saved.mode) // 先交回 EC 自动控制
  } catch (e) {
    p.push(`mode: ${e.message}`)
  }
  try {
    ecWrite(REG.DUTY_CPU, saved.dutyCpu)
    ecWrite(REG.DUTY_GPU, saved.dutyGpu)
  } catch (e) {
    p.push(`duty: ${e.message}`)
  }
  rec(p.length ? `⚠️ 回滚部分失败 ${p.join('; ')}` : `已回滚到原值（${reason}）`)
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    rollbackSync(`收到 ${sig}`)
    process.exit(130)
  })
}

function snapshot() {
  const rpm = (hi, lo) => (ecRead(hi) << 8) | ecRead(lo)
  return {
    at: new Date().toISOString(),
    cpuRpm: rpm(REG.RPM_CPU_HI, REG.RPM_CPU_LO),
    gpuRpm: rpm(REG.RPM_GPU_HI, REG.RPM_GPU_LO),
    cpuTemp: ecRead(REG.TEMP_CPU),
    gpuTemp: ecRead(REG.TEMP_GPU),
    mode: ecRead(REG.MODE),
    dutyCpu: ecRead(REG.DUTY_CPU),
    dutyGpu: ecRead(REG.DUTY_GPU),
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

const report = {
  schema: 1,
  tool: 'jlc-fan-test',
  at: new Date().toISOString(),
  apply: APPLY,
  duty: DUTY,
  pct: Math.round((DUTY / 200) * 100),
  before: null,
  during: [],
  after: [],
  restored: null,
  error: null,
  log,
}

async function main() {
  if (process.getuid?.() !== 0) throw new Error('需要 root：sudo node probe/fan-test.mjs --apply')
  if (!fs.existsSync(CALL)) throw new Error('/proc/acpi/call 不存在，先 modprobe acpi_call')

  const before = snapshot()
  report.before = before
  saved = before
  rec(`原值: mode=0x${before.mode.toString(16)} dutyCpu=${before.dutyCpu} dutyGpu=${before.dutyGpu} cpu=${before.cpuRpm}RPM gpu=${before.gpuRpm}RPM cpu=${before.cpuTemp}℃ gpu=${before.gpuTemp}℃`)

  if (!(before.mode & 0x40) && !(ecRead(REG.FAN_CTRL_STATUS) & 0x40)) {
    throw new Error('0x078e bit6 未置位：本机不支持通用风扇控制，中止')
  }

  if (!APPLY) {
    rec(`计划（未执行）：0x0751 由 0x${before.mode.toString(16)} 改为 0x${(before.mode | 0x40).toString(16)}；`)
    rec(`                0x1804/0x1809 写 ${DUTY}（${report.pct}%）；3 秒后回滚`)
    rec('加 --apply 才会真正写入')
    return
  }

  // 手动模式下两路风扇都写，避免一路停在未知占空比
  const manualMode = before.mode | 0x40
  const dutyCpu = before.dutyCpu
  const dutyGpu = before.dutyGpu

  try {
    // 先写占空比再进手动模式：避免进入手动瞬间用到旧的（可能是 0 的）占空比
    rec(`写入 duty cpu=${DUTY} gpu=${DUTY}`)
    ecWrite(REG.DUTY_CPU, DUTY)
    ecWrite(REG.DUTY_GPU, DUTY)
    rec(`写入 mode=0x${manualMode.toString(16)}（置 manual 位）`)
    ecWrite(REG.MODE, manualMode)
    for (let i = 0; i < 6; i++) {
      await sleep(500)
      const s = snapshot()
      report.during.push(s)
      rec(`  +${(i + 1) * 0.5}s cpu=${s.cpuRpm}RPM gpu=${s.gpuRpm}RPM cpu=${s.cpuTemp}℃ gpu=${s.gpuTemp}℃`)
    }
  } finally {
    // 无条件回滚（含 Ctrl-C 路径）
    try {
      rollbackSync('测试结束')
      await sleep(50)
      const r = snapshot()
      report.restored = r
      rec(`回滚后读回: mode=0x${r.mode.toString(16)} dutyCpu=${r.dutyCpu} dutyGpu=${r.dutyGpu}`)
      if (r.mode !== before.mode) rec(`⚠️ mode 未回到原值！手工恢复：sudo sh -c 'echo "\\_SB.INOU.ECRW 0x0751 0x${before.mode.toString(16)}" > /proc/acpi/call'`)
    } catch (e) {
      rec(`❌ 回滚失败: ${e.message}`)
      rec(`手工恢复：sudo sh -c 'echo "\\_SB.INOU.ECRW 0x0751 0x${before.mode.toString(16)}" > /proc/acpi/call'`)
      rec(`          sudo sh -c 'echo "\\_SB.INOU.ECRW 0x1804 0x${dutyCpu.toString(16)}" > /proc/acpi/call'`)
      rec(`          sudo sh -c 'echo "\\_SB.INOU.ECRW 0x1809 0x${dutyGpu.toString(16)}" > /proc/acpi/call'`)
    }
  }

  for (let i = 0; i < 6; i++) {
    await sleep(500)
    const s = snapshot()
    report.after.push(s)
    rec(`  settled +${(i + 1) * 0.5}s cpu=${s.cpuRpm}RPM gpu=${s.gpuRpm}RPM`)
  }
}

await main().catch((e) => {
  report.error = String(e.message ?? e)
  rec(`错误: ${report.error}`)
})

fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2) + '\n')
fs.writeFileSync(OUT_TXT, log.join('\n') + '\n')

const peak = report.during.length ? Math.max(...report.during.map((s) => s.cpuRpm)) : null
const lines = [
  `风扇写入测试  apply=${report.apply} duty=${report.duty}(${report.pct}%)`,
  report.before ? `写入前: cpu=${report.before.cpuRpm}RPM gpu=${report.before.gpuRpm}RPM mode=0x${report.before.mode.toString(16)}` : '未读取',
  peak !== null ? `写入中峰值: cpu=${peak}RPM` : '未执行写入',
  report.after.length ? `回滚后: cpu=${report.after.at(-1).cpuRpm}RPM` : '',
  report.error ? `错误: ${report.error}` : '',
  `日志: ${OUT_JSON}`,
].filter(Boolean)
process.stdout.write('\n' + lines.join('\n') + '\n')
