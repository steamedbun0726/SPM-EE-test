<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { history, rebook } from '@/api/m1'
import type { Reservation, ReservationStatus } from '@/api/types'

const statusMap: Record<ReservationStatus, { label: string; type: string }> = {
  booked: { label: '已预约', type: 'primary' },
  checked_in: { label: '已签到', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
  no_show: { label: '违约', type: 'danger' },
  completed: { label: '已完成', type: 'warning' },
}

const PAGE_SIZE = 10 // 后端固定分页大小
const loading = ref(false)
const list = ref<Reservation[]>([])
const total = ref(0)
const page = ref(1)

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function slotText(r: Reservation) {
  return `${pad(r.startHour)}:00 - ${pad(r.endHour)}:00`
}

async function load() {
  loading.value = true
  try {
    // 后端返回 { items, total } 分页结构
    const res = (await history({ page: page.value })) as unknown as { items: Reservation[]; total: number }
    list.value = res.items
    total.value = res.total
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    loading.value = false
  }
}

async function handleRebook(row: Reservation) {
  try {
    await ElMessageBox.confirm(
      `按原座位（${row.spaceName} ${row.seatNo}）与时段（${row.date} ${slotText(row)}）再次预约？`,
      '再次预约',
      { type: 'info', confirmButtonText: '再次预约' },
    )
  } catch {
    return
  }
  try {
    await rebook(row.id)
    ElMessage.success('已重新预约，可在“我的预约”中查看')
    load()
  } catch {
    /* 拦截器已统一提示 */
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">预约历史</h2>
      <p class="page-desc">历史预约记录（已完成 / 已取消 / 违约），可一键复用原座位与原时段</p>
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="spaceName" label="空间" min-width="150" />
        <el-table-column prop="seatNo" label="座位" width="80" />
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column label="时段" width="120">
          <template #default="{ row }">{{ slotText(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusMap[row.status as ReservationStatus].type" size="small">
              {{ statusMap[row.status as ReservationStatus].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" link @click="handleRebook(row)">再次预约</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无历史记录" :image-size="70" />
        </template>
      </el-table>

      <el-pagination
        class="pager"
        background
        layout="total, prev, pager, next"
        :total="total"
        :page-size="PAGE_SIZE"
        :current-page="page"
        @current-change="(p: number) => { page = p; load() }"
      />
    </el-card>
  </div>
</template>

<style scoped>
.page-header {
  margin-bottom: 14px;
}

.page-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: #303133;
}

.page-desc {
  margin: 4px 0 0;
  font-size: 13px;
  color: #909399;
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
</style>
