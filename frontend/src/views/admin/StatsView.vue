<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { listSpaces, occupancyStats } from '@/api/admin'
import { stats as m1Stats } from '@/api/m1'
import type { Space } from '@/api/types'

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

const totalSeats = computed(() => spaces.value.reduce((sum, s) => sum + s.seatCount, 0))
const bookedTotal = computed(() => rows.value.reduce((sum, r) => sum + r.bookedNow, 0))

/** 可用座位 = 启用座位 - 维修中 - 整教室占用 */
function availableSeats(r: OccupancyRow) {
  return Math.max(0, r.activeSeats - r.maintenanceSeats - r.occupiedByRoom)
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

onMounted(load)
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
</style>
