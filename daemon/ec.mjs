/**
 * EC 传输层：通过 acpi_call 调用 `\_SB.INOU.ECRR/ECRW`。
 *
 * 本机（Uniwill/Tongfang 平台）的 EC RAM 映射在 0xFED50000，ACPI 暴露了
 * ECRR(addr) / ECRW(addr, val) 两个方法，因此不需要内核模块，也不需要
 * /dev/port（后者已被 kernel lockdown 封死）。
 */
import fs from 'node:fs'

const CALL = '/proc/acpi/call'
const METHOD_READ = '\\_SB.INOU.ECRR'
const METHOD_WRITE = '\\_SB.INOU.ECRW'

/** 方法执行失败（AE_* 错误、模块未加载等） */
export class EcError extends Error {
  constructor(message, {addr, op} = {}) {
    super(message)
    this.name = 'EcError'
    this.addr = addr
    this.op = op
  }
}

export class Ec {
  #ready = null

  /** 延迟探测：首次读写时才检查 /proc/acpi/call */
  get available() {
    if (this.#ready !== null) return this.#ready
    this.#ready = false
    try {
      if (!fs.existsSync(CALL)) return this.#ready
      fs.writeFileSync(CALL, `${METHOD_READ} 0x43e`)
      const v = this.#parse(fs.readFileSync(CALL, 'utf8'), 0x43e)
      this.#ready = Number.isInteger(v)
    } catch {
      this.#ready = false
    }
    return this.#ready
  }

  #parse(text, addr) {
    const t = String(text).replace(/\0/g, '').trim()
    const m = t.match(/^0x([0-9a-fA-F]+)$/)
    if (!m) throw new EcError(`ECRR 返回异常: ${JSON.stringify(t.slice(0, 80))}`, {addr, op: 'read'})
    return parseInt(m[1], 16)
  }

  readByte(addr) {
    try {
      fs.writeFileSync(CALL, `${METHOD_READ} 0x${addr.toString(16)}`)
      return this.#parse(fs.readFileSync(CALL, 'utf8'), addr)
    } catch (e) {
      if (e instanceof EcError) throw e
      throw new EcError(e.message, {addr, op: 'read'})
    }
  }

  writeByte(addr, value) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new EcError(`写入值非法: ${value}`, {addr, op: 'write'})
    }
    try {
      fs.writeFileSync(CALL, `${METHOD_WRITE} 0x${addr.toString(16)} 0x${value.toString(16)}`)
    } catch (e) {
      throw new EcError(e.message, {addr, op: 'write'})
    }
  }

  readWord(hi, lo) {
    return (this.readByte(hi) << 8) | this.readByte(lo)
  }

  /** read-modify-write：只改 mask 指定的位，避免整字节覆盖 */
  updateBit(addr, mask, on) {
    const cur = this.readByte(addr)
    const next = on ? cur | mask : cur & ~mask
    if (next !== cur) this.writeByte(addr, next & 0xff)
    return {before: cur, after: next & 0xff}
  }

  /** 尽力读取，失败返回 fallback（用于批量采样，不因单点失败中断） */
  tryRead(addr, fallback = null) {
    try {
      return this.readByte(addr)
    } catch {
      return fallback
    }
  }
}

/** 本机已验证的 EC 地址表 */
export const REG = {
  CPU_TEMP: 0x043e,
  GPU_TEMP: 0x044f,

  CPU_RPM_HI: 0x0464,
  CPU_RPM_LO: 0x0465,
  GPU_RPM_HI: 0x046c,
  GPU_RPM_LO: 0x046d,

  BAREBONE_ID: 0x0740,
  MODE: 0x0751, // bit4=TBME(性能) bit7=UFME(安静) bit6=手动风扇
  CUME: 0x0727, // bit6=自定义档（白灯）
  FN_LOCK: 0x074e,
  KBD_RGB_MODE: 0x0767,
  KBD_RGB_R: 0x0769,
  KBD_RGB_G: 0x076a,
  KBD_RGB_B: 0x076b,
  KBD_BL_STATUS: 0x078c, // bits[7:5]=档位0..4(0=关) bit4=apply 触发
  KBD_BL_BLUE_IMMEDIATE: 0x1808, // 蓝色即时亮度；背光关闭时写入 0x078c 不生效，需先抬这个值
  FAN_CTRL_STATUS: 0x078e,

  DUTY_CPU: 0x1804,
  DUTY_GPU: 0x1809,

  FAN_TABLE_CPU: 0x0f20,
  FAN_TABLE_GPU: 0x0f50,
}

/** 0x0751 位定义（依据本机 DSDT 的 ECMG 字段与 PMSC 逻辑） */
export const MODE_BIT = {
  TBME: 0x10, // 性能档（Turbo Mode Enable）
  UFME: 0x80, // 安静档（User Fan Mode Enable）
  MANUAL_FAN: 0x40, // 手动风扇（uniwill full fan mode）
}

/** 0x0727 bit6 = CUME，官方控制中心的"自定义/白灯"档 */
export const CUME_BIT = 0x40

/** 调任意 ACPI 方法（整数参数），返回原始字符串 */
export function acpiCall(methodPath, args = []) {
  const tail = args.map((a) => (typeof a === 'number' ? '0x' + a.toString(16) : String(a))).join(' ')
  fs.writeFileSync(CALL, tail ? `${methodPath} ${tail}` : methodPath)
  return fs.readFileSync(CALL, 'utf8').replace(/\0/g, '').trim()
}

/** 让固件应用当前档位（DSDT: EC0.PMSF） */
export const applyPerformanceMode = () => acpiCall('\\_SB.PCI0.SBRG.EC0.PMSF')

/** 风扇占空比范围：0..200 */
export const FAN_DUTY_MAX = 200
