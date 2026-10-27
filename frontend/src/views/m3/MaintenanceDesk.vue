<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { assignments, start, complete, updateEta } from '@/api/m3'
import { useWorkOrderMeta } from '@/composables/useWorkOrderMeta'
import type { WorkOrder, WorkOrderStatus } from '@/api/types'

const { ensureLoaded: ensureMeta, categoryLabel, priorityLabel } = useWorkOrderMeta()

const statusMap: Record<WorkOrderStatus, { label: string; type: string }> = {
  reported: { label: '待派单', type: 'warning' },
  dispatched: { label: '已派单', type: 'primary' },
  in_progress: { label: '维修中', type: 'success' },
  completed: { label: '待验收', type: 'warning' },
  accepted: { label: '已验收', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
}

const loading = ref(false)
const list = ref<WorkOrder[]>([])
const operating = ref(false)

function formatTime(value: string | Date | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

async function load() {
  loading.value = true
  try {
    list.value = await assignments()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    loading.value = false
  }
}

async function handleStart(row: WorkOrder) {
  try {
    await ElMessageBox.confirm(`确认接单并开始维修工单 ${row.workOrderNo}（${row.title}）？`, '接单', {
      type: 'info',
      confirmButtonText: '确认接单',
    })
  } catch {
    return
  }
  operating.value = true
  try {
    await start(row.id)
    ElMessage.success('已接单，开始维修')
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    operating.value = false
  }
}

const etaVisible = ref(false)
const etaTarget = ref<WorkOrder | null>(null)
const etaValue = ref('')

function openEta(row: WorkOrder) {
  etaTarget.value = row
  etaValue.value = row.etaAt ? new Date(row.etaAt).toISOString() : ''
  etaVisible.value = true
}

async function submitEta() {
  if (!etaTarget.value || !etaValue.value) {
    ElMessage.warning('请选择预计恢复时间')
    return
  }
  operating.value = true
  try {
    await updateEta(etaTarget.value.id, new Date(etaValue.value).toISOString())
    ElMessage.success('预计恢复时间已更新，已通知上报人')
    etaVisible.value = false
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    operating.value = false
  }
}

async function handleComplete(row: WorkOrder) {
  try {
    await ElMessageBox.confirm(`确认工单 ${row.workOrderNo}（${row.title}）已维修完成？`, '完工', {
      type: 'info',
      confirmButtonText: '确认完工',
    })
  } catch {
    return
  }
  operating.value = true
  try {
    await complete(row.id)
    ElMessage.success('已提交完工，等待上报人验收')
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    operating.value = false
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
      <h2 class="page-title">维修台</h2>
      <p class="page-desc">分派给我的工单：接单开始维修，维修完成后提交完工待验收</p>
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
        <el-table-column label="SLA 截止" width="170">
          <template #default="{ row }">{{ formatTime(row.slaDeadline) }}</template>
        </el-table-column>
        <el-table-column label="预计恢复" width="170">
          <template #default="{ row }">{{ formatTime(row.etaAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="170" fixed="right">
          <template #default="{ row }">
            <el-button v-if="row.status === 'dispatched'" type="success" size="small" :loading="operating" @click="handleStart(row)">
              接单
            </el-button>
            <el-button v-else-if="row.status === 'in_progress'" type="primary" size="small" :loading="operating" @click="handleComplete(row)">
              完工
            </el-button>
            <el-button
              v-if="row.status === 'dispatched' || row.status === 'in_progress'"
              link
              type="primary"
              size="small"
              @click="openEta(row)"
            >
              预计恢复
            </el-button>
            <span v-if="row.status !== 'dispatched' && row.status !== 'in_progress'" class="muted">-</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无分派给你的工单" :image-size="70" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="etaVisible" title="设置预计恢复时间" width="380px">
      <el-date-picker v-model="etaValue" type="datetime" placeholder="选择预计恢复时间" style="width: 100%" />
      <template #footer>
        <el-button @click="etaVisible = false">取消</el-button>
        <el-button type="primary" :loading="operating" @click="submitEta">保存并通知</el-button>
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

.muted {
  color: #c0c4cc;
}
</style>
