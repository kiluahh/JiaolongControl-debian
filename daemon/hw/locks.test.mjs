import test from 'node:test'
import assert from 'node:assert/strict'

import {INTERNAL_KEYBOARD, LOCK_LED_SUFFIX, ledStates} from './locks.mjs'

const caps = (device, brightness) => ({
  name: `input0${LOCK_LED_SUFFIX.CapsLock}`,
  key: 'CapsLock',
  brightness,
  device,
})
const num = (device, brightness) => ({
  name: `input0${LOCK_LED_SUFFIX.NumLock}`,
  key: 'NumLock',
  brightness,
  device,
})

test('ledStates：内置键盘 LED 亮 = 开启', () => {
  const s = ledStates([caps(INTERNAL_KEYBOARD, 1), num(INTERNAL_KEYBOARD, 0)])
  assert.deepEqual(s, {CapsLock: true, NumLock: false})
})

test('ledStates：优先内置键盘，忽略外接键盘的脏 LED', () => {
  // 外接键盘 CapsLock 停在亮，内置是灭 —— 系统实际是灭
  const s = ledStates([
    caps(INTERNAL_KEYBOARD, 0),
    caps('USB Keyboard', 1),
    caps('Logitech USB Receiver Keyboard', 1),
  ])
  assert.equal(s.CapsLock, false)
})

test('ledStates：没有内置键盘节点时退回任一 LED 亮', () => {
  const s = ledStates([caps('USB Keyboard', 0), caps('Logitech USB Receiver Keyboard', 1)])
  assert.equal(s.CapsLock, true)
})

test('ledStates：完全没有该键的 LED 时返回 null（未知，不是关闭）', () => {
  const s = ledStates([])
  assert.deepEqual(s, {CapsLock: null, NumLock: null})
  // 只有 CapsLock 节点 → NumLock 仍是未知
  const only = ledStates([caps(INTERNAL_KEYBOARD, 1)])
  assert.equal(only.CapsLock, true)
  assert.equal(only.NumLock, null)
})

test('ledStates：多个内置节点取"任一为亮"，容忍重复/别名', () => {
  const s = ledStates([caps(INTERNAL_KEYBOARD, 0), caps(INTERNAL_KEYBOARD, 1)])
  assert.equal(s.CapsLock, true)
})

test('ledStates：输入为空也安全', () => {
  assert.deepEqual(ledStates(undefined), {CapsLock: null, NumLock: null})
  assert.deepEqual(ledStates(null), {CapsLock: null, NumLock: null})
})
