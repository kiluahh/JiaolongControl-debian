/** UNIX socket + 换行分隔 JSON-RPC */
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'

/**
 * @param {string} socketPath
 * @param {(req:{group:string,method:string,args:any[]}) => Promise<any>|any} dispatch
 * @param {(msg:string)=>void} log
 */
export function startServer(socketPath, dispatch, log = () => {}, {mode = 0o660} = {}) {
  try {
    fs.mkdirSync(path.dirname(socketPath), {recursive: true})
  } catch {}
  try {
    fs.unlinkSync(socketPath)
  } catch {}

  const server = net.createServer((sock) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) handle(sock, line)
      }
      if (buf.length > 1 << 20) buf = '' // 防御：单行超过 1MB 直接丢弃
    })
    sock.on('error', (e) => log(`socket error: ${e.message}`))
  })

  async function handle(sock, line) {
    let req
    try {
      req = JSON.parse(line)
    } catch {
      sock.write(JSON.stringify({id: null, ok: false, error: 'invalid json'}) + '\n')
      return
    }
    const {id = null, group, method, args = []} = req
    try {
      const result = await dispatch({group, method, args: Array.isArray(args) ? args : [args]})
      sock.write(JSON.stringify({id, ok: true, result}) + '\n')
    } catch (e) {
      sock.write(JSON.stringify({id, ok: false, error: String(e?.message ?? e)}) + '\n')
    }
  }

  server.listen(socketPath, () => {
    try {
      fs.chmodSync(socketPath, mode)
      const gid = lookupGroup('jlc')
      if (gid !== null) fs.chownSync(socketPath, 0, gid)
    } catch (e) {
      log(`socket 权限设置失败: ${e.message}`)
    }
    log(`listening on ${socketPath}`)
  })

  return server
}

function lookupGroup(name) {
  try {
    const line = fs
      .readFileSync('/etc/group', 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${name}:`))
    return line ? Number(line.split(':')[2]) : null
  } catch {
    return null
  }
}
