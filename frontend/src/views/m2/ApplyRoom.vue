<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listSpaces } from '@/api/admin'
import { apply } from '@/api/m2'
import type { Space } from '@/api/types'

const loading = ref(false)
const submitting = ref(false)
const spaces = ref<Space[]>([])

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

async function submit() {
  if (!form.spaceId) {
    ElMessage.warning('请选择教室')
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
      type="warning"
      :closable="false"
      show-icon
      class="tip-alert"
      title="注意事项"
      description="审批通过后，该教室在该时段的全部座位将被占用（不可再被个人预约）；逾期未审批的申请将自动超时撤销。"
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
          <el-button type="primary" :loading="submitting" @click="submit">提交申请</el-button>
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
</style>
