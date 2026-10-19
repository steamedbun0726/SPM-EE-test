<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { pending, approve, reject } from '@/api/m2'
import type { RoomBookingRequest } from '@/api/types'

const loading = ref(false)
const list = ref<RoomBookingRequest[]>([])

// 驳回弹窗
const rejectVisible = ref(false)
const rejectTarget = ref<RoomBookingRequest | null>(null)
const rejectComment = ref('')
const submitting = ref(false)

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function slotText(r: RoomBookingRequest) {
  return `${pad(r.startHour)}:00 - ${pad(r.endHour)}:00`
}

async function load() {
  loading.value = true
  try {
    list.value = await pending()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    loading.value = false
  }
}

async function handleApprove(row: RoomBookingRequest) {
  try {
    await ElMessageBox.confirm(
      `确认通过 ${row.spaceName}（${row.date} ${slotText(row)}）的申请？通过后该时段全部座位将被占用。`,
      '审批通过',
      { type: 'warning', confirmButtonText: '确认通过' },
    )
  } catch {
    return
  }
  try {
    await approve(row.id)
    ElMessage.success('已通过，该时段座位已占用')
    load()
  } catch {
    /* 拦截器已统一提示 */
  }
}

function openReject(row: RoomBookingRequest) {
  rejectTarget.value = row
  rejectComment.value = ''
  rejectVisible.value = true
}

async function confirmReject() {
  if (!rejectTarget.value) return
  if (!rejectComment.value.trim()) {
    ElMessage.warning('请填写驳回意见')
    return
  }
  submitting.value = true
  try {
    await reject(rejectTarget.value.id, { comment: rejectComment.value.trim() })
    ElMessage.success('已驳回该申请')
    rejectVisible.value = false
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    submitting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">教室审批</h2>
      <p class="page-desc">多级审批队列：通过后占用该时段座位，驳回需填写意见</p>
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
        <el-table-column label="审批层级" width="90">
          <template #default="{ row }">{{ row.currentLevel }} / {{ row.maxLevel }}</template>
        </el-table-column>
        <el-table-column label="操作" width="140" fixed="right">
          <template #default="{ row }">
            <el-button type="success" size="small" @click="handleApprove(row)">通过</el-button>
            <el-button type="danger" size="small" @click="openReject(row)">驳回</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="当前没有待审批的申请" :image-size="70" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="rejectVisible" title="驳回申请" width="440">
      <el-alert
        v-if="rejectTarget"
        type="warning"
        :closable="false"
        show-icon
        class="reject-tip"
        :title="`申请单 ${rejectTarget.requestCode}：${rejectTarget.spaceName}（${rejectTarget.date} ${slotText(rejectTarget)}）`"
      />
      <el-form label-width="70px" class="reject-form">
        <el-form-item label="驳回意见" required>
          <el-input
            v-model="rejectComment"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            placeholder="请填写驳回原因，将通知申请人"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="confirmReject">确认驳回</el-button>
      </template>
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

.reject-tip {
  margin-bottom: 16px;
}
</style>
