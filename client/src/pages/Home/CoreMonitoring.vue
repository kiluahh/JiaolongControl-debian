<script setup lang="ts">
import {computed} from 'vue'
import VChart from 'vue-echarts'
import {use} from 'echarts/core'
import {CanvasRenderer} from 'echarts/renderers'
import {PieChart} from 'echarts/charts'
import {chartTheme} from '@/theme/theme'

use([CanvasRenderer, PieChart])

const props = defineProps<{
  cpuUsage: number
  gpuUsage: number
  cpuTemp: number
  gpuTemp: number
}>()

const getRingOption = (
  value: number,
  colorStart: string,
  colorEnd: string,
  suffix: string = '%',
) => ({
  series: [
    {
      type: 'pie',
      radius: ['75%', '90%'],
      avoidLabelOverlap: false,
      silent: true,
      label: {
        show: true,
        position: 'center',
        formatter: () => `${value}${suffix}`,
        fontSize: 24,
        fontWeight: 'bold',
        color: chartTheme.value.label,
      },
      data: [
        {
          value: value,
          itemStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 1,
              y2: 1,
              colorStops: [
                { offset: 0, color: colorStart },
                { offset: 1, color: colorEnd },
              ],
            },
            borderRadius: 10,
          },
        },
        {
          value: 100 - value,
          itemStyle: { color: chartTheme.value.line },
        },
      ],
    },
  ],
})

const cpuUsageOption = computed(() => getRingOption(props.cpuUsage || 0, '#3B82F6', '#8A2BE2'))
const gpuUsageOption = computed(() => getRingOption(props.gpuUsage || 0, '#10B981', '#3B82F6'))
const cpuTempOption = computed(() => getRingOption(props.cpuTemp || 0, '#3B82F6', '#3B82F6', '°C'))
const gpuTempOption = computed(() => getRingOption(props.gpuTemp || 0, '#8A2BE2', '#8A2BE2', '°C'))
</script>

<template>
  <div class="col-span-7 glass-card p-6 flex flex-col">
    <h2 class="text-[15px] font-medium text-ink/90 mb-2">核心监控</h2>
    <!-- 4 个圆环等分剩余宽度并封顶 128px: 窗口变窄时整体缩小, 不再挤破卡片 -->
    <div class="flex-1 grid grid-cols-4 items-center gap-2 px-2 min-w-0">
      <!-- CPU 使用率 -->
      <div class="flex flex-col items-center min-w-0">
        <div class="w-full max-w-32 aspect-square relative">
          <VChart :option="cpuUsageOption" autoresize />
        </div>
        <span class="text-xs text-gray-400 mt-2 text-center">CPU 使用率</span>
      </div>

      <!-- GPU 使用率 -->
      <div class="flex flex-col items-center min-w-0">
        <div class="w-full max-w-32 aspect-square relative">
          <VChart :option="gpuUsageOption" autoresize />
        </div>
        <span class="text-xs text-gray-400 mt-2 text-center">GPU 使用率</span>
      </div>

      <!-- CPU 温度 -->
      <div class="flex flex-col items-center min-w-0">
        <div class="w-full max-w-32 aspect-square relative">
          <VChart :option="cpuTempOption" autoresize />
        </div>
        <span class="text-xs text-gray-400 mt-2 text-center">CPU 温度</span>
      </div>

      <!-- GPU 温度 -->
      <div class="flex flex-col items-center min-w-0">
        <div class="w-full max-w-32 aspect-square relative">
          <VChart :option="gpuTempOption" autoresize />
        </div>
        <span class="text-xs text-gray-400 mt-2 text-center">GPU 温度</span>
      </div>
    </div>
  </div>
</template>
