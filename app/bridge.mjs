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
      finish({Success: false, Message: `jlc-daemon 未运行（${e.code || e.message}）`})
    })
  })
}

export function pingDaemon() {
  return callDaemon('Sys', 'Ping')
}
