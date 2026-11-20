/** 与 jlc-daemon 的 UNIX socket 通信（每个请求一条连接，请求量很低） */
import net from 'node:net'

const SOCKET = process.env.JLC_SOCKET || '/run/jlc.sock'
const TIMEOUT_MS = 4000

let seq = 0

export function callDaemon(group, method, args = []) {
  return new Promise((resolve) => {
    const id = ++seq
    const sock = net.createConnection(SOCKET)
    let buf = ''
    let done = false
    const finish = (res) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {}
      resolve(res)
    }
    const timer = setTimeout(() => finish({Success: false, Message: `daemon 超时（${method}）`}), TIMEOUT_MS)

    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(JSON.stringify({id, group, method, args}) + '\n'))
    sock.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      try {
        const msg = JSON.parse(buf.slice(0, nl))
        if (msg.ok) finish(msg.result ?? {Success: true, Message: '成功'})
        else finish({Success: false, Message: msg.error ?? 'daemon 错误'})
      } catch {
        finish({Success: false, Message: 'daemon 返回无法解析'})
      }
    })
    sock.on('error', (e) => {
      finish({Success: false, Message: describeSocketError(e)})
    })
  })
}

export function pingDaemon() {
  return callDaemon('Sys', 'Ping')
}

/** 把 socket 错误翻译成用户能照着做的提示（EACCES 不等于 daemon 没运行） */
function describeSocketError(e) {
  const code = e?.code || ''
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return '无法访问 jlc-daemon：当前用户不在 jlc 组。请注销并重新登录，或运行 newgrp jlc 后再启动本程序。'
    case 'ENOENT':
    case 'ECONNREFUSED':
      return 'jlc-daemon 未运行，请执行：sudo systemctl start jlc-daemon'
    default:
      return `无法连接 jlc-daemon（${code || e?.message || '未知错误'}）`
  }
}
