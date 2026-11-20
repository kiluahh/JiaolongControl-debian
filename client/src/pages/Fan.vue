<script setup lang="ts">
import {onMounted, ref} from 'vue'
import {Message} from '@arco-design/web-vue'
import {Fan} from '@/utils/bridge'
import {stopAutoFanIfRunning} from '@/utils/fanControl'
import FanSpeed from '@/components/common/FanSpeed.vue'

const loading = ref(false)
const fullFan = ref(false)

/**
 * 本机风扇只有「自动」和「全速」两档（2026-11-20 实测，见 probe/fan-table.mjs）：
 *   0x1804/0x1809 占空比 10..200 → 转速恒 ～5630 RPM，不随值变化
 *   0x0f20/0x0f50 风扇表 + 使能位 → 转速恒 ～3348 RPM，表没被读
 *   唯一有效的是 0x0751 bit6（full fan mode）
 * 所以这里不给滑条，只给开关——不做看起来能调、其实调不动的控件。
 */
async function refresh() {
  try {
    const res = await Fan.GetMaxFanSpeedSwitch()
    if (res.Success) fullFan.value = !!res.Data
  } catch {
    /* 读不到就保持当前显示 */
  }
}

async function handleToggle(value: string | number | boolean) {
  const want = !!value
  loading.value = true
  try {
    // 全速开关与自动风扇控制环互斥：先停控制环，避免它把状态写回去
    await stopAutoFanIfRunning()
    const res = await Fan.SetMaxFanSpeedSwitch(want)
    if (res.Success) {
      Message.success(res.Message)
    } else {
      Message.error(res.Message || '切换失败')
      fullFan.value = !want
    }
  } catch {
    Message.error('操作失败，请检查桥接服务')
    fullFan.value = !want
  } finally {
    loading.value = false
    await refresh()
  }
}

onMounted(refresh)
</script>

<template>
  <div class="h-full overflow-y-auto text-ink p-6 no-scrollbar">
    <div class="max-w-[1300px] mx-auto flex flex-col lg:flex-row gap-6">
      <!-- ==================== 左侧：风扇模式 ==================== -->
      <div class="flex-1 space-y-6">
        <div>
          <h1 class="text-2xl font-bold tracking-wide">风扇控制</h1>
          <p class="text-[13px] text-gray-500 mt-1">
            本机 EC 只提供「自动」与「全速」两档，不支持按转速调节
          </p>
        </div>

        <div class="panel-card p-6">
          <div class="flex flex-col gap-6">
            <div class="flex justify-between items-center">
              <div>
                <span class="text-[10px] font-bold text-purple-400 uppercase tracking-widest block"
                  >Fan Mode</span
                >
                <h2 class="text-base font-semibold mt-1 text-gray-200">
                  {{ fullFan ? '全速（EC 不再自动调速）' : '自动（EC 固件曲线）' }}
                </h2>
                <p class="text-[11px] text-gray-500 mt-1">
                  自动模式随性能档（平衡/性能/安静）由 EC 固件调节转速；全速模式把两个风扇钉在最高转速。
                </p>
              </div>
              <a-switch
                :model-value="fullFan"
                :loading="loading"
                size="medium"
                @change="handleToggle"
              />
            </div>

            <div class="text-[11px] text-gray-500 leading-relaxed border-t border-ink/[0.06] pt-4 space-y-2">
              <p>
                <strong class="text-gray-400">为什么没有转速滑条</strong>：本机 EC 不接受按转速写入。
                实测 `0x1804/0x1809` 占空比 10–200、`0x0f20/0x0f50` 自定义风扇表、以及驱动里的
                old-path 时序，转速都恒定不变（分别是 ～5630 / ～3348 / ～5620 RPM），
                只有 `0x0751` bit6 的「全速」位真正生效。
              </p>
              <p>证据：<code class="text-gray-400">probe/fan-table.mjs</code> 与 <code class="text-gray-400">probe/fan-table.json</code>。</p>
            </div>
          </div>
        </div>
      </div>

      <!-- ==================== 右侧：实时监控 ==================== -->
      <div class="w-full lg:w-[360px] shrink-0 space-y-6 lg:pt-[115px]">
        <FanSpeed />

        <div class="panel-card space-y-2.5 select-none">
          <h2 class="text-[13px] font-semibold text-gray-300">安全提示</h2>
          <div class="text-[11px] text-gray-500 leading-relaxed space-y-2">
            <p><strong>全速模式</strong>：两个风扇会持续运行在最高转速，噪音明显增大，适合压测、渲染或清灰后短时使用。</p>
            <p><strong>切回自动</strong>：关闭开关即可交回 EC 固件调速，转速会按温度与性能档自然回落。</p>
            <p>
              <strong>高温保护</strong>：自动模式下请不要长时间阻塞进出风口；温度墙由 Ryzen SMU 与 EC 双重保护。
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
