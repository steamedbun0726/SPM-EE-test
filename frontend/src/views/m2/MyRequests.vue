<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { mine, cancel, approvals } from '@/api/m2'
import type { ApprovalRecord, RoomBookingRequest, RoomRequestStatus } from '@/api/types'

const statusMap: Record<RoomRequestStatus, { label: string; type: string }> = {
  pending: { label: '待审批', type: 'warning' },
  approved: { label: '已通过', type: 'success' },
  rejected: { label: '已驳回', type: 'danger' },
  cancelled: { label: '已撤销', type: 'info' },
  expired: { label: '已超时', type: 'danger' },
}

const loading = ref(false)
const list = ref<RoomBookingRequest[]>([])

// 详情弹窗
const detailVisible = ref(false)
const detail = ref<RoomBookingRequest | null>(null)
const approvalList = ref<ApprovalRecord[]>([])
const approvalLoading = ref(false)

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function slotText(r: RoomBookingRequest) {
  return `${pad(r.startHour)}:00 - ${pad(r.endHour)}:00`
}

function formatTime(value: string | Date | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function timelineType(a: ApprovalRecord): 'success' | 'danger' {
  return a.action === 'approve' ? 'success' : 'danger'
}

function timelineText(a: ApprovalRecord) {
  return a.action === 'approve' ? '通过' : '驳回'
}

async function load() {
  loading.value = true
  try {
    list.value = await mine()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    loading.value = false
  }
}

async function handleCancel(row: RoomBookingRequest) {
  try {
    await ElMessageBox.confirm(
      `确认撤销申请单 ${row.requestCode}（${row.spaceName} ${row.date} ${slotText(row)}）？`,
      '撤销申请',
      { type: 'warning', confirmButtonText: '确认撤销' },
    )
  } catch {
    return
  }
  try {
    await cancel(row.id)
    ElMessage.success('已撤销申请')
    load()
  } catch {
    /* 拦截器已统一提示 */
  }
}

async function openDetail(row: RoomBookingRequest) {
  detail.value = row
  detailVisible.value = true
  approvalLoading.value = true
  approvalList.value = []
  try {
    approvalList.value = await approvals(row.id)
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    approvalLoading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">我的申请</h2>
      <p class="page-desc">查看整教室申请进度与审批记录，待审批申请可撤销</p>
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="requestCode" label="申请单号" width="150" />
        <el-table-column prop="spaceName" label="教室" min-width="140" />
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column label="时段" width="120">
          <template #default="{ row }">{{ slotText(row) }}</template>
        </el-table-column>
        <el-table-column prop="purpose" label="用途" min-width="140" show-overflow-tooltip />
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusMap[row.status as RoomRequestStatus].type" size="small">
              {{ statusMap[row.status as RoomRequestStatus].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="审批层级" width="90">
          <template #default="{ row }">{{ row.currentLevel }} / {{ row.maxLevel }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'pending'" type="danger" size="small" link @click="handleCancel(row)">
              撤销
            </el-button>
            <el-button type="primary" size="small" link @click="openDetail(row)">详情</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无申请记录" :image-size="70" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="detailVisible" title="申请详情与审批记录" width="600">
      <el-descriptions v-if="detail" :column="2" border class="detail-desc">
        <el-descriptions-item label="申请单号">{{ detail.requestCode }}</el-descriptions-item>
        <el-descriptions-item label="教室">{{ detail.spaceName }}</el-descriptions-item>
        <el-descriptions-item label="日期">{{ detail.date }}</el-descriptions-item>
        <el-descriptions-item label="时段">{{ slotText(detail) }}</el-descriptions-item>
        <el-descriptions-item label="用途" :span="2">{{ detail.purpose || '-' }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="statusMap[detail.status].type" size="small">{{ statusMap[detail.status].label }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="审批层级">{{ detail.currentLevel }} / {{ detail.maxLevel }}</el-descriptions-item>
        <el-descriptions-item label="驳回原因" :span="2">{{ detail.rejectReason || '-' }}</el-descriptions-item>
        <el-descriptions-item label="提交时间" :span="2">{{ formatTime(detail.createdAt) }}</el-descriptions-item>
      </el-descriptions>

      <el-divider content-position="left">审批记录</el-divider>
      <div v-loading="approvalLoading" class="approval-panel">
        <el-timeline v-if="approvalList.length">
          <el-timeline-item
            v-for="a in approvalList"
            :key="a.id"
            :timestamp="formatTime(a.createdAt)"
            :type="timelineType(a)"
          >
            <b>{{ a.approverName }}</b> · 第 {{ a.level }} 级 · {{ timelineText(a) }}
            <div v-if="a.comment" class="approval-comment">意见：{{ a.comment }}</div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="暂无审批记录" :image-size="60" />
      </div>
    </el-dialog>
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

.detail-desc {
  margin-bottom: 4px;
}

.approval-panel {
  min-height: 80px;
}

.approval-comment {
  font-size: 13px;
  color: #606266;
  margin-top: 4px;
}
</style>
