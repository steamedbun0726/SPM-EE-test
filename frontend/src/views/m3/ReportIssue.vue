<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { listSpaces, listSpaceSeats } from '@/api/admin'
import { report } from '@/api/m3'
import type { ReportWorkOrderParams, Seat, Space, WorkOrderPriority, WorkOrderTargetType } from '@/api/types'

const priorityOptions: { label: string; value: WorkOrderPriority }[] = [
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
  { label: '紧急', value: 'urgent' },
]

const categoryOptions = ['照明', '空调', '桌椅', '门窗', '水电', '网络', '卫生', '其他']

const targetTypeOptions: { label: string; value: WorkOrderTargetType }[] = [
  { label: '空间（自习室/教室）', value: 'space' },
  { label: '座位', value: 'seat' },
  { label: '其他位置', value: 'other' },
]

const loading = ref(false)
const submitting = ref(false)
const spaces = ref<Space[]>([])
const seatOptions = ref<Seat[]>([])

const form = reactive({
  title: '',
  description: '',
  category: '照明',
  priority: 'medium' as WorkOrderPriority,
  targetType: 'space' as WorkOrderTargetType,
  spaceId: undefined as number | undefined,
  seatId: undefined as number | undefined,
  location: '',
})

async function loadSpaces() {
  loading.value = true
  try {
    spaces.value = await listSpaces()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    loading.value = false
  }
}

async function loadSeats(spaceId: number) {
  try {
    seatOptions.value = await listSpaceSeats(spaceId)
    if (!seatOptions.value.some((s) => s.id === form.seatId)) form.seatId = undefined
  } catch {
    seatOptions.value = []
  }
}

watch(
  () => form.targetType,
  (t) => {
    if (t === 'seat' && form.spaceId) loadSeats(form.spaceId)
  },
)

watch(
  () => form.spaceId,
  (id) => {
    if (form.targetType === 'seat' && id) loadSeats(id)
  },
)

function seatLabel(s: Seat) {
  return `${s.seatNo}${s.hasSocket ? '（有插座）' : ''}`
}

async function submit() {
  if (!form.title.trim()) {
    ElMessage.warning('请填写标题')
    return
  }
  if (form.targetType === 'space' && !form.spaceId) {
    ElMessage.warning('请选择报修空间')
    return
  }
  if (form.targetType === 'seat') {
    if (!form.spaceId) {
      ElMessage.warning('请先选择空间')
      return
    }
    if (!form.seatId) {
      ElMessage.warning('请选择座位')
      return
    }
  }
  if (form.targetType === 'other' && !form.location.trim()) {
    ElMessage.warning('请填写故障位置')
    return
  }

  submitting.value = true
  try {
    const payload: ReportWorkOrderParams = {
      title: form.title.trim(),
      description: form.description.trim() || undefined,
      category: form.category,
      priority: form.priority,
      targetType: form.targetType,
    }
    if (form.targetType === 'space') {
      payload.targetId = form.spaceId
      payload.spaceId = form.spaceId
    } else if (form.targetType === 'seat') {
      const seat = seatOptions.value.find((s) => s.id === form.seatId)
      payload.targetId = form.seatId
      payload.spaceId = seat?.spaceId ?? form.spaceId
    } else {
      const location = form.location.trim() ? `位置：${form.location.trim()}` : ''
      payload.description = [location, payload.description ?? ''].filter(Boolean).join('\n') || undefined
    }

    await report(payload)
    ElMessage.success('报修已提交，维修人员将尽快处理')
    form.title = ''
    form.description = ''
    form.location = ''
    form.seatId = undefined
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    submitting.value = false
  }
}

onMounted(loadSpaces)
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">故障上报</h2>
      <p class="page-desc">上报设施故障，物业将派单维修并在完成后通知验收</p>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="tip-alert"
      title="说明"
      description="若报修对象为自习室/教室，维修期间该室座位将自动下架（不可预约），待工单验收或取消后自动恢复。"
    />

    <el-card shadow="never" class="form-card" v-loading="loading">
      <el-form label-width="90px" :model="form" class="report-form">
        <el-form-item label="标题" required>
          <el-input
            v-model="form.title"
            maxlength="50"
            show-word-limit
            placeholder="简要描述故障，如：3 号空调不制冷"
            style="width: 420px"
          />
        </el-form-item>
        <el-form-item label="详细描述">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="3"
            maxlength="300"
            show-word-limit
            placeholder="故障现象、发生时间等补充信息"
            style="width: 420px"
          />
        </el-form-item>
        <el-form-item label="紧急程度">
          <el-radio-group v-model="form.priority">
            <el-radio-button v-for="p in priorityOptions" :key="p.value" :value="p.value">
              {{ p.label }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="报修对象">
          <el-radio-group v-model="form.targetType">
            <el-radio-button v-for="t in targetTypeOptions" :key="t.value" :value="t.value">
              {{ t.label }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>

        <template v-if="form.targetType === 'space'">
          <el-form-item label="报修空间" required>
            <el-select v-model="form.spaceId" placeholder="请选择空间" style="width: 320px" filterable>
              <el-option v-for="s in spaces" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
          </el-form-item>
        </template>

        <template v-else-if="form.targetType === 'seat'">
          <el-form-item label="所在空间" required>
            <el-select v-model="form.spaceId" placeholder="请先选择空间" style="width: 320px" filterable>
              <el-option v-for="s in spaces" :key="s.id" :label="s.name" :value="s.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="座位" required>
            <el-select v-model="form.seatId" placeholder="请选择座位" style="width: 320px" filterable>
              <el-option v-for="s in seatOptions" :key="s.id" :label="seatLabel(s)" :value="s.id" />
            </el-select>
          </el-form-item>
        </template>

        <template v-else>
          <el-form-item label="故障位置" required>
            <el-input
              v-model="form.location"
              maxlength="100"
              placeholder="如：图书馆 A101 进门右手第三排走廊"
              style="width: 420px"
            />
          </el-form-item>
        </template>

        <el-form-item label="分类">
          <el-select v-model="form.category" style="width: 200px">
            <el-option v-for="c in categoryOptions" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="submitting" @click="submit">提交报修</el-button>
        </el-form-item>
      </el-form>
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

.form-card {
  max-width: 680px;
}
</style>
