<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { listSpaces, listSpaceSeats } from '@/api/admin'
import { report } from '@/api/m3'
import { useWorkOrderMeta } from '@/composables/useWorkOrderMeta'
import type { ReportWorkOrderParams, Seat, Space, WorkOrderPriority, WorkOrderTargetType } from '@/api/types'

const { meta, ensureLoaded, estimateSlaHours } = useWorkOrderMeta()

const targetTypeOptions: { label: string; value: WorkOrderTargetType }[] = [
  { label: '空间（自习室/教室）', value: 'space' },
  { label: '座位', value: 'seat' },
  { label: '其他位置', value: 'other' },
]

const loading = ref(false)
const submitting = ref(false)
const spaces = ref<Space[]>([])
const seatOptions = ref<Seat[]>([])
const photoUrls = ref<string[]>([])

const form = reactive({
  title: '',
  description: '',
  category: 'electrical',
  priority: 'medium' as WorkOrderPriority,
  targetType: 'space' as WorkOrderTargetType,
  spaceId: undefined as number | undefined,
  seatId: undefined as number | undefined,
  /** 部分下架：为空表示整间下架 */
  offlineSeatIds: [] as number[],
  location: '',
  etaAt: '' as string,
})

const isSpaceMode = computed(() => form.targetType === 'space' && !!form.spaceId)
const estimatedHours = computed(() => estimateSlaHours(form.category, form.priority))
const selectedCategory = computed(() => meta.value.categories.find((c) => c.code === form.category))
const allSeatIds = computed(() => seatOptions.value.map((s) => s.id))
const partialOffline = computed(
  () => isSpaceMode.value && form.offlineSeatIds.length > 0 && form.offlineSeatIds.length < allSeatIds.value.length,
)

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
    form.offlineSeatIds = []
  } catch {
    seatOptions.value = []
  }
}

watch(
  () => form.spaceId,
  (id) => {
    if (id) loadSeats(id)
    else seatOptions.value = []
  },
)

watch(
  () => form.targetType,
  (t) => {
    if (t !== 'space') form.offlineSeatIds = []
    if (t === 'seat' && form.spaceId) loadSeats(form.spaceId)
  },
)

function seatLabel(s: Seat) {
  return `${s.seatNo}${s.hasSocket ? '（有插座）' : ''}`
}

function selectAllSeats() {
  form.offlineSeatIds = [...allSeatIds.value]
}

function clearSeatSelection() {
  form.offlineSeatIds = []
}

function addPhoto() {
  if (photoUrls.value.length >= meta.value.limits.maxPhotos) {
    ElMessage.warning(`最多 ${meta.value.limits.maxPhotos} 张照片`)
    return
  }
  photoUrls.value.push('')
}

function removePhoto(index: number) {
  photoUrls.value.splice(index, 1)
}

function validatePhotos(): string[] {
  const urls = photoUrls.value.map((u) => u.trim()).filter(Boolean)
  for (const url of urls) {
    if (!/^https?:\/\//i.test(url) && !url.startsWith('/uploads/')) {
      ElMessage.warning('照片请填写 http(s) 链接或站内 /uploads/ 路径')
      return []
    }
  }
  return urls
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

  const urls = validatePhotos()
  if (photoUrls.value.some((u) => u.trim()) && urls.length === 0) return

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
      // 只选了部分座位时按座位粒度下架，其余座位保持可约
      if (partialOffline.value) payload.seatIds = [...form.offlineSeatIds]
    } else if (form.targetType === 'seat') {
      const seat = seatOptions.value.find((s) => s.id === form.seatId)
      payload.targetId = form.seatId
      payload.spaceId = seat?.spaceId ?? form.spaceId
    } else {
      const location = form.location.trim() ? `位置：${form.location.trim()}` : ''
      payload.description = [location, payload.description ?? ''].filter(Boolean).join('\n') || undefined
    }
    if (urls.length) payload.photoUrls = urls
    if (form.etaAt) payload.etaAt = new Date(form.etaAt).toISOString()

    const created = await report(payload)
    const offline = created.seatIdList?.length ?? 0
    ElMessage.success(
      offline
        ? `报修已提交（${created.workOrderNo}），${offline} 个座位已临时下架`
        : `报修已提交（${created.workOrderNo}）`,
    )
    form.title = ''
    form.description = ''
    form.location = ''
    form.seatId = undefined
    form.offlineSeatIds = []
    form.etaAt = ''
    photoUrls.value = []
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  await Promise.all([ensureLoaded(), loadSpaces()])
})
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
      title="下架与预约说明"
      description="报修空间/座位在维修期间会自动下架。若该座位已被预约，系统会立即作废相应预约并通知预约人，不计入违约。"
    />

    <el-card shadow="never" class="form-card" v-loading="loading">
      <el-form label-width="96px" :model="form" class="report-form">
        <el-form-item label="标题" required>
          <el-input
            v-model="form.title"
            maxlength="50"
            show-word-limit
            placeholder="如：3 号空调不制冷"
            style="width: 420px"
          />
        </el-form-item>

        <el-form-item label="报修分类" required>
          <div class="inline-field">
            <el-select v-model="form.category" style="width: 200px">
              <el-option
                v-for="c in meta.categories"
                :key="c.code"
                :label="c.name"
                :value="c.code"
              />
            </el-select>
            <span v-if="selectedCategory" class="field-hint">
              标准时限 {{ selectedCategory.defaultSlaHours }} 小时
              <template v-if="estimatedHours"> · 按当前优先级约 {{ estimatedHours }} 小时</template>
            </span>
          </div>
        </el-form-item>

        <el-form-item label="紧急程度">
          <el-radio-group v-model="form.priority">
            <el-radio-button v-for="p in meta.priorities" :key="p.code" :value="p.code">
              {{ p.name }}
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

          <el-form-item label="下架座位">
            <div class="offline-block">
              <el-select
                v-model="form.offlineSeatIds"
                multiple
                collapse-tags
                collapse-tags-tooltip
                placeholder="不选则整间下架"
                style="width: 320px"
                :disabled="!seatOptions.length"
              >
                <el-option v-for="s in seatOptions" :key="s.id" :label="seatLabel(s)" :value="s.id" />
              </el-select>
              <div class="offline-actions">
                <el-button link type="primary" @click="selectAllSeats">全选</el-button>
                <el-button link @click="clearSeatSelection">清空（整间下架）</el-button>
              </div>
            </div>
          </el-form-item>
          <el-form-item label="影响范围">
            <span class="field-hint">
              <template v-if="partialOffline">
                仅下架 {{ form.offlineSeatIds.length }} 个座位，其余
                {{ allSeatIds.length - form.offlineSeatIds.length }} 个座位保持可预约
              </template>
              <template v-else-if="isSpaceMode">该空间全部 {{ allSeatIds.length }} 个座位将下架</template>
              <template v-else>选择空间后显示</template>
            </span>
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

        <el-form-item label="预计恢复">
          <el-date-picker
            v-model="form.etaAt"
            type="datetime"
            placeholder="选填，可稍后由维修员更新"
            style="width: 260px"
          />
        </el-form-item>

        <el-form-item label="现场照片">
          <div class="photo-block">
            <div v-for="(_, idx) in photoUrls" :key="idx" class="photo-row">
              <el-input v-model="photoUrls[idx]" placeholder="https://… 或 /uploads/…" style="width: 320px" />
              <el-button link type="danger" @click="removePhoto(idx)">移除</el-button>
            </div>
            <el-button
              v-if="photoUrls.length < meta.limits.maxPhotos"
              link
              type="primary"
              @click="addPhoto"
            >
              添加照片（{{ photoUrls.length }}/{{ meta.limits.maxPhotos }}）
            </el-button>
          </div>
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
  max-width: 720px;
}

.inline-field {
  display: flex;
  align-items: center;
  gap: 12px;
}

.field-hint {
  font-size: 12px;
  color: #909399;
}

.offline-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.offline-actions {
  display: flex;
  gap: 4px;
}

.photo-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.photo-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
