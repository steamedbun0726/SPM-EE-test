<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { listSpaces, occupancyStats } from '@/api/admin'
import { stats as m1Stats } from '@/api/m1'
import { stats as m3Stats } from '@/api/m3'
import type { Space, WorkOrderStats } from '@/api/types'

/** GET /spaces 返回带 seatCount 的空间 */
interface SpaceRow extends Space {
  seatCount: number
}

/** GET /spaces/stats 返回的占用统计行 */
interface OccupancyRow {
  spaceId: number
  code: string
  name: string
  totalSeats: number
  activeSeats: number
  maintenanceSeats: number
  occupiedByRoom: number
  bookedNow: number
}

/** GET /m1/stats 返回的预约统计行 */
interface M1StatsRow {
  spaceId: number
  code: string
  name: string
  bookingCount: number
  noShowCount: number
  checkedInCount: number
}

const loading = ref(false)
const spaces = ref<SpaceRow[]>([])
const rows = ref<OccupancyRow[]>([])
const m1Rows = ref<M1StatsRow[] | null>(null)

/** M3 工单统计（M3-18）：后端返回的比率已是百分数，口径见 m3.definitions */
const m3 = ref<WorkOrderStats | null>(null)
const m3Loading = ref(false)

const totalSeats = computed(() => spaces.value.reduce((sum, s) => sum + s.seatCount, 0))
const bookedTotal = computed(() => rows.value.reduce((sum, r) => sum + r.bookedNow, 0))

function fmtRate(v: number | null | undefined) {
  return v == null ? '-' : `${v}%`
}

function fmtHours(v: number | null | undefined) {
  return v == null ? '-' : `${v} h`
}

function fmtRange() {
  if (!m3.value) return ''
  const f = new Date(m3.value.range.from)
  const t = new Date(m3.value.range.to)
  const d = (x: Date) => x.toLocaleDateString('zh-CN')
  return `${d(f)} ~ ${d(t)}`
}

/** 可用座位 = 启用座位 - 维修中 - 整教室占用 */
function availableSeats(r: OccupancyRow) {
  return Math.max(0, r.activeSeats - r.maintenanceSeats - r.occupiedByRoom)
}

async function loadM3() {
  m3Loading.value = true
  try {
    m3.value = await m3Stats()
  } catch {
    m3.value = null
  } finally {
    m3Loading.value = false
  }
}

async function load() {
  loading.value = true
  try {
    spaces.value = (await listSpaces()) as unknown as SpaceRow[]
    rows.value = (await occupancyStats()) as unknown as OccupancyRow[]
    try {
      const data = (await m1Stats()) as unknown as M1StatsRow[]
      m1Rows.value = Array.isArray(data) ? data : null
    } catch {
      m1Rows.value = null
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  loadM3()
})
</script>

<template>
  <div class="page-container">
    <el-row :gutter="16" v-loading="loading">
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <el-statistic title="空间总数" :value="spaces.length" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <el-statistic title="座位总数" :value="totalSeats" />
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <el-statistic title="当前已预约座位" :value="bookedTotal" />
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never">
      <template #header>
        <span>空间占用统计</span>
      </template>
      <el-table :data="rows" border stripe>
        <el-table-column label="空间" min-width="200">
          <template #default="{ row }">
            <div class="space-cell">
              <div class="space-name">{{ row.name }}</div>
              <div class="space-code">{{ row.code }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="totalSeats" label="总座位" width="90" />
        <el-table-column label="可用" width="90">
          <template #default="{ row }">
            <el-tag size="small" type="success">{{ availableSeats(row) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="maintenanceSeats" label="维修中" width="90" />
        <el-table-column prop="occupiedByRoom" label="被整教室占用" width="120" />
        <el-table-column prop="bookedNow" label="当前已预约" width="110" />
      </el-table>
    </el-card>

    <el-card v-if="m1Rows" shadow="never" class="m1-card">
      <template #header>
        <span>预约运营汇总（M1 自习座位）</span>
      </template>
      <el-table :data="m1Rows" border stripe>
        <el-table-column label="空间" min-width="200">
          <template #default="{ row }">
            <div class="space-cell">
              <div class="space-name">{{ row.name }}</div>
              <div class="space-code">{{ row.code }}</div>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="bookingCount" label="预约总数" width="110" />
        <el-table-column prop="noShowCount" label="违约数" width="100" />
        <el-table-column prop="checkedInCount" label="签到数" width="100" />
      </el-table>
    </el-card>

    <!-- M3 工单统计（M3-18） -->
    <el-card v-if="m3" v-loading="m3Loading" shadow="never" class="m3-card">
      <template #header>
        <div class="m3-header">
          <span>物业报修统计（M3 工单）</span>
          <span class="m3-range">{{ fmtRange() }}</span>
        </div>
      </template>

      <el-row :gutter="12" class="m3-kpi">
        <el-col :span="4">
          <div class="kpi-box">
            <div class="kpi-value">{{ m3.totals.total }}</div>
            <div class="kpi-label">工单总量</div>
            <div class="kpi-note">未完结 {{ m3.totals.open }}</div>
          </div>
        </el-col>
        <el-col :span="4">
          <div class="kpi-box">
            <div class="kpi-value">{{ fmtRate(m3.kpi.completionRate) }}</div>
            <div class="kpi-label">完工率</div>
            <div class="kpi-note">已验收 {{ m3.totals.accepted }} 单</div>
          </div>
        </el-col>
        <el-col :span="4">
          <div class="kpi-box">
            <div class="kpi-value" :class="{ warn: (m3.kpi.slaComplianceRate ?? 100) < 80 }">
              {{ fmtRate(m3.kpi.slaComplianceRate) }}
            </div>
            <div class="kpi-label">SLA 达标率</div>
            <div class="kpi-note">按原始时限判定</div>
          </div>
        </el-col>
        <el-col :span="4">
          <div class="kpi-box">
            <div class="kpi-value">{{ fmtHours(m3.kpi.avgResponseHours) }}</div>
            <div class="kpi-label">平均首响</div>
            <div class="kpi-note">上报 → 接单开工</div>
          </div>
        </el-col>
        <el-col :span="4">
          <div class="kpi-box">
            <div class="kpi-value">{{ fmtHours(m3.kpi.avgResolveHours) }}</div>
            <div class="kpi-label">平均解决</div>
            <div class="kpi-note">已扣除挂起时长</div>
          </div>
        </el-col>
        <el-col :span="4">
          <div class="kpi-box">
            <div class="kpi-value" :class="{ warn: (m3.kpi.reworkRate ?? 0) > 20 }">
              {{ fmtRate(m3.kpi.reworkRate) }}
            </div>
            <div class="kpi-label">返工率</div>
            <div class="kpi-note">均分 {{ m3.kpi.avgRating ?? '-' }}</div>
          </div>
        </el-col>
      </el-row>

      <el-row :gutter="16">
        <el-col :span="12">
          <div class="m3-subtitle">分类分布</div>
          <el-table :data="m3.byCategory" border stripe size="small">
            <el-table-column prop="name" label="分类" min-width="120" />
            <el-table-column prop="count" label="工单数" width="90" />
            <el-table-column prop="openCount" label="未完结" width="90" />
            <template #empty>
              <el-empty description="区间内暂无工单" :image-size="50" />
            </template>
          </el-table>
        </el-col>
        <el-col :span="12">
          <div class="m3-subtitle">故障空间排行（前 5）</div>
          <el-table :data="m3.topSpaces" border stripe size="small">
            <el-table-column label="空间" min-width="160">
              <template #default="{ row }">
                <div class="space-name">{{ row.name }}</div>
                <div class="space-code">{{ row.code }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="count" label="工单数" width="90" />
            <el-table-column prop="openCount" label="未完结" width="90" />
            <template #empty>
              <el-empty description="区间内暂无工单" :image-size="50" />
            </template>
          </el-table>
        </el-col>
      </el-row>

      <el-collapse class="m3-defs">
        <el-collapse-item title="统计口径说明（每项的分母怎么算）" name="defs">
          <ul class="def-list">
            <li v-for="(text, key) in m3.definitions" :key="key">
              <span class="def-key">{{ key }}</span>
              {{ text }}
            </li>
          </ul>
        </el-collapse-item>
      </el-collapse>
    </el-card>
  </div>
</template>

<style scoped>
.stat-card {
  margin-bottom: 16px;
  text-align: center;
}

.m1-card {
  margin-top: 16px;
}

.space-cell {
  line-height: 1.5;
}

.space-name {
  font-size: 14px;
  color: #303133;
}

.space-code {
  font-size: 12px;
  color: #909399;
}

.m3-card {
  margin-top: 16px;
}

.m3-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.m3-range {
  font-size: 12px;
  color: #909399;
}

.m3-kpi {
  margin-bottom: 8px;
}

.kpi-box {
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 14px 10px;
  text-align: center;
  background: #fafafa;
}

.kpi-value {
  font-size: 22px;
  font-weight: 600;
  color: #303133;
  line-height: 1.2;
}

.kpi-value.warn {
  color: #e6a23c;
}

.kpi-label {
  font-size: 13px;
  color: #606266;
  margin-top: 4px;
}

.kpi-note {
  font-size: 11px;
  color: #a8abb2;
  margin-top: 2px;
}

.m3-subtitle {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
  margin: 8px 0;
}

.m3-defs {
  margin-top: 12px;
}

.def-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: #606266;
  line-height: 1.8;
}

.def-key {
  color: #909399;
  margin-right: 6px;
}
</style>
