<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { listSpaces } from '@/api/admin'
import { apply, preflight } from '@/api/m2'
import type { PreflightResult, Space } from '@/api/types'

const loading = ref(false)
const submitting = ref(false)
const spaces = ref<Space[]>([])

/** 冲突预检结果：reason 非空时禁止提交 */
const conflict = ref<PreflightResult | null>(null)
const checking = ref(false)
let checkTimer: ReturnType<typeof setTimeout> | null = null
let checkSeq = 0

const form = reactive({
  spaceId: undefined as number | undefined,
  date: formatDate(addDays(new Date(), 1)),
  startHour: 9,
  endHour: 11,
  purpose: '',
})

// 08:00-22:00 整点时段
const hours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
const startOptions = computed(() => hours.filter((h) => h < form.endHour))
const endOptions = computed(() => hours.filter((h) => h > form.startHour))

function addDays(d: Date, days: number) {
  const r = new Date(d)
  r.setDate(r.getDate() + days)
  return r
}

function formatDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function disabledDate(d: Date) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d.getTime() < today.getTime()
}

async function loadSpaces() {
  loading.value = true
  try {
    spaces.value = await listSpaces({ type: 'classroom' })
    // 无教室类型数据时回退展示全部空间
    if (!spaces.value.length) spaces.value = await listSpaces()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    loading.value = false
  }
}

/** 表单变化后防抖调用 preflight，避免每次输入都打接口 */
async function runPreflight() {
  conflict.value = null
  if (!form.spaceId || !form.date || form.startHour >= form.endHour) return
  const seq = ++checkSeq
  checking.value = true
  try {
    const result = await preflight({
      spaceId: form.spaceId,
      date: form.date,
      startHour: form.startHour,
      endHour: form.endHour,
    })
    // 丢弃过期响应，防止旧结果覆盖新表单的结论
    if (seq === checkSeq) conflict.value = result.reason ? result : null
  } catch {
    /* 预检失败不阻塞提交，后端仍会校验 */
  } finally {
    if (seq === checkSeq) checking.value = false
  }
}

function schedulePreflight() {
  if (checkTimer) clearTimeout(checkTimer)
  checkTimer = setTimeout(runPreflight, 300)
}

watch(
  () => [form.spaceId, form.date, form.startHour, form.endHour],
  () => schedulePreflight(),
)

onUnmounted(() => {
  if (checkTimer) clearTimeout(checkTimer)
})

async function submit() {
  if (!form.spaceId) {
    ElMessage.warning('请选择教室')
    return
  }
  if (conflict.value?.reason) {
    ElMessage.warning(conflict.value.reason)
    return
  }
  submitting.value = true
  try {
    await apply({
      spaceId: form.spaceId,
      date: form.date,
      startHour: form.startHour,
      endHour: form.endHour,
      purpose: form.purpose.trim() || undefined,
    })
    ElMessage.success('已提交，等待审批')
    form.purpose = ''
    conflict.value = null
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
      <h2 class="page-title">整教室申请</h2>
      <p class="page-desc">提交整教室预约申请，经多级审批通过后生效</p>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="tip-alert"
      title="注意事项"
      description="审批通过后，该教室在该时段被整间占用，个人无法再预约该时段的座位；驳回或超时撤销会自动释放。"
    />

    <el-card shadow="never" class="form-card" v-loading="loading">
      <el-form label-width="90px" :model="form" class="apply-form">
        <el-form-item label="教室">
          <el-select v-model="form.spaceId" placeholder="请选择教室" style="width: 320px" filterable>
            <el-option
              v-for="s in spaces"
              :key="s.id"
              :label="`${s.name}（${s.code} · ${s.openTime}-${s.closeTime}）`"
              :value="s.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker
            v-model="form.date"
            type="date"
            value-format="YYYY-MM-DD"
            :disabled-date="disabledDate"
            style="width: 200px"
          />
        </el-form-item>
        <el-form-item label="时段">
          <el-select v-model="form.startHour" style="width: 100px">
            <el-option v-for="h in startOptions" :key="h" :label="`${h}:00`" :value="h" />
          </el-select>
          <span class="range-sep">至</span>
          <el-select v-model="form.endHour" style="width: 100px">
            <el-option v-for="h in endOptions" :key="h" :label="`${h}:00`" :value="h" />
          </el-select>
          <span v-if="checking" class="checking-tip">正在检查冲突…</span>
        </el-form-item>

        <el-form-item v-if="conflict?.reason" label="冲突提示">
          <el-alert
            type="error"
            :closable="false"
            show-icon
            class="conflict-alert"
            :title="conflict.reason"
            :description="
              conflict.roomRequest
                ? `已被申请单 ${conflict.roomRequest.requestCode} 占用，请改选时段或教室`
                : '请改选时段或教室后再提交'
            "
          />
        </el-form-item>

        <el-form-item label="用途说明">
          <el-input
            v-model="form.purpose"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            placeholder="请说明使用用途（如班会、自习组织、课程活动等）"
            style="width: 420px"
          />
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            :loading="submitting"
            :disabled="!!conflict?.reason"
            @click="submit"
          >
            提交申请
          </el-button>
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
  max-width: 640px;
}

.range-sep {
  margin: 0 8px;
  color: #909399;
}

.checking-tip {
  margin-left: 10px;
  font-size: 12px;
  color: #909399;
}

.conflict-alert {
  width: 420px;
}
</style>
