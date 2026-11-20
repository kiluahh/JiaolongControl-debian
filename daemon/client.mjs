#!/usr/bin/env node
/** 调试客户端：node daemon/client.mjs <group> <method> [jsonArgs] */
import net from 'node:net'

const [group, method, argsJson] = process.argv.slice(2)
const socket = process.env.JLC_SOCKET || '/run/jlc.sock'

if (!group || !method) {
  console.error('用法: node daemon/client.mjs <group> <method> [jsonArgs]')
  process.exit(2)
}

const sock = net.createConnection(socket)
let buf = ''
sock.setEncoding('utf8')
sock.on('connect', () => {
  sock.write(JSON.stringify({id: 1, group, method, args: argsJson ? JSON.parse(argsJson) : []}) + '\n')
})
sock.on('data', (chunk) => {
  buf += chunk
  if (!buf.includes('\n')) return
  const line = buf.slice(0, buf.indexOf('\n'))
  try {
    const res = JSON.parse(line)
    console.log(JSON.stringify(res.result ?? res, null, 2))
  } catch {
    console.log(line)
  }
  sock.end()
})
sock.on('error', (e) => {
  console.error(`连接失败: ${e.message}`)
  process.exit(1)
})
