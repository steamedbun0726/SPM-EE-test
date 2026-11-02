<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { statsOverview, type StatsOverview } from '@/api/m1'

const loading = ref(false)
const days = ref(7)
const data = ref<StatsOverview | null>(null)

const maxBooking = computed(() => Math.max(1, ...(data.value?.spaces.map((s) => s.bookingCount) ?? [0])))
const maxHourly = computed(() => Math.max(1, ...(data.value?.hourly.map((h) => h.count) ?? [0])))
const maxDaily = computed(() => Math.max(1, ...(data.value?.daily.map((d) => d.count) ?? [0])))

/** 顶部指标卡：数据全部来自 GET /m1/stats/overview */
const metrics = computed(() => {
  const t = data.value?.totals
  return [
    { label: '有效预约', value: t?.reservations ?? 0, suffix: '次', hint: `已取消 ${t?.cancelled ?? 0} 次`, tone: 'blue' },
    {
      label: '座位利用率',
      value: t?.utilization ?? 0,
      suffix: '%',
      hint: `${t?.seatHours ?? 0} / ${t?.capacityHours ?? 0} 座位小时`,
      tone: 'green',
    },
    { label: '已签到', value: t?.checkedIn ?? 0, suffix: '次', hint: '扫码签到成功的预约', tone: 'cyan' },
    { label: '违约', value: t?.noShow ?? 0, suffix: '次', hint: '超时未签到', tone: 'orange' },
  ]
})

function barWidth(count: number): string {
  return `${(count / maxBooking.value) * 100}%`
}

function heatStyle(count: number): Record<string, string> {
  const ratio = count / maxHourly.value
  const alpha = count === 0 ? 0.06 : 0.15 + ratio * 0.75
  return {
    backgroundColor: `rgba(64, 158, 255, ${alpha.toFixed(3)})`,
    color: ratio > 0.55 ? '#ffffff' : '#303133',
  }
}

function trendHeight(count: number): string {
  return `${Math.max(4, (count / maxDaily.value) * 100)}px`
}

function shortDate(date: string): string {
  return date.slice(5)
}

function formatPercent(value: number): string {
  return `${value}%`
}

async function load() {
  loading.value = true
  try {
    data.value = await statsOverview(days.value)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div v-loading="loading" class="page-container ops-board">
    <el-card shadow="never" class="head-card">
      <div class="head-row">
        <div>
          <div class="head-title">自习座位运营看板</div>
          <div v-if="data" class="head-sub">
            统计窗口 {{ data.fromDate }} ~ {{ data.toDate }}（{{ data.days }} 天） · 口径：有效预约（不含取消）
          </div>
        </div>
        <div class="head-actions">
          <el-radio-group v-model="days" @change="load">
            <el-radio-button :value="7">未来 7 天</el-radio-button>
            <el-radio-button :value="30">未来 30 天</el-radio-button>
          </el-radio-group>
          <el-button :loading="loading" @click="load">刷新</el-button>
        </div>
      </div>
    </el-card>

    <el-row :gutter="16" class="metric-row">
      <el-col v-for="m in metrics" :key="m.label" :xs="12" :sm="6">
        <el-card shadow="never" class="metric-card">
          <div class="metric-label">{{ m.label }}</div>
          <div class="metric-value" :class="`tone-${m.tone}`">
            {{ m.value }}<span class="metric-suffix">{{ m.suffix }}</span>
          </div>
          <div class="metric-hint">{{ m.hint }}</div>
        </el-card>
      </el-col>
    </el-row>

    <el-row :gutter="16">
      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="chart-card">
          <template #header>
            <span>按自习室预约量</span>
          </template>
          <div v-if="data" class="bar-list">
            <div v-for="s in data.spaces" :key="s.spaceId" class="bar-row">
              <div class="bar-label">
                <div class="bar-name">{{ s.name }}</div>
                <div class="bar-code">{{ s.code }}</div>
              </div>
              <div class="bar-track">
                <div class="bar-fill" :style="{ width: barWidth(s.bookingCount) }" />
              </div>
              <div class="bar-value">{{ s.bookingCount }}</div>
            </div>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="chart-card">
          <template #header>
            <span>时段热力（每小时被预约座位数）</span>
          </template>
          <div v-if="data" class="heatmap-wrap">
            <div class="heatmap">
              <div
                v-for="h in data.hourly"
                :key="h.hour"
                class="heat-cell"
                :style="heatStyle(h.count)"
                :title="`${h.hour}:00 - ${h.hour + 1}:00 · ${h.count} 个座位`"
              >
                <span class="heat-hour">{{ h.hour }}</span>
                <span class="heat-count">{{ h.count }}</span>
              </div>
            </div>
            <div class="heat-legend">
              <span>低</span>
              <span class="legend-bar" />
              <span>高</span>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="chart-card">
      <template #header>
        <span>每日预约趋势</span>
      </template>
      <div v-if="data" class="trend">
        <div v-for="d in data.daily" :key="d.date" class="trend-col" :title="`${d.date} · ${d.count} 次`">
          <div class="trend-value">{{ d.count }}</div>
          <div class="trend-bar-wrap">
            <div class="trend-bar" :style="{ height: trendHeight(d.count) }" />
          </div>
          <div class="trend-date">{{ shortDate(d.date) }}</div>
        </div>
      </div>
    </el-card>

    <el-card shadow="never">
      <template #header>
        <span>空间明细</span>
      </template>
      <el-table v-if="data" :data="data.spaces" border stripe>
        <el-table-column label="空间" min-width="200">
          <template #default="{ row }">
            <div class="space-name">{{ row.name }}</div>
            <div class="space-code">{{ row.code }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="seats" label="启用座位" width="100" />
        <el-table-column prop="bookingCount" label="预约量" width="100" />
        <el-table-column prop="seatHours" label="座位小时" width="100" />
        <el-table-column label="利用率" min-width="180">
          <template #default="{ row }">
            <el-progress :percentage="row.utilization" :stroke-width="10" :format="formatPercent" />
          </template>
        </el-table-column>
        <el-table-column prop="checkedInCount" label="签到" width="80" />
        <el-table-column prop="noShowCount" label="违约" width="80" />
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.ops-board {
  padding-bottom: 8px;
}

.head-card {
  margin-bottom: 16px;
}

.head-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.head-title {
  font-size: 18px;
  font-weight: 700;
  color: #303133;
}

.head-sub {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.metric-row {
  margin-bottom: 16px;
}

.metric-card {
  margin-bottom: 8px;
}

.metric-label {
  font-size: 13px;
  color: #909399;
}

.metric-value {
  margin: 6px 0 4px;
  font-size: 28px;
  font-weight: 700;
  line-height: 1.2;
}

.metric-suffix {
  margin-left: 4px;
  font-size: 13px;
  font-weight: 400;
  color: #909399;
}

.metric-hint {
  font-size: 12px;
  color: #c0c4cc;
}

.tone-blue {
  color: #409eff;
}

.tone-green {
  color: #67c23a;
}

.tone-cyan {
  color: #17b3a3;
}

.tone-orange {
  color: #e6a23c;
}

.chart-card {
  margin-bottom: 16px;
}

.bar-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.bar-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.bar-label {
  width: 150px;
  flex-shrink: 0;
  line-height: 1.4;
}

.bar-name {
  font-size: 13px;
  color: #303133;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.bar-code {
  font-size: 11px;
  color: #a8abb2;
}

.bar-track {
  flex: 1;
  height: 14px;
  background: #f0f2f5;
  border-radius: 7px;
  overflow: hidden;
}

.bar-fill {
  height: 100%;
  border-radius: 7px;
  background: linear-gradient(90deg, #a0cfff, #409eff);
  transition: width 0.4s ease;
}

.bar-value {
  width: 44px;
  text-align: right;
  font-size: 14px;
  font-weight: 600;
  color: #303133;
}

.heatmap-wrap {
  overflow-x: auto;
}

.heatmap {
  display: grid;
  grid-template-columns: repeat(24, minmax(26px, 1fr));
  gap: 4px;
  min-width: 720px;
}

.heat-cell {
  height: 56px;
  border-radius: 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  transition: background-color 0.3s ease;
}

.heat-hour {
  font-size: 10px;
  opacity: 0.75;
}

.heat-count {
  font-size: 13px;
  font-weight: 600;
}

.heat-legend {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12px;
  color: #909399;
}

.legend-bar {
  width: 80px;
  height: 10px;
  border-radius: 5px;
  background: linear-gradient(90deg, rgba(64, 158, 255, 0.15), rgba(64, 158, 255, 0.9));
}

.trend {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  overflow-x: auto;
  padding-top: 8px;
}

.trend-col {
  flex: 1 0 26px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

.trend-value {
  margin-bottom: 4px;
  font-size: 11px;
  color: #606266;
}

.trend-bar-wrap {
  width: 100%;
  height: 120px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.trend-bar {
  width: 60%;
  max-width: 22px;
  border-radius: 4px 4px 0 0;
  background: linear-gradient(180deg, #a0cfff, #409eff);
  transition: height 0.4s ease;
}

.trend-date {
  margin-top: 6px;
  font-size: 11px;
  color: #909399;
  white-space: nowrap;
}

.space-name {
  font-size: 14px;
  color: #303133;
  line-height: 1.5;
}

.space-code {
  font-size: 12px;
  color: #909399;
}
</style>
