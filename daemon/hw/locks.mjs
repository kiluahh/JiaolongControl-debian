/**
 * 锁定键状态（CapsLock / NumLock）的真实来源：键盘 LED。
 *
 * 为什么读 LED 而不是"写寄存器"：本机没有 Windows 那套 WMI 锁定接口，
 * 而大写/数字锁是 OS 层状态，唯一能从外部观察到它的地方就是键盘 LED
 * （/sys/class/leds/inputN::capslock|numlock/brightness）。
 *
 * 为什么优先内置键盘：GNOME Wayland 下 mutter 只给"产生按键事件的那个键盘"
 * 更新 LED（libinput_device_led_update 针对事件源设备）。所以接了外接键盘时，
 * 外接键盘的 LED 可能是脏的——在外接键盘上按两次 CapsLock，内置键盘 LED 是通的、
 * 外接键盘 LED 却停在亮，「任一 LED 为亮」就会误报。内置键盘（AT Translated Set 2）
 * 是笔记本自己那颗，作为主判据更贴近用户在面板上看到的含义。
 *
 * 纯函数 ledStates() 与 IO 分离，便于单测。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 锁定键 → LED 类名后缀 */
export const LOCK_LED_SUFFIX = {
  CapsLock: '::capslock',
  NumLock: '::numlock',
}

/** 笔记本内置键盘的 input 设备名（i8042/atkbd） */
export const INTERNAL_KEYBOARD = 'AT Translated Set 2 keyboard'

const readText = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim()
  } catch {
    return null
  }
}

const readInt = (p) => {
  const t = readText(p)
  if (t === null) return null
  const n = Number(t)
  return Number.isInteger(n) ? n : null
}

function deviceName(ledDir) {
  // /sys/class/leds/input0::capslock/device -> ../../.../input0，其下 name 即设备名
  return readText(path.join(ledDir, 'device', 'name'))
}

/**
 * 扫描 LED 目录，返回 [{name, key, brightness, device}]
 * 读不到目录（容器/无键盘节点）时返回空数组，不抛异常。
 */
export function readLedEntries(root = '/sys/class/leds') {
  let names
  try {
    names = fs.readdirSync(root)
  } catch {
    return []
  }
  const keys = Object.keys(LOCK_LED_SUFFIX)
  const out = []
  for (const name of names) {
    const key = keys.find((k) => name.endsWith(LOCK_LED_SUFFIX[k]))
    if (!key) continue
    const ledDir = path.join(root, name)
    const brightness = readInt(path.join(ledDir, 'brightness'))
    if (brightness === null) continue
    out.push({name, key, brightness, device: deviceName(ledDir)})
  }
  return out
}

/**
 * 由 LED 快照推导锁定状态。
 * 每个键：优先只取内置键盘的 LED；没有内置节点时退回"任一 LED 亮"；
 * 完全找不到该键的 LED 时返回 null（前端显示"未知"，不要假装是关闭）。
 *
 * @param {Array<{name: string, key: string, brightness: number, device: string|null}>} entries
 * @returns {{CapsLock: boolean|null, NumLock: boolean|null}}
 */
export function ledStates(entries) {
  const states = {CapsLock: null, NumLock: null}
  for (const key of Object.keys(LOCK_LED_SUFFIX)) {
    const siblings = (entries ?? []).filter((e) => e.key === key)
    if (siblings.length === 0) continue
    const internal = siblings.filter((e) => e.device === INTERNAL_KEYBOARD)
    const pool = internal.length > 0 ? internal : siblings
    states[key] = pool.some((e) => e.brightness > 0)
  }
  return states
}
