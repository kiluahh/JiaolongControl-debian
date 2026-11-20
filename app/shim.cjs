/**
 * WebView2 hostObjects 兼容 shim 的核心（与 Electron 解耦，便于单测）。
 *
 * 前端调用形态：
 *   const p = bridge.CPU.GetCpuUsage()      // 返回带 toJson() 的 thenable
 *   JSON.parse(await p.toJson())            // → {Success, Message, Data}
 */
'use strict'

function createBridge(invoke) {
  const groups = new Map()

  function makeCall(group, method) {
    return (...args) => {
      const json = () => invoke(group, method, args)
      // then 走解析后的对象，toJson 走原始 JSON 字符串：两种用法都合理
      const value = () => json().then((s) => JSON.parse(s))
      return {
        toJson: json,
        then: (onFulfilled, onRejected) => value().then(onFulfilled, onRejected),
        catch: (onRejected) => value().catch(onRejected),
        finally: (fn) => value().finally(fn),
      }
    }
  }

  return new Proxy(
    {},
    {
      get(_target, group) {
        if (typeof group !== 'string' || group === 'then' || group === 'toJSON') return undefined
        if (!groups.has(group)) {
          groups.set(
            group,
            new Proxy(
              {},
              {
                get(_t, method) {
                  if (typeof method !== 'string') return undefined
                  return makeCall(group, method)
                },
              },
            ),
          )
        }
        return groups.get(group)
      },
    },
  )
}

module.exports = {createBridge}
