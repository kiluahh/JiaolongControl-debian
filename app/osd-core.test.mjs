import test from 'node:test'
import assert from 'node:assert/strict'

import {
  KEYBOARD_MAX_LEVEL,
  diffOsdState,
  osdSlideDirection,
  normalizeOsdConfig,
  osdPayload,
  osdPlacement,
  osdWindowSize,
} from './osd-core.mjs'

test('normalizeOsdConfig：百分比两种口径都吃，非法值回落默认', () => {
  const a = normalizeOsdConfig({Opacity: 0.92, Scale: 1, Position: 'BottomRight', PollIntervalMs: 500})
  assert.equal(a.opacity, 0.92)
  assert.equal(a.scale, 1)

  const b = normalizeOsdConfig({Opacity: 92, Scale: 150})
  assert.equal(b.opacity, 0.92)
  assert.equal(b.scale, 1.5)

  const c = normalizeOsdConfig({Position: 'Mars', PollIntervalMs: 50, Enabled: true})
  assert.equal(c.position, 'BottomRight', '居中位置已取消，非法值落到右下')
  assert.equal(c.pollIntervalMs, 300, '轮询间隔有下限，避免把 EC 读爆')
  assert.equal(c.enabled, true)
})

test('normalizeOsdConfig：四类开关默认开，显式 false 才关', () => {
  const d = normalizeOsdConfig({ShowFan: false})
  assert.equal(d.showFan, false)
  assert.equal(d.showPerformanceMode, true)
  assert.equal(d.showKeyboardBacklight, true)
  assert.equal(d.showTouchpad, true)
})

test('osdWindowSize：按缩放等比放大，并夹在合理范围', () => {
  assert.deepEqual(osdWindowSize(1), {width: 420, height: 112})
  assert.deepEqual(osdWindowSize(1.5), {width: 630, height: 168})
  assert.deepEqual(osdWindowSize(9), {width: 1260, height: 336})
})

test('osdPlacement：预设位置与自定义百分比', () => {
  const workArea = {x: 0, y: 0, width: 1000, height: 800}
  const w = 400
  const h = 100
  assert.deepEqual(osdPlacement({position: 'BottomRight', width: w, height: h, workArea}), {x: 592, y: 660})
  assert.deepEqual(osdPlacement({position: 'TopLeft', width: w, height: h, workArea}), {x: 8, y: 40})
  assert.deepEqual(osdPlacement({position: 'TopRight', width: w, height: h, workArea}), {x: 592, y: 40})
  assert.deepEqual(osdPlacement({position: 'BottomLeft', width: w, height: h, workArea}), {x: 8, y: 660})
  assert.deepEqual(
    osdPlacement({width: w, height: h, workArea}),
    {x: 592, y: 660},
    '不传 position 默认右下，不再是中间',
  )
  assert.deepEqual(
    osdPlacement({position: 'Custom', customX: 0, customY: 0, width: w, height: h, workArea}),
    {x: 0, y: 0},
  )
  assert.deepEqual(
    osdPlacement({position: 'Custom', customX: 100, customY: 100, width: w, height: h, workArea}),
    {x: 600, y: 700},
  )
})

test('osdSlideDirection：靠哪边就从哪边滑出来', () => {
  assert.equal(osdSlideDirection('BottomRight'), 'right')
  assert.equal(osdSlideDirection('TopRight'), 'right')
  assert.equal(osdSlideDirection('BottomLeft'), 'left')
  assert.equal(osdSlideDirection('TopLeft'), 'left')
  assert.equal(osdSlideDirection('Custom', 10), 'left')
  assert.equal(osdSlideDirection('Custom', 90), 'right')
})

test('osdPayload：默认从右侧滑入，可指定左侧', () => {
  assert.equal(osdPayload('perf', 1).slide, 'right')
  assert.equal(osdPayload('perf', 1, {slide: 'left'}).slide, 'left')
})

test('osdPayload：性能模式中文名与配色', () => {
  assert.equal(osdPayload('perf', 0).value, '平衡')
  assert.equal(osdPayload('perf', 1).value, '性能')
  assert.equal(osdPayload('perf', 2).value, '安静')
  assert.equal(osdPayload('perf', 99).value, '未知')
  assert.equal(osdPayload('perf', 1).accent, '#f97316')
})

test('osdPayload：风扇 / 背光 / 触摸板', () => {
  assert.equal(osdPayload('fan', true).value, '全速')
  assert.equal(osdPayload('fan', false).value, '自动')
  assert.equal(osdPayload('fan', true).progress, 1)

  assert.equal(osdPayload('keyboard', 0).value, '关闭')
  assert.equal(osdPayload('keyboard', 3).value, '3 档')
  assert.equal(osdPayload('keyboard', 3).progress, 3 / KEYBOARD_MAX_LEVEL)
  assert.equal(osdPayload('keyboard', 99).value, `${KEYBOARD_MAX_LEVEL} 档`, '超范围要夹住')

  assert.equal(osdPayload('touchpad', true).value, '已启用')
  assert.equal(osdPayload('touchpad', false).value, '已禁用')
})

test('diffOsdState：首轮不弹、失败通道不弹、真变化才弹', () => {
  const base = {perf: 0, fan: false, keyboard: 2, touchpad: true}
  assert.deepEqual(diffOsdState(null, base), [], '首次采样只建基线')

  assert.deepEqual(diffOsdState(base, {...base}), [])
  assert.deepEqual(diffOsdState(base, {...base, fan: true}), [{kind: 'fan', value: true}])
  assert.deepEqual(diffOsdState(base, {...base, keyboard: null}), [], '读取失败不算变化')
  assert.deepEqual(diffOsdState(base, {...base, touchpad: false, perf: 1}), [
    {kind: 'perf', value: 1},
    {kind: 'touchpad', value: false},
  ])
})
