/**
 * Ryzen SMU 邮箱封装（ryzen_smu 内核模块）。
 *
 * 接口：
 *   /sys/kernel/ryzen_smu_drv/smu_args    6×u32 小端（24 字节）
 *   /sys/kernel/ryzen_smu_drv/mp1_smu_cmd 写二进制命令字节，读 u32LE 状态
 *   /sys/kernel/ryzen_smu_drv/rsmu_cmd    同上，RSMU 邮箱
 *
 * 状态：1=成功 0xFE=未知指令 0xFD=条件不满足 0xFC=繁忙 0xFB=超时 0xFF=失败
 */
import fs from 'node:fs'
import path from 'node:path'

const DIR = '/sys/kernel/ryzen_smu_drv'

export const STATUS = {
  0x01: '成功',
  0xfb: '超时',
  0xfc: '被拒绝：繁忙',
  0xfd: '被拒绝：条件不满足',
  0xfe: '未知指令',
  0xff: '失败',
}

export class SmuError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'SmuError'
    this.status = status
  }
}

export function available() {
  return fs.existsSync(path.join(DIR, 'mp1_smu_cmd'))
}

export function info() {
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(DIR, f), 'utf8').trim()
    } catch {
      return null
    }
  }
  return {version: read('version'), codename: read('codename'), mp1IfVersion: read('mp1_if_version')}
}

/**
 * 发一条 SMU 命令。
 * @param {'mp1'|'rsmu'} mailbox
 * @param {number} cmd
 * @param {number} arg 第一个参数（其余 5 个填 0）
 */
export function send(mailbox, cmd, arg = 0) {
  if (!available()) throw new SmuError('ryzen_smu 模块未加载')
  const file = path.join(DIR, `${mailbox}_smu_cmd`)
  const args = Buffer.alloc(24)
  args.writeUInt32LE(arg >>> 0, 0)

  fs.writeFileSync(path.join(DIR, 'smu_args'), args)
  // 驱动按 sizeof(u8) 取二进制值，必须写字节而不是文本
  fs.writeFileSync(file, Buffer.from([cmd & 0xff]))
  const rsp = fs.readFileSync(file)
  const status = rsp.length >= 4 ? rsp.readUInt32LE(0) : (rsp[0] ?? 0)

  if (status !== 0x01) {
    throw new SmuError(`${STATUS[status] ?? 'SMU 错误'}（cmd=0x${cmd.toString(16)} status=0x${status.toString(16)}）`, status)
  }
  return status
}

/** 先试 MP1，失败再试 RSMU（对应上游 TrySend 的行为） */
export function sendAny(mp1Cmd, rsmuCmd, arg = 0) {
  if (mp1Cmd === null) return send('rsmu', rsmuCmd, arg)
  if (rsmuCmd === null) return send('mp1', mp1Cmd, arg)
  try {
    return send('mp1', mp1Cmd, arg)
  } catch (first) {
    if (first.status !== 0xfe) throw first // 不是"未知指令"就不必换邮箱
    return send('rsmu', rsmuCmd, arg)
  }
}

/** AM5（family 19h model 0x61）命令号，取自上游 RyzenSmuController */
export const CMD = {
  stapmLimit: {mp1: 0x4f, rsmu: null},
  stapmTime: {mp1: 0x53, rsmu: null},
  fastLimit: {mp1: 0x3e, rsmu: null},
  slowLimit: {mp1: 0x5f, rsmu: 0xcb},
  slowTime: {mp1: 0x60, rsmu: null},
  pptLimitRsmu: {mp1: null, rsmu: 0x56},
  vrmCurrent: {mp1: 0x3c, rsmu: 0x57},
  edcLimit: {mp1: 0x3d, rsmu: 0x58},
  tempLimit: {mp1: 0x3f, rsmu: 0x59},
  pboScalar: {mp1: null, rsmu: 0x5b},
  ocClk: {mp1: null, rsmu: 0x5f},
  ocClkPerCore: {mp1: null, rsmu: 0x60},
  ocVolt: {mp1: null, rsmu: 0x61},
  ocEnable: {mp1: null, rsmu: 0x5d},
  ocDisable: {mp1: null, rsmu: 0x5e},
  curveAll: {mp1: 0x36, rsmu: 0x07},
  curveCore: {mp1: 0x35, rsmu: 0x06},
}
