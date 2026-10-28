<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { listUsers } from '@/api/admin'
import { pending, dispatch, holds, confirmHold, resume } from '@/api/m3'
import { useWorkOrderMeta } from '@/composables/useWorkOrderMeta'
import type { User, WorkOrder } from '@/api/types'

const { ensureLoaded: ensureMeta, categoryLabel, priorityLabel } = useWorkOrderMeta()

const loading = ref(false)
const list = ref<WorkOrder[]>([])

const users = ref<User[]>([])

// 挂起管理（M3-14）：待确认申请 / 挂起中
const holdRequests = ref<WorkOrder[]>([])
const holding = ref<WorkOrder[]>([])
const holdTab = ref('requests')

// 派单弹窗
const dispatchVisible = ref(false)
const dispatchTarget = ref<WorkOrder | null>(null)
const assigneeId = ref<number>()
const submitting = ref(false)

function formatTime(value: string | Date | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

/** 挂起时长展示 */
function formatHold(minutes: number) {
  if (!minutes) return '-'
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
}

/** 优先展示维修员角色用户，无角色信息时展示全部用户 */
const maintainers = computed(() => {
  const withRole = users.value.filter((u) => (u.roles ?? []).some((r) => r.code === 'maintenance'))
  return withRole.length ? withRole : users.value
})

function userLabel(u: User) {
  return `${u.name}（${u.username}${u.department ? ` · ${u.department}` : ''}）`
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
  loadHolds()
}

async function loadHolds() {
  try {
    const data = await holds()
    holdRequests.value = data.requests
    holding.value = data.onHold
  } catch {
    holdRequests.value = []
    holding.value = []
  }
}

async function loadUsers() {
  try {
    const res = await listUsers({ page: 1, pageSize: 100 })
    users.value = res.items
  } catch {
    users.value = []
  }
}

function openDispatch(row: WorkOrder) {
  dispatchTarget.value = row
  assigneeId.value = undefined
  dispatchVisible.value = true
  if (!users.value.length) loadUsers()
}

async function confirmDispatch() {
  if (!dispatchTarget.value) return
  if (!assigneeId.value) {
    ElMessage.warning('请选择维修员')
    return
  }
  submitting.value = true
  try {
    await dispatch(dispatchTarget.value.id, { assigneeId: assigneeId.value })
    ElMessage.success('已派单，等待维修员接单')
    dispatchVisible.value = false
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    submitting.value = false
  }
}

/** 同意挂起：确认后状态置 on_hold，SLA 从此暂停 */
async function approveHold(row: WorkOrder) {
  try {
    await ElMessageBox.confirm(
      `确认挂起工单 ${row.workOrderNo}？确认后 SLA 计时暂停，座位保持下架。原因：${row.holdReason || '未填写'}`,
      '确认挂起',
      { type: 'warning', confirmButtonText: '同意挂起' },
    )
  } catch {
    return
  }
  submitting.value = true
  try {
    await confirmHold(row.id, true)
    ElMessage.success('已同意挂起，SLA 暂停计时')
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    submitting.value = false
  }
}

/** 驳回挂起：必须给理由，否则维修员不知道该怎么办 */
async function rejectHold(row: WorkOrder) {
  let note = ''
  try {
    const res = await ElMessageBox.prompt(
      `驳回工单 ${row.workOrderNo} 的挂起申请，请说明原因（如：配件已到货）`,
      '驳回挂起',
      { type: 'warning', confirmButtonText: '驳回', inputPlaceholder: '驳回原因' },
    )
    note = res.value ?? ''
  } catch {
    return
  }
  submitting.value = true
  try {
    await confirmHold(row.id, false, note || undefined)
    ElMessage.success('已驳回挂起申请')
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    submitting.value = false
  }
}

/** 派单员强制恢复（维修员忘了点恢复时的兜底） */
async function handleResume(row: WorkOrder) {
  try {
    await ElMessageBox.confirm(
      `确认恢复工单 ${row.workOrderNo}？解决时限将按已挂起时长（${formatHold(row.holdMinutes)}）顺延。`,
      '恢复维修',
      { type: 'info', confirmButtonText: '确认恢复' },
    )
  } catch {
    return
  }
  submitting.value = true
  try {
    await resume(row.id)
    ElMessage.success('已恢复，时限已顺延')
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  ensureMeta()
  load()
})
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">派单台</h2>
      <p class="page-desc">处理待派单的报修工单，指派维修员；SLA 超时会自动升级</p>
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="workOrderNo" label="工单号" width="150" />
        <el-table-column prop="title" label="标题" min-width="160" show-overflow-tooltip />
        <el-table-column label="分类" width="110">
          <template #default="{ row }">{{ categoryLabel(row.category) }}</template>
        </el-table-column>
        <el-table-column label="紧急程度" width="90">
          <template #default="{ row }">{{ priorityLabel(row.priority) }}</template>
        </el-table-column>
        <el-table-column label="升级层级" width="90">
          <template #default="{ row }">{{ row.escalateLevel }}</template>
        </el-table-column>
        <el-table-column label="上报时间" width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="SLA 截止" width="170">
          <template #default="{ row }">{{ formatTime(row.slaDeadline) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" @click="openDispatch(row)">派单</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="当前没有待派单的工单" :image-size="70" />
        </template>
      </el-table>
    </el-card>

    <el-card shadow="never" class="hold-card">
      <template #header>
        <div class="card-header">
          <span>挂起管理</span>
          <span class="card-sub">维修员申请挂起需经确认，确认后 SLA 才暂停计时</span>
        </div>
      </template>
      <el-tabs v-model="holdTab">
        <el-tab-pane :label="`待确认（${holdRequests.length}）`" name="requests">
          <el-table :data="holdRequests" stripe>
            <el-table-column prop="workOrderNo" label="工单号" width="150" />
            <el-table-column prop="title" label="标题" min-width="140" show-overflow-tooltip />
            <el-table-column label="分类" width="100">
              <template #default="{ row }">{{ categoryLabel(row.category) }}</template>
            </el-table-column>
            <el-table-column label="挂起原因" min-width="150" show-overflow-tooltip>
              <template #default="{ row }">{{ row.holdReason || '-' }}</template>
            </el-table-column>
            <el-table-column label="申请时间" width="160">
              <template #default="{ row }">{{ formatTime(row.holdRequestedAt) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button type="warning" size="small" :loading="submitting" @click="approveHold(row)">
                  同意
                </el-button>
                <el-button link type="danger" size="small" :loading="submitting" @click="rejectHold(row)">
                  驳回
                </el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="没有待确认的挂起申请" :image-size="60" />
            </template>
          </el-table>
        </el-tab-pane>
        <el-tab-pane :label="`挂起中（${holding.length}）`" name="holding">
          <el-table :data="holding" stripe>
            <el-table-column prop="workOrderNo" label="工单号" width="150" />
            <el-table-column prop="title" label="标题" min-width="140" show-overflow-tooltip />
            <el-table-column label="挂起原因" min-width="150" show-overflow-tooltip>
              <template #default="{ row }">{{ row.holdReason || '-' }}</template>
            </el-table-column>
            <el-table-column label="已挂起" width="120">
              <template #default="{ row }">{{ formatHold(row.holdMinutes) }}</template>
            </el-table-column>
            <el-table-column label="开始挂起" width="160">
              <template #default="{ row }">{{ formatTime(row.onHoldSince) }}</template>
            </el-table-column>
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button size="small" :loading="submitting" @click="handleResume(row)">恢复</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="当前没有挂起中的工单" :image-size="60" />
            </template>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <el-dialog v-model="dispatchVisible" title="派单" width="460">
      <el-alert
        v-if="dispatchTarget"
        type="info"
        :closable="false"
        show-icon
        class="dialog-tip"
        :title="`工单 ${dispatchTarget.workOrderNo}（${dispatchTarget.title}）`"
        :description="dispatchTarget.description || '（无详细描述）'"
      />
      <el-form label-width="70px" class="dialog-form">
        <el-form-item label="维修员" required>
          <el-select v-model="assigneeId" placeholder="请选择维修员" style="width: 100%" filterable>
            <el-option v-for="u in maintainers" :key="u.id" :label="userLabel(u)" :value="u.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dispatchVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirmDispatch">确认派单</el-button>
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

.dialog-tip {
  margin-bottom: 16px;
}

.hold-card {
  margin-top: 16px;
}

.card-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.card-sub {
  font-size: 12px;
  color: #909399;
}
</style>
