import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CHANNEL_MAX_EC,
  LEVEL_MAX,
  decodeBrightness,
  decodeChannel,
  encodeBrightness,
  encodeChannel,
  isRainbow,
  modeForColor,
  modeForRainbow,
  needsWake,
} from './kbc.mjs'

test('encodeBrightness：保留低 4 位 + 置 apply 位', () => {
  assert.equal(encodeBrightness(0x80, 4), 0x90)
  assert.equal(encodeBrightness(0x80, 0), 0x10)
  // bit0 = WHITE_ONLY_KB，必须保留
  assert.equal(encodeBrightness(0x81, 2), 0x51)
  assert.equal(encodeBrightness(0x8f, 1), 0x3f)
})

test('encodeBrightness：档位越界被夹取', () => {
  assert.equal(encodeBrightness(0x00, 9), encodeBrightness(0x00, LEVEL_MAX))
  assert.equal(encodeBrightness(0x00, -1), 0x10)
})

test('decodeBrightness：解析 bits[7:5] 且与编码互逆', () => {
  for (let level = 0; level <= LEVEL_MAX; level++) {
    assert.equal(decodeBrightness(encodeBrightness(0x00, level)), level)
  }
  assert.equal(decodeBrightness(0x80), 4)
  assert.equal(decodeBrightness(0x00), 0)
})

test('encodeChannel：按驱动公式 v*200/(255*4) 换算到 0..50', () => {
  assert.equal(CHANNEL_MAX_EC, 50)
  assert.equal(encodeChannel(0), 0)
  assert.equal(encodeChannel(255), 50)
  assert.equal(encodeChannel(128), 25)
})

test('decodeChannel：0/128/255 精确互逆，其余误差不超过 3', () => {
  for (const v of [0, 128, 255]) assert.equal(decodeChannel(encodeChannel(v)), v)
  for (const v of [1, 32, 64, 100, 192, 250]) {
    assert.ok(Math.abs(decodeChannel(encodeChannel(v)) - v) <= 3, `v=${v}`)
  }
})

test('通道换算会夹取越界输入', () => {
  assert.equal(encodeChannel(-10), 0)
  assert.equal(encodeChannel(999), CHANNEL_MAX_EC)
  assert.equal(decodeChannel(-1), 0)
  assert.equal(decodeChannel(200), 255)
})

test('模式位：呼吸 = bit7，固定色指令 = 0x20', () => {
  assert.equal(isRainbow(0x80), true)
  assert.equal(isRainbow(0xa0), true)
  assert.equal(isRainbow(0x00), false)
  assert.equal(isRainbow(0x20), false)
  // 固定色：清呼吸 + apply（0x20 是一次性触发，EC 执行后会清掉）
  assert.equal(modeForColor(), 0x20)
  // 呼吸：在现有模式上置 bit7
  assert.equal(modeForRainbow(0x00), 0x80)
  assert.equal(modeForRainbow(0x20), 0xa0)
})

test('needsWake：即时亮度为 0 时才需要先唤醒', () => {
  assert.equal(needsWake(0), true)
  assert.equal(needsWake(0xff), false)
  assert.equal(needsWake(1), false)
})
