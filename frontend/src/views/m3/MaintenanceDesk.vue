<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  assignments,
  start,
  complete,
  updateEta,
  requestHold,
  resume,
} from '@/api/m3'
import { useWorkOrderMeta } from '@/composables/useWorkOrderMeta'
import type { WorkOrder, WorkOrderStatus } from '@/api/types'

const { ensureLoaded: ensureMeta, categoryLabel, priorityLabel, meta } = useWorkOrderMeta()

const statusMap: Record<WorkOrderStatus, { label: string; type: string }> = {
  reported: { label: '待派单', type: 'warning' },
  dispatched: { label: '已派单', type: 'primary' },
  in_progress: { label: '维修中', type: 'success' },
  on_hold: { label: '已挂起', type: 'warning' },
  completed: { label: '待验收', type: 'warning' },
  accepted: { label: '已验收', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
  merged: { label: '已合并', type: 'info' },
}

const loading = ref(false)
const list = ref<WorkOrder[]>([])
const operating = ref(false)

function formatTime(value: string | Date | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

/** 挂起时长展示：不足 1 小时显示分钟 */
function formatHold(minutes: number) {
  if (!minutes) return '-'
  if (minutes < 60) return `${minutes} 分钟`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`
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

/* ===== 预计恢复时间 ===== */

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

/* ===== 完工（维修说明必填） ===== */

const completeVisible = ref(false)
const completeTarget = ref<WorkOrder | null>(null)
const completeForm = reactive({ resolutionNote: '', photoUrls: [''] })

function openComplete(row: WorkOrder) {
  completeTarget.value = row
  completeForm.resolutionNote = ''
  completeForm.photoUrls = ['']
  completeVisible.value = true
}

function addPhoto() {
  const max = meta.value?.limits.maxPhotos ?? 3
  if (completeForm.photoUrls.length >= max) {
    ElMessage.warning(`最多 ${max} 张照片`)
    return
  }
  completeForm.photoUrls.push('')
}

async function submitComplete() {
  if (!completeTarget.value) return
  if (!completeForm.resolutionNote.trim()) {
    ElMessage.warning('请填写维修说明（故障原因与处理方式），上报人验收时需要看到')
    return
  }
  const urls = completeForm.photoUrls.map((u) => u.trim()).filter(Boolean)
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/uploads/')) {
      ElMessage.warning('照片请填写 http(s) 链接或站内 /uploads/ 路径')
      return
    }
  }
  operating.value = true
  try {
    await complete(completeTarget.value.id, {
      resolutionNote: completeForm.resolutionNote.trim(),
      photoUrls: urls.length ? urls : undefined,
    })
    ElMessage.success('已提交完工，等待上报人验收')
    completeVisible.value = false
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    operating.value = false
  }
}

/* ===== 挂起申请与恢复 ===== */

const holdVisible = ref(false)
const holdTarget = ref<WorkOrder | null>(null)
const holdReason = ref('')

function openHold(row: WorkOrder) {
  holdTarget.value = row
  holdReason.value = row.holdReason || ''
  holdVisible.value = true
}

async function submitHold() {
  if (!holdTarget.value) return
  if (!holdReason.value.trim()) {
    ElMessage.warning('请填写挂起原因，如「等厂家配件」')
    return
  }
  operating.value = true
  try {
    await requestHold(holdTarget.value.id, holdReason.value.trim())
    ElMessage.success('挂起申请已提交，等待派单员确认（确认后 SLA 才暂停计时）')
    holdVisible.value = false
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    operating.value = false
  }
}

async function handleResume(row: WorkOrder) {
  try {
    await ElMessageBox.confirm(
      `确认恢复工单 ${row.workOrderNo} 的维修？解决时限将按挂起时长（${formatHold(row.holdMinutes)}）自动顺延。`,
      '恢复维修',
      { type: 'info', confirmButtonText: '确认恢复' },
    )
  } catch {
    return
  }
  operating.value = true
  try {
    await resume(row.id)
    ElMessage.success('已恢复维修，时限已顺延')
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
      <p class="page-desc">
        分派给我的工单：接单开始维修，维修完成后填写维修说明提交完工；需要等配件时可申请挂起
      </p>
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="workOrderNo" label="工单号" width="150" />
        <el-table-column prop="title" label="标题" min-width="150" show-overflow-tooltip />
        <el-table-column label="分类" width="100">
          <template #default="{ row }">{{ categoryLabel(row.category) }}</template>
        </el-table-column>
        <el-table-column label="紧急程度" width="86">
          <template #default="{ row }">{{ priorityLabel(row.priority) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="96">
          <template #default="{ row }">
            <el-tag :type="statusMap[row.status as WorkOrderStatus].type" size="small">
              {{ statusMap[row.status as WorkOrderStatus].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="挂起信息" width="170">
          <template #default="{ row }">
            <el-tag v-if="row.holdRequested" size="small" type="warning">待派单员确认</el-tag>
            <div v-else-if="row.status === 'on_hold' || row.totalHoldMinutes" class="hold-cell">
              <div>{{ row.holdReason || '未填写原因' }}</div>
              <div class="hold-time">已挂起 {{ formatHold(row.holdMinutes) }}</div>
            </div>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="SLA 截止" width="160">
          <template #default="{ row }">{{ formatTime(row.slaDeadline) }}</template>
        </el-table-column>
        <el-table-column label="预计恢复" width="160">
          <template #default="{ row }">{{ formatTime(row.etaAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'dispatched'"
              type="success"
              size="small"
              :loading="operating"
              @click="handleStart(row)"
            >
              接单
            </el-button>
            <el-button
              v-else-if="row.status === 'in_progress'"
              type="primary"
              size="small"
              :loading="operating"
              @click="openComplete(row)"
            >
              完工
            </el-button>
            <el-button
              v-else-if="row.status === 'on_hold'"
              type="warning"
              size="small"
              :loading="operating"
              @click="handleResume(row)"
            >
              恢复
            </el-button>
            <el-button
              v-if="(row.status === 'dispatched' || row.status === 'in_progress') && !row.holdRequested"
              link
              type="warning"
              size="small"
              @click="openHold(row)"
            >
              申请挂起
            </el-button>
            <el-button
              v-if="row.status === 'dispatched' || row.status === 'in_progress' || row.status === 'on_hold'"
              link
              type="primary"
              size="small"
              @click="openEta(row)"
            >
              预计恢复
            </el-button>
            <span
              v-if="row.status !== 'dispatched' && row.status !== 'in_progress' && row.status !== 'on_hold'"
              class="muted"
            >
              -
            </span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无分派给你的工单" :image-size="70" />
        </template>
      </el-table>
    </el-card>

    <!-- 完工：维修说明必填 -->
    <el-dialog v-model="completeVisible" title="提交完工" width="520px">
      <el-form label-width="88px">
        <el-form-item label="工单">
          <span>{{ completeTarget?.workOrderNo }} · {{ completeTarget?.title }}</span>
        </el-form-item>
        <el-form-item label="维修说明" required>
          <el-input
            v-model="completeForm.resolutionNote"
            type="textarea"
            :rows="4"
            maxlength="1000"
            show-word-limit
            placeholder="说明故障原因与处理方式，例如：更换镇流器 1 只，通电测试 30 分钟无闪烁。上报人验收时需要看到这段说明。"
          />
        </el-form-item>
        <el-form-item label="现场照片">
          <div class="photo-list">
            <div v-for="(_, i) in completeForm.photoUrls" :key="i" class="photo-row">
              <el-input
                v-model="completeForm.photoUrls[i]"
                placeholder="http(s) 链接或 /uploads/ 路径，可留空"
              />
              <el-button
                v-if="completeForm.photoUrls.length > 1"
                link
                type="danger"
                @click="completeForm.photoUrls.splice(i, 1)"
              >
                删除
              </el-button>
            </div>
            <el-button link type="primary" @click="addPhoto">+ 添加照片</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="completeVisible = false">取消</el-button>
        <el-button type="primary" :loading="operating" @click="submitComplete">提交完工</el-button>
      </template>
    </el-dialog>

    <!-- 挂起申请 -->
    <el-dialog v-model="holdVisible" title="申请挂起" width="460px">
      <el-alert
        title="挂起需经派单员确认后才生效，确认前 SLA 仍在计时。"
        type="info"
        :closable="false"
        show-icon
        class="hold-alert"
      />
      <el-form label-width="80px">
        <el-form-item label="挂起原因" required>
          <el-input
            v-model="holdReason"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            placeholder="例如：等厂家配件、需停电作业、需专业资质人员到场"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="holdVisible = false">取消</el-button>
        <el-button type="warning" :loading="operating" @click="submitHold">提交申请</el-button>
      </template>
    </el-dialog>

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

.hold-cell {
  line-height: 1.4;
  font-size: 12px;
  color: #606266;
}

.hold-time {
  color: #e6a23c;
}

.photo-list {
  width: 100%;
}

.photo-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 8px;
}

.hold-alert {
  margin-bottom: 14px;
}
</style>
