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

const argv = process.argv.slice(2)
const argValue = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`))
  return hit ? hit.slice(n.length + 3) : d
}

const SOCKET = argValue('socket', process.env.JLC_SOCKET || '/run/jlc.sock')
const VERBOSE = argv.includes('--verbose')

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

const server = startServer(SOCKET, dispatch, log)

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
