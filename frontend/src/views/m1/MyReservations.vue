<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { mine, checkIn, cancel, dynamicCode } from '@/api/m1'
import type { Reservation, ReservationStatus } from '@/api/types'

const statusOptions = [
  { label: '全部', value: '' },
  { label: '已预约', value: 'booked' },
  { label: '已签到', value: 'checked_in' },
  { label: '已取消', value: 'cancelled' },
  { label: '违约', value: 'no_show' },
  { label: '已完成', value: 'completed' },
]

const statusMap: Record<ReservationStatus, { label: string; type: string }> = {
  booked: { label: '已预约', type: 'primary' },
  checked_in: { label: '已签到', type: 'success' },
  cancelled: { label: '已取消', type: 'info' },
  no_show: { label: '违约', type: 'danger' },
  completed: { label: '已完成', type: 'warning' },
}

const loading = ref(false)
const filter = ref('')
const list = ref<Reservation[]>([])

// 签到弹窗
const checkInVisible = ref(false)
const checkInResv = ref<Reservation | null>(null)
const checkInCode = ref('')
const checkingIn = ref(false)

function pad(n: number) {
  return String(n).padStart(2, '0')
}

function slotText(r: Reservation) {
  return `${pad(r.startHour)}:00 - ${pad(r.endHour)}:00`
}

/** 预约时段尚未开始 */
function isUpcoming(r: Reservation) {
  return new Date(`${r.date}T${pad(r.startHour)}:00:00`).getTime() > Date.now()
}

async function load() {
  loading.value = true
  try {
    list.value = await mine(filter.value ? { status: filter.value } : undefined)
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    loading.value = false
  }
}

function openCheckIn(row: Reservation) {
  checkInResv.value = row
  checkInCode.value = ''
  checkInVisible.value = true
}

async function confirmCheckIn() {
  if (!checkInResv.value) return
  if (!checkInCode.value.trim()) {
    ElMessage.warning('请输入签到码')
    return
  }
  checkingIn.value = true
  try {
    await checkIn(checkInResv.value.id, { code: checkInCode.value.trim() })
    ElMessage.success('签到成功')
    checkInVisible.value = false
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    checkingIn.value = false
  }
}

async function handleCancel(row: Reservation) {
  try {
    await ElMessageBox.confirm(
      `确认取消 ${row.spaceName} ${row.seatNo} 在 ${row.date} ${slotText(row)} 的预约？`,
      '取消预约',
      { type: 'warning', confirmButtonText: '确认取消' },
    )
  } catch {
    return
  }
  try {
    await cancel(row.id)
    ElMessage.success('已取消预约')
    load()
  } catch {
    /* 拦截器已统一提示 */
  }
}

async function showDynamicCode(row: Reservation) {
  try {
    const res = await dynamicCode(row.spaceId, row.date)
    ElMessageBox.alert(
      `${row.spaceName}（${row.date}）当日动态签到码为：\n\n${res.code}\n\n请在入座前对屏幕显示核对，当日有效。`,
      '当前教室动态码',
      { confirmButtonText: '知道了' },
    )
  } catch {
    /* 拦截器已统一提示 */
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">我的预约</h2>
      <p class="page-desc">查看预约状态，按时签到；已签到后可查看当前教室动态码</p>
    </div>

    <el-card shadow="never">
      <div class="toolbar">
        <el-radio-group v-model="filter" @change="load">
          <el-radio-button v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </el-radio-button>
        </el-radio-group>
      </div>

      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="spaceName" label="空间" min-width="150" />
        <el-table-column prop="seatNo" label="座位" width="80" />
        <el-table-column prop="date" label="日期" width="110" />
        <el-table-column label="时段" width="120">
          <template #default="{ row }">{{ slotText(row) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusMap[row.status as ReservationStatus].type" size="small">
              {{ statusMap[row.status as ReservationStatus].label }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="签到码" width="120">
          <template #default="{ row }">
            <span v-if="row.status === 'checked_in'" class="code-text">{{ row.checkInCode }}</span>
            <span v-else-if="row.status === 'booked'" class="muted">动态码待获取</span>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="200" fixed="right">
          <template #default="{ row }">
            <template v-if="row.status === 'booked' && isUpcoming(row)">
              <el-button type="success" size="small" @click="openCheckIn(row)">签到</el-button>
              <el-button type="danger" size="small" link @click="handleCancel(row)">取消</el-button>
            </template>
            <el-button v-else-if="row.status === 'checked_in'" type="primary" size="small" link @click="showDynamicCode(row)">
              查看动态码
            </el-button>
            <span v-else class="muted">-</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="暂无预约记录" :image-size="70" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="checkInVisible" title="座位签到" width="420">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        class="checkin-tip"
        title="请查看自习室屏幕上的当日动态码"
        description="动态码为空间+日期确定，同一空间当日共享同一编码，入座前录入即可完成签到。"
      />
      <el-form label-width="80px" class="checkin-form">
        <el-form-item label="座位">
          <span>{{ checkInResv?.spaceName }} · {{ checkInResv?.seatNo }}</span>
        </el-form-item>
        <el-form-item label="签到码">
          <el-input v-model="checkInCode" placeholder="请输入当日动态码" maxlength="20" @keyup.enter="confirmCheckIn" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="checkInVisible = false">取消</el-button>
        <el-button type="primary" :loading="checkingIn" @click="confirmCheckIn">确认签到</el-button>
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

.toolbar {
  margin-bottom: 14px;
}

.code-text {
  font-family: monospace;
  font-weight: 600;
}

.muted {
  color: #c0c4cc;
}

.checkin-tip {
  margin-bottom: 16px;
}

.checkin-form {
  margin-top: 8px;
}
</style>
