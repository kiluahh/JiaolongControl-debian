/**
 * OSD 纯逻辑：不 import electron，方便用 node:test 直接测。
 *
 * 本机（Debian 13 / GNOME 48 Wayland）能做的四类提示：
 *   性能模式 / 风扇全速 / 键盘背光 / 触摸板——这四样系统自己都不弹提示。
 * 音量不做：GNOME 有自己的音量条，且没有 API 能关掉它。
 */

/** OSD 基准尺寸（DIP，scale=100 时）；渲染层用 vh 字号，窗口放大即等比缩放 */
export const OSD_BASE = {width: 420, height: 112}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
/** 兼容两种口径：0.92 与 92 都当成 92% */
const asPercent = (v, d) => {
  const n = num(v, d)
  return n <= 2 ? n * 100 : n
}

/** 把 config.Osd 规整成 OSD 运行时需要的形状（缺字段一律走默认值） */
export function normalizeOsdConfig(osd = {}) {
  return {
    enabled: !!osd.Enabled,
    showPerformanceMode: osd.ShowPerformanceMode !== false,
    showFan: osd.ShowFan !== false,
    showKeyboardBacklight: osd.ShowKeyboardBacklight !== false,
    showTouchpad: osd.ShowTouchpad !== false,
    animationMs: clamp(num(osd.AnimationMs, 180), 0, 3000),
    durationMs: clamp(num(osd.DurationMs, 1600), 300, 8000),
    pollIntervalMs: clamp(num(osd.PollIntervalMs, 500), 300, 5000),
    position: ['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight', 'Custom'].includes(osd.Position)
      ? osd.Position
      : 'BottomRight',
    customX: clamp(num(osd.CustomX, 50), 0, 100),
    customY: clamp(num(osd.CustomY, 92), 0, 100),
    opacity: clamp(asPercent(osd.Opacity, 92), 10, 100) / 100,
    scale: clamp(asPercent(osd.Scale, 100), 50, 300) / 100,
  }
}

export function osdWindowSize(scale = 1) {
  const s = clamp(Number(scale) || 1, 0.5, 3)
  return {width: Math.round(OSD_BASE.width * s), height: Math.round(OSD_BASE.height * s)}
}

/**
 * 计算窗口左上角坐标。位置语义与前端「显示位置」一致：
 * 四个角贴边 + 自定义（屏幕行程百分比 0~100）。中间的居中位置不再提供。
 */
export function osdPlacement({position = 'BottomRight', customX = 50, customY = 92, width, height, workArea}) {
  const wa = workArea ?? {x: 0, y: 0, width: 1920, height: 1080}
  // 贴边（留 8px 呼吸位）：滑动入场要像从屏幕边缘冒出来，所以窗口本身就贴边
  const marginX = 8
  const marginY = 40
  const left = wa.x + marginX
  const right = wa.x + wa.width - width - marginX
  const top = wa.y + marginY
  const bottom = wa.y + wa.height - height - marginY
  switch (position) {
    case 'TopLeft':
      return {x: left, y: top}
    case 'TopRight':
      return {x: right, y: top}
    case 'BottomLeft':
      return {x: left, y: bottom}
    case 'Custom':
      return {
        x: Math.round(wa.x + ((wa.width - width) * clamp(num(customX, 50), 0, 100)) / 100),
        y: Math.round(wa.y + ((wa.height - height) * clamp(num(customY, 92), 0, 100)) / 100),
      }
    default:
      return {x: right, y: bottom}
  }
}

/** 滑入方向：靠哪边就从哪边滑出来（自定义位置按 X 百分比就近取边） */
export function osdSlideDirection(position, customX = 50) {
  if (position === 'TopLeft' || position === 'BottomLeft') return 'left'
  if (position === 'TopRight' || position === 'BottomRight') return 'right'
  return clamp(num(customX, 50), 0, 100) < 50 ? 'left' : 'right'
}

/** 本机性能模式枚举：0=平衡 / 1=性能 / 2=安静（与 daemon 一致） */
const PERF = {
  0: {label: '平衡', sub: 'BALANCE', accent: '#8b5cf6'},
  1: {label: '性能', sub: 'PERFORMANCE', accent: '#f97316'},
  2: {label: '安静', sub: 'QUIET', accent: '#22c55e'},
}
export const PERF_LABELS = Object.fromEntries(Object.entries(PERF).map(([k, v]) => [k, v.label]))

/** 键盘背光最高档（EC 0x078c bits[7:5]，0~4） */
export const KEYBOARD_MAX_LEVEL = 4

/**
 * 生成渲染层需要的 payload。
 * @param {'perf'|'fan'|'keyboard'|'touchpad'} kind
 * @param {number|boolean|null} value
 */
export function osdPayload(kind, value, opts = {}) {
  const base = {
    kind,
    animationMs: clamp(num(opts.animationMs, 180), 0, 3000),
    durationMs: clamp(num(opts.durationMs, 1600), 300, 8000),
    opacity: clamp(num(opts.opacity, 0.92), 0.1, 1),
    progress: null,
    slide: opts.slide === 'left' ? 'left' : 'right',
    accent: '#8b5cf6',
    icon: kind,
    title: '',
    value: '',
    sub: '',
  }
  if (kind === 'perf') {
    const p = PERF[value] ?? {label: '未知', sub: 'UNKNOWN', accent: '#8b5cf6'}
    return {...base, title: '性能模式', value: p.label, sub: p.sub, accent: p.accent}
  }
  if (kind === 'fan') {
    const on = !!value
    return {
      ...base,
      title: '风扇',
      value: on ? '全速' : '自动',
      sub: on ? 'FULL SPEED' : 'AUTO',
      accent: on ? '#ef4444' : '#64748b',
      progress: on ? 1 : 0,
    }
  }
  if (kind === 'keyboard') {
    const level = clamp(Math.round(num(value, 0)), 0, KEYBOARD_MAX_LEVEL)
    return {
      ...base,
      title: '键盘背光',
      value: level > 0 ? `${level} 档` : '关闭',
      sub: `BRIGHTNESS ${level}/${KEYBOARD_MAX_LEVEL}`,
      accent: '#3b82f6',
      progress: level / KEYBOARD_MAX_LEVEL,
    }
  }
  if (kind === 'touchpad') {
    const on = !!value
    return {
      ...base,
      title: '触摸板',
      value: on ? '已启用' : '已禁用',
      sub: on ? 'ENABLED' : 'DISABLED',
      accent: on ? '#14b8a6' : '#64748b',
    }
  }
  return {...base, title: '状态', value: String(value ?? '')}
}

/**
 * 对比两次快照，返回变化项。null 表示该路读取失败（不比较，避免误弹）。
 * @param {{perf:number|null, fan:boolean|null, keyboard:number|null, touchpad:boolean|null}|null} prev
 * @param {{perf:number|null, fan:boolean|null, keyboard:number|null, touchpad:boolean|null}} next
 * @returns {Array<{kind:string, value:number|boolean}>}
 */
export function diffOsdState(prev, next) {
  if (!prev || !next) return []
  const out = []
  for (const kind of ['perf', 'fan', 'keyboard', 'touchpad']) {
    const a = prev[kind]
    const b = next[kind]
    if (a === null || a === undefined || b === null || b === undefined) continue
    if (a !== b) out.push({kind, value: b})
  }
  return out
}
