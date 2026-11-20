#!/usr/bin/env node
/**
 * jlc-daemon —— 唯一接触硬件的进程，以 root 身份由 systemd 拉起。
 *
 * 用法：
 *   sudo node daemon/index.mjs                    # 正式：/run/jlc.sock
 *   node daemon/index.mjs --socket=/tmp/jlc.sock  # 开发（EC 不可用时会降级）
 */
import {startServer} from './rpc.mjs'
import {methods} from './methods.mjs'
import {Ec} from './ec.mjs'
import {loadConfig} from './hw/config.mjs'
import {planBootActions, runBootActions} from './boot.mjs'

const argv = process.argv.slice(2)
const argValue = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}

const SOCKET = argValue('socket', process.env.JLC_SOCKET || '/run/jlc.sock')
const VERBOSE = argv.includes('--verbose')
const DEV = argv.includes('--dev') // 0666 权限，方便非 root 试跑

const ts = () => new Date().toISOString().slice(11, 19)
const log = (msg) => process.stderr.write(`[${ts()}] ${msg}\n`)

async function dispatch({group, method, args}) {
  const g = methods[group]
  if (!g) throw new Error(`未知分组: ${group}`)
  const fn = g[method]
  if (typeof fn !== 'function') throw new Error(`未知方法: ${group}.${method}`)
  const started = Date.now()
  const result = await fn(...args)
  const cost = Date.now() - started
  if (VERBOSE || cost > 200) log(`${group}.${method} ${cost}ms`)
  return result ?? {Success: true, Message: '成功'}
}

const ec = new Ec()
log(`uid=${process.getuid?.()} EC=${ec.available ? '可用' : '不可用'}`)
if (!ec.available) {
  log('警告：/proc/acpi/call 不可用（需要 root + acpi_call 模块），硬件控制将全部失败')
}

const server = startServer(SOCKET, dispatch, log, {mode: DEV ? 0o666 : 0o660})

// ── 开机自动应用 ────────────────────────────────────────────────────────────
// 设置页那 6 个"开机应用"开关在这里才真正生效：把 config 里勾选的性能参数重放一遍。
// 放到 server 起来之后执行：前端可以先连上来，应用过程不会阻塞端口。
async function applyBootConfig() {
  let actions
  try {
    actions = planBootActions(loadConfig())
  } catch (e) {
    log(`开机应用：读取配置失败（${e.message}），跳过`)
    return
  }
  if (actions.length === 0) return
  const {applied, failed, skipped} = await runBootActions(actions, (group, method, args) =>
    dispatch({group, method, args}),
  )
  if (applied.length) log(`开机应用：${applied.length} 项成功 —— ${applied.join('、')}`)
  if (skipped.length) log(`开机应用：跳过 ${skipped.length} 项 —— ${skipped.join('、')}`)
  if (failed.length) log(`开机应用：失败 ${failed.length} 项 —— ${failed.join('、')}`)
}

applyBootConfig().catch((e) => log(`开机应用异常：${e?.message ?? e}`))

let closing = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (closing) return
    closing = true
    log(`收到 ${sig}，清理中`)
    server.close()
    process.exit(0)
  })
}
