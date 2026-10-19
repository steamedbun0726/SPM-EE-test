<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { mine, accept, cancel } from '@/api/m3'
import type { WorkOrder, WorkOrderStatus, WorkOrderTargetType } from '@/api/types'

const statusMap: Record<WorkOrderStatus, { label: string; type: string }> = {
  reported: { label: '待派单', type: 'warning' },
  dispatched: { label: '已派单', type: 'primary' },
  in_progress: { label: '维修中', type: 'success' },
  completed: { label: '待验收', type: 'warning' },
  accepted: { label: '已验收', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
}

const targetTypeMap: Record<WorkOrderTargetType, string> = {
  space: '空间',
  seat: '座位',
  other: '其他位置',
}

const loading = ref(false)
const list = ref<WorkOrder[]>([])

// 验收弹窗
const acceptVisible = ref(false)
const acceptTarget = ref<WorkOrder | null>(null)
const rating = ref(5)
const comment = ref('')
const submitting = ref(false)

// 取消弹窗
const cancelVisible = ref(false)
const cancelTarget = ref<WorkOrder | null>(null)
const cancelReason = ref('')

// 详情弹窗
const detailVisible = ref(false)
const detail = ref<WorkOrder | null>(null)

function formatTime(value: string | Date | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function targetText(w: WorkOrder) {
  return `${targetTypeMap[w.targetType]}#${w.targetId ?? '-'}`
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

function openAccept(row: WorkOrder) {
  acceptTarget.value = row
  rating.value = 5
  comment.value = ''
  acceptVisible.value = true
}

async function confirmAccept() {
  if (!acceptTarget.value) return
  submitting.value = true
  try {
    await accept(acceptTarget.value.id, { rating: rating.value, comment: comment.value.trim() || undefined })
    ElMessage.success('验收完成，感谢您的评价')
    acceptVisible.value = false
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    submitting.value = false
  }
}

function openCancel(row: WorkOrder) {
  cancelTarget.value = row
  cancelReason.value = ''
  cancelVisible.value = true
}

async function confirmCancel() {
  if (!cancelTarget.value) return
  if (!cancelReason.value.trim()) {
    ElMessage.warning('请填写取消原因')
    return
  }
  submitting.value = true
  try {
    await cancel(cancelTarget.value.id, { reason: cancelReason.value.trim() })
    ElMessage.success('工单已取消')
    cancelVisible.value = false
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    submitting.value = false
  }
}

function openDetail(row: WorkOrder) {
  detail.value = row
  detailVisible.value = true
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">我的工单</h2>
      <p class="page-desc">跟踪报修工单流转；完工后可验收评分，待派单/已派单可取消</p>
    </div>

    <el-card shadow="never">
      <el-table
        v-loading="loading"
        :data="list"
        stripe
        class="clickable-table"
        @row-click="openDetail"
      >
        <el-table-column prop="workOrderNo" label="工单号" width="150" />
        <el-table-column prop="title" label="标题" min-width="150" show-overflow-tooltip />
        <el-table-column label="对象" width="100">
          <template #default="{ row }">{{ targetText(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusMap[row.status as WorkOrderStatus].type" size="small">
              {{ statusMap[row.status as WorkOrderStatus].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="升级层级" width="90">
          <template #default="{ row }">{{ row.escalateLevel }}</template>
        </el-table-column>
        <el-table-column label="上报时间" width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'completed'" type="success" size="small" @click.stop="openAccept(row)">
              验收评价
            </el-button>
            <el-button
              v-else-if="row.status === 'reported' || row.status === 'dispatched'"
              type="danger"
              size="small"
              link
              @click.stop="openCancel(row)"
            >
              取消
            </el-button>
            <el-button type="primary" size="small" link @click.stop="openDetail(row)">详情</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无报修工单" :image-size="70" />
        </template>
      </el-table>
    </el-card>

    <!-- 验收评价弹窗 -->
    <el-dialog v-model="acceptVisible" title="验收评价" width="440">
      <el-alert
        v-if="acceptTarget"
        type="success"
        :closable="false"
        show-icon
        class="dialog-tip"
        :title="`工单 ${acceptTarget.workOrderNo}（${acceptTarget.title}）已维修完成，请验收`"
      />
      <el-form label-width="70px" class="dialog-form">
        <el-form-item label="服务评分">
          <el-rate v-model="rating" :max="5" show-text />
        </el-form-item>
        <el-form-item label="评语">
          <el-input
            v-model="comment"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            placeholder="对维修服务的评价（选填）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="acceptVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirmAccept">确认验收</el-button>
      </template>
    </el-dialog>

    <!-- 取消工单弹窗 -->
    <el-dialog v-model="cancelVisible" title="取消工单" width="440">
      <el-alert
        v-if="cancelTarget"
        type="warning"
        :closable="false"
        show-icon
        class="dialog-tip"
        :title="`确认取消工单 ${cancelTarget.workOrderNo}？`"
      />
      <el-form label-width="70px" class="dialog-form">
        <el-form-item label="取消原因" required>
          <el-input
            v-model="cancelReason"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            placeholder="请填写取消原因"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="cancelVisible = false">返回</el-button>
        <el-button type="danger" :loading="submitting" @click="confirmCancel">确认取消</el-button>
      </template>
    </el-dialog>

    <!-- 详情弹窗 -->
    <el-dialog v-model="detailVisible" title="工单详情" width="640">
      <el-descriptions v-if="detail" :column="2" border>
        <el-descriptions-item label="工单号">{{ detail.workOrderNo }}</el-descriptions-item>
        <el-descriptions-item label="标题">{{ detail.title }}</el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="statusMap[detail.status].type" size="small">{{ statusMap[detail.status].label }}</el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="紧急程度">{{ detail.priority }}</el-descriptions-item>
        <el-descriptions-item label="对象类型">{{ targetTypeMap[detail.targetType] }}</el-descriptions-item>
        <el-descriptions-item label="对象">{{ targetText(detail) }}</el-descriptions-item>
        <el-descriptions-item label="分类">{{ detail.category || '-' }}</el-descriptions-item>
        <el-descriptions-item label="升级层级">{{ detail.escalateLevel }}</el-descriptions-item>
        <el-descriptions-item label="SLA 截止" :span="2">{{ formatTime(detail.slaDeadline) }}</el-descriptions-item>
        <el-descriptions-item label="描述" :span="2">{{ detail.description || '-' }}</el-descriptions-item>
        <el-descriptions-item label="上报时间">{{ formatTime(detail.createdAt) }}</el-descriptions-item>
        <el-descriptions-item label="派单时间">{{ formatTime(detail.dispatchedAt) }}</el-descriptions-item>
        <el-descriptions-item label="开始维修">{{ formatTime(detail.inProgressAt) }}</el-descriptions-item>
        <el-descriptions-item label="完工时间">{{ formatTime(detail.completedAt) }}</el-descriptions-item>
        <el-descriptions-item label="验收时间">{{ formatTime(detail.acceptedAt) }}</el-descriptions-item>
        <el-descriptions-item label="评分">{{ detail.rating ?? '-' }}</el-descriptions-item>
        <el-descriptions-item label="评价">{{ detail.ratingComment || '-' }}</el-descriptions-item>
        <el-descriptions-item label="取消原因" :span="2">{{ detail.cancelReason || '-' }}</el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button type="primary" @click="detailVisible = false">关闭</el-button>
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

.clickable-table :deep(.el-table__row) {
  cursor: pointer;
}

.dialog-tip {
  margin-bottom: 16px;
}
</style>
