<script lang="ts" setup>
import {computed, ref} from 'vue'
import {Message} from '@arco-design/web-vue'
import SettingToggle from '@/components/common/SettingToggle.vue'
import EditableValue from '@/components/common/EditableValue.vue'
import {useConfigStore} from '@/stores/config'
import {Osd} from '@/utils/bridge'
import type {OsdPosition} from '@/types/config'

const configStore = useConfigStore()
const osdData = computed(() => configStore.config?.Osd)

// ===== 显示效果 =====
const positionOptions: Array<{ value: OsdPosition; label: string }> = [
  { value: 'TopLeft', label: '左上' },
  { value: 'TopRight', label: '右上' },
  { value: 'BottomLeft', label: '左下' },
  { value: 'BottomRight', label: '右下' },
  { value: 'Custom', label: '自定义' },
]
const currentPosition = computed(() => osdData.value?.Position ?? 'BottomRight')

function selectPosition(value: OsdPosition) {
  if (!osdData.value || currentPosition.value === value) return
  osdData.value.Position = value
  configStore.debouncedSave()
}

function saveDebounced() {
  configStore.debouncedSave()
}

/** 右栏可调参数行: 字段/范围/步进/单位/滑条配色 (step 缺省走组件默认 1) */
interface OsdSliderRow {
  key: 'AnimationMs' | 'DurationMs' | 'Opacity' | 'Scale' | 'PollIntervalMs'
  label: string
  min: number
  max: number
  step: number
  unit: string
  sliderClass: string
  note?: string
}

const sliderRows: OsdSliderRow[] = [
  { key: 'AnimationMs', label: '出入场时长', min: 200, max: 3000, step: 20, unit: 'ms', sliderClass: 'slider-purple' },
  { key: 'DurationMs', label: '显示时长', min: 500, max: 5000, step: 100, unit: 'ms', sliderClass: 'slider-purple' },
  { key: 'Opacity', label: '面板不透明度', min: 30, max: 100, step: 1, unit: '%', sliderClass: 'slider-blue' },
  { key: 'Scale', label: '界面缩放', min: 100, max: 200, step: 5, unit: '%', sliderClass: 'slider-orange' },
  {
    key: 'PollIntervalMs',
    label: '状态轮询间隔',
    min: 500,
    max: 5000,
    step: 100,
    unit: 'ms',
    sliderClass: 'slider-red',
    note: 'Wayland 不允许全局按键钩子，状态变化只能靠轮询 EC 寄存器与 GNOME 设置检测；\n这是两次采样的间隔。调小反应更快，代价是更频繁读 EC。',
  },
]

// ===== 自定义位置: 屏幕比例预览区拖拽 (与服务端相同的行程百分比映射) =====
const PILL_W = 52
const PILL_H = 14
const previewEl = ref<HTMLElement | null>(null)
let previewDragging = false

const pillStyle = computed(() => {
  const x = ((osdData.value?.CustomX ?? 50) / 100).toFixed(4)
  const y = ((osdData.value?.CustomY ?? 92) / 100).toFixed(4)
  return {
    left: `calc((100% - ${PILL_W}px) * ${x})`,
    top: `calc((100% - ${PILL_H}px) * ${y})`,
    width: `${PILL_W}px`,
    height: `${PILL_H}px`,
  }
})

function applyPreviewPosition(e: PointerEvent) {
  const el = previewEl.value
  if (!el || !osdData.value) return
  const rect = el.getBoundingClientRect()
  const travelX = Math.max(1, rect.width - PILL_W)
  const travelY = Math.max(1, rect.height - PILL_H)
  const clampPct = (v: number) => Math.round(Math.min(100, Math.max(0, v)))
  osdData.value.CustomX = clampPct(((e.clientX - rect.left - PILL_W / 2) / travelX) * 100)
  osdData.value.CustomY = clampPct(((e.clientY - rect.top - PILL_H / 2) / travelY) * 100)
  configStore.debouncedSave()
}

function onPillPointerDown(e: PointerEvent) {
  if (!osdData.value) return
  previewDragging = true
  if (currentPosition.value !== 'Custom') osdData.value.Position = 'Custom'
  const target = e.currentTarget as HTMLElement
  target.setPointerCapture(e.pointerId)
  configStore.debouncedSave()
}

function onPillPointerMove(e: PointerEvent) {
  if (previewDragging) applyPreviewPosition(e)
}

function onPillPointerUp() {
  previewDragging = false
}

// ===== 效果预览: 四类 OSD 各弹一次真窗口 =====
async function preview(kind: string, value: number | boolean) {
  try {
    const res = await Osd.ShowTest(kind, value)
    if (!res.Success) Message.error(res.Message)
  } catch {
    Message.error('OSD 预览失败')
  }
}

const previewItems: Array<{ kind: string; label: string; value: number | boolean }> = [
  { kind: 'perf', label: '性能模式', value: 1 },
  { kind: 'fan', label: '风扇', value: true },
  { kind: 'keyboard', label: '键盘背光', value: 3 },
  { kind: 'touchpad', label: '触摸板', value: true },
]
</script>

<template>
  <div v-if="osdData" class="h-full overflow-y-auto text-ink p-6 no-scrollbar">
    <div class="max-w-[1300px] mx-auto">
      <!-- 头部标题: 通栏显示, 下方左右两列顶部齐平 -->
      <div>
        <h1 class="text-2xl font-bold tracking-wide">OSD 屏幕显示</h1>
        <p class="text-[13px] text-gray-500 mt-1">
          OSD 悬浮指示器：状态变化时在屏幕指定位置弹出置顶胶囊，随后自动隐去（音量由系统自带提示，这里不重复显示）
        </p>
      </div>

      <div class="flex flex-col xl:flex-row gap-6 pt-6">
        <!-- ==================== 左列: 开关与显示项目 ==================== -->
        <div class="flex-1 min-w-0 space-y-4">
          <SettingToggle
            config-path="Osd.Enabled"
            description="启用后，性能模式、风扇、键盘背光、触摸板状态变化时，屏幕上会弹出置顶的胶囊指示器（无需重启，即时生效）"
            title="启用 OSD 屏幕显示"
          />
          <SettingToggle
            config-path="Osd.ShowPerformanceMode"
            description="切换性能模式（面板内操作，或 Fn 快捷键由 EC 直接改寄存器）时显示当前模式名称；靠状态轮询检测，变化后约一个轮询间隔内弹出"
            title="性能模式切换"
          />
          <SettingToggle
            config-path="Osd.ShowFan"
            description="风扇在「自动 / 全速」之间切换时显示当前状态（对应 EC 0x0751 bit6）"
            title="风扇模式"
          />
          <SettingToggle
            config-path="Osd.ShowKeyboardBacklight"
            description="通过本软件调整键盘背光亮度时显示当前档位（0~4 档，对应 EC 0x078c）"
            title="键盘背光档位"
          />
          <SettingToggle
            config-path="Osd.ShowTouchpad"
            description="触摸板启用 / 禁用状态变化时显示（读 GNOME 的 touchpad send-events 设置）"
            title="触摸板锁定"
          />
        </div>

        <!-- ==================== 右列: 显示效果与预览 ==================== -->
        <div class="w-full xl:w-[380px] shrink-0 space-y-6">
          <!-- 显示效果 -->
          <div class="panel-card space-y-5">
            <h3
              class="text-xs font-black text-purple-400 uppercase tracking-widest border-l-4 border-purple-600 pl-2.5"
            >
              显示效果
            </h3>

            <div>
              <div class="text-[11px] text-gray-400 mb-2">显示位置</div>
              <div class="flex items-center gap-1 p-1 rounded-xl bg-ink/[0.04] border border-ink/[0.06]">
                <button
                  v-for="opt in positionOptions"
                  :key="opt.value"
                  :class="
                    currentPosition === opt.value
                      ? 'bg-cyber-purple text-white shadow-[0_0_10px_var(--color-glow-purple)]'
                      : 'text-muted hover:text-ink'
                  "
                  class="flex-1 px-2 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer"
                  @click="selectPosition(opt.value)"
                >
                  {{ opt.label }}
                </button>
              </div>

              <!-- 位置预览: 16:9 屏幕示意, 拖动胶囊即保存为自定义位置 -->
              <div
                class="relative w-full mt-2.5 rounded-lg border border-ink/[0.08] bg-ink/[0.03] overflow-hidden select-none"
                style="aspect-ratio: 16 / 9"
              >
                <div ref="previewEl" class="absolute inset-x-0 top-0 bottom-[10px]">
                  <div
                    :style="pillStyle"
                    class="absolute rounded-full bg-gradient-to-r from-purple-500 to-blue-500 shadow-[0_0_8px_var(--color-glow-purple)] cursor-grab active:cursor-grabbing touch-none"
                    @pointerdown="onPillPointerDown"
                    @pointermove="onPillPointerMove"
                    @pointerup="onPillPointerUp"
                  />
                </div>
                <div class="absolute inset-x-0 bottom-0 h-[10px] bg-ink/[0.06] border-t border-ink/[0.06]" />
              </div>
              <p class="text-[10px] text-gray-600 leading-relaxed mt-1.5">
                拖动胶囊到任意位置即保存为自定义位置（真实 OSD 出现在主屏的对应处）；
                选择预设位置时忽略自定义坐标。当前：X {{ osdData.CustomX }}% · Y
                {{ osdData.CustomY }}%
              </p>
            </div>

            <div v-for="row in sliderRows" :key="row.key" class="space-y-1.5">
              <div class="flex justify-between items-center text-[11px]">
                <span class="text-gray-400">{{ row.label }}</span>
                <EditableValue
                  v-model="osdData[row.key]"
                  :max="row.max"
                  :min="row.min"
                  :step="row.step"
                  class="text-ink font-mono"
                  :unit="row.unit"
                  @commit="saveDebounced"
                />
              </div>
              <a-slider
                v-model="osdData[row.key]"
                :class="row.sliderClass"
                :max="row.max"
                :min="row.min"
                :step="row.step"
                @change="saveDebounced"
              />
              <p v-if="row.note" class="text-[10px] text-gray-600 leading-relaxed whitespace-pre-line">
                {{ row.note }}
              </p>
            </div>
          </div>

          <!-- 效果预览 -->
          <div class="panel-card space-y-4">
            <h3
              class="text-xs font-black text-blue-400 uppercase tracking-widest border-l-4 border-blue-500 pl-2.5"
            >
              效果预览
            </h3>
            <div class="grid grid-cols-2 gap-2">
              <a-button
                v-for="item in previewItems"
                :key="item.kind"
                class="!rounded-lg font-semibold !bg-ink/[0.04] !text-ink !border-ink/[0.08] hover:!bg-purple-600/20 hover:!text-purple-300 transition"
                @click="preview(item.kind, item.value)"
              >
                预览{{ item.label }}
              </a-button>
            </div>
            <p class="text-[10px] text-gray-600 leading-relaxed">
              预览不受「启用 OSD」开关限制，点一下就在屏幕真实位置弹一次。
            </p>
          </div>

          <!-- 说明 -->
          <div class="panel-card">
            <h2 class="text-[13px] font-semibold text-gray-300 mb-3">名词解释</h2>
            <div class="text-[11px] text-gray-500 leading-relaxed space-y-2">
              <p>
                <strong>触发方式</strong>:
                Wayland 不允许程序监听全局按键，所以这里轮询 EC 寄存器与 GNOME 设置来判断状态变化；
                从面板里操作时外壳会立刻补一次采样，反馈是即时的。
              </p>
              <p>
                <strong>覆盖范围</strong>:
                独立置顶透明窗，显示在普通窗口之上，点击穿透、不抢焦点、不进任务栏与 Alt-Tab。
              </p>
              <p>
                <strong>音量</strong>:
                GNOME 自带音量条且没有关闭 API，本程序不再重复实现，避免一次按键弹两条；
                音量仍可在 OSD 页之外按系统方式调节。
              </p>
              <p>
                <strong>自动缩放</strong>:
                面板内容按窗口高度等比渲染，「界面缩放」调大后字号与位置一起放大，高 DPI 下自动适配。
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
  <div v-else class="flex items-center justify-center h-full">
    <a-spin dot />
  </div>
</template>
