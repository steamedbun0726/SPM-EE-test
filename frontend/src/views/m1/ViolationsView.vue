<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { history } from '@/api/m1'
import type { Reservation } from '@/api/types'

const loading = ref(false)
const list = ref<Reservation[]>([])

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function slotText(r: Reservation) {
  return `${pad(r.startHour)}:00 - ${pad(r.endHour)}:00`
}

function formatTime(value: string | Date | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

/**
 * 违约记录：预约开始后超时未签到自动判定（no_show）。
 * 本页数据来自预约历史中 status=no_show 的记录（后端无独立违约查询接口，故拉取全部历史后过滤）。
 */
async function load() {
  loading.value = true
  try {
    let page = 1
    const all: Reservation[] = []
    let total = 1
    while (all.length < total) {
      const res = (await history({ page })) as unknown as { items: Reservation[]; total: number }
      all.push(...res.items)
      total = res.total
      if (!res.items.length) break
      page += 1
    }
    list.value = all.filter((r) => r.status === 'no_show')
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">违约记录</h2>
      <p class="page-desc">预约后未按时签到（no_show）的记录，违约将影响信用与后续预约</p>
    </div>

    <el-alert
      type="warning"
      :closable="false"
      show-icon
      class="tip-alert"
      title="数据说明"
      description="本页数据来自预约历史中状态为“违约（no_show）”的记录；预约时段开始后未签到会自动判定违约。"
    />

    <el-card shadow="never">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="spaceName" label="空间" min-width="150" />
        <el-table-column prop="seatNo" label="座位" width="80" />
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column label="时段" width="120">
          <template #default="{ row }">{{ slotText(row) }}</template>
        </el-table-column>
        <el-table-column label="判定时间" width="170">
          <template #default="{ row }">{{ formatTime(row.noShowAt) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default>
            <el-tag type="danger" size="small">违约</el-tag>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无违约记录，继续保持" :image-size="70" />
        </template>
      </el-table>
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

.tip-alert {
  margin-bottom: 14px;
}
</style>
