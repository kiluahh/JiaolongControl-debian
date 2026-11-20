/**
 * 键盘背光的寄存器协议（纯逻辑，无 I/O）。
 *
 * 协议来源：TUXEDO 的 GPL 驱动 tuxedo-drivers/src/uniwill_leds.h 与
 * uniwill_interfaces.h（同一 Uniwill/Tongfang EC），并在本机
 * MECHREVO JIAOLONG X6DR55xx-B2 上逐条实测复核。
 *
 * 0x078c  KBD_BL_STATUS
 *   bits[7:5] 档位 0..4，**0 = 关灯**
 *   bit4  0x10  apply 触发位 —— 写入时必须置位，否则 EC 永不执行
 *   bits[3:0]   必须保留（bit0 = WHITE_ONLY_KB）
 * 0x0767  KBD_BL_RGB_MODE
 *   bit7  0x80  呼吸/彩虹
 *   bit5  0x20  固定色 apply（一次性触发，EC 执行后会自行清位）
 * 0x0769 / 0x076a / 0x076b  R / G / B 通道，量程 0..50（不是 0..255）
 * 0x1808  蓝色即时亮度；背光关闭时，0x078c 的写入不会被应用，
 *         需要先让该寄存器非零才能唤醒（灯亮着时无需处理）
 *
 * 关键点：档位写入漏掉 0x10 会导致"值写进去了但灯不变、回读还保持"的假象；
 * 颜色写入漏掉 0x20 则完全无效，且呼吸模式下颜色会被彩虹覆盖。
 */

/** 亮度档位上限。0 = 关灯，1..4 = 亮度递增 */
export const LEVEL_MAX = 4

/** RGB 通道在 EC 里的量程上限 */
export const CHANNEL_MAX_EC = 50

const APPLY = 0x10
const LOW_MASK = 0x0f
const LEVEL_SHIFT = 5
const MODE_APPLY_COLOR = 0x20
const MODE_RAINBOW = 0x80

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * 生成写入 0x078c 的字节：保留低 4 位，写入档位，并置 apply 位。
 * @param {number} current 当前寄存器值（用于保留低 4 位）
 * @param {number} level 档位 0..4
 */
export function encodeBrightness(current, level) {
  const cur = Number.isFinite(current) ? current & 0xff : 0
  const lv = clamp(Math.round(Number(level) || 0), 0, LEVEL_MAX)
  return ((cur & LOW_MASK) | (lv << LEVEL_SHIFT) | APPLY) & 0xff
}

/** 从 0x078c 解析档位（0 = 关灯，1..4 = 亮度） */
export function decodeBrightness(byte) {
  const v = Number.isFinite(byte) ? byte & 0xff : 0
  return clamp((v >> LEVEL_SHIFT) & 0x07, 0, LEVEL_MAX)
}

/** UI 的 0..255 通道值 → EC 的 0..50（等价于驱动里的 tf_convert_rgb_range） */
export function encodeChannel(value) {
  const v = clamp(Math.round(Number(value) || 0), 0, 255)
  return clamp(Math.round((v * 200) / (255 * 4)), 0, CHANNEL_MAX_EC)
}

/** EC 的 0..50 → UI 的 0..255 */
export function decodeChannel(ec) {
  const v = clamp(Math.round(Number(ec) || 0), 0, CHANNEL_MAX_EC)
  return clamp(Math.round((v * 255 * 4) / 200), 0, 255)
}

/** 当前是否处于呼吸/彩虹模式 */
export function isRainbow(mode) {
  return ((Number(mode) || 0) & MODE_RAINBOW) !== 0
}

/** 固定色触发指令：清呼吸 + 置 apply（一次性） */
export function modeForColor() {
  return MODE_APPLY_COLOR
}

/** 开启呼吸：在现有模式上置 bit7 */
export function modeForRainbow(current) {
  return (((Number(current) || 0) & 0xff) | MODE_RAINBOW) & 0xff
}

/** 背光是否处于"需要唤醒"的状态（即时蓝色亮度为 0） */
export function needsWake(blueImmediate) {
  return (Number(blueImmediate) || 0) === 0
}
