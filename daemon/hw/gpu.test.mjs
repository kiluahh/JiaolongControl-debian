import {test} from 'node:test'
import assert from 'node:assert/strict'

import {parseClockCsv, snapFloor} from './gpu.mjs'

test('parseClockCsv：去掉单位、去重、升序', () => {
  assert.deepEqual(parseClockCsv('3090 MHz\n180 MHz\n3000 MHz\n3090 MHz\n'), [180, 3000, 3090])
})

test('parseClockCsv：nounits、空行与坏行', () => {
  assert.deepEqual(parseClockCsv('9001\n405\n\nN/A\n'), [405, 9001])
  assert.deepEqual(parseClockCsv(''), [])
  assert.deepEqual(parseClockCsv(null), [])
})

test('snapFloor：0/负数/无效值表示"不限制"', () => {
  assert.equal(snapFloor(0, [900, 1200]), null)
  assert.equal(snapFloor(-1, [900, 1200]), null)
  assert.equal(snapFloor(undefined, [900, 1200]), null)
  assert.equal(snapFloor('abc', [900, 1200]), null)
})

test('snapFloor：取"至少 N"的最小档位（显存真实档位）', () => {
  const mem = [405, 810, 9001, 11001, 12001]
  assert.equal(snapFloor(5000, mem), 9001) // 8001 这种档位驱动会静默忽略，必须吸附
  assert.equal(snapFloor(9001, mem), 9001)
  assert.equal(snapFloor(9500, mem), 11001)
  assert.equal(snapFloor(1, mem), 405)
})

test('snapFloor：超过最高档取最高档；没有档位返回 null', () => {
  assert.equal(snapFloor(99999, [405, 12001]), 12001)
  assert.equal(snapFloor(1500, []), null)
  assert.equal(snapFloor(1500, null), null)
})

test('snapFloor：乱序输入也能正确吸附', () => {
  assert.equal(snapFloor(1500, [3090, 180, 1500, 1200]), 1500)
})
