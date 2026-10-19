<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { listSpaces, listConfigs } from '@/api/admin'
import { searchSeats, book } from '@/api/m1'
import type { Space } from '@/api/types'

/** 座位搜索结果（后端 SearchSeatItem 结构，字段与 Seat 不同，故本地定义） */
interface SearchSeatItem {
  seatId: number
  seatNo: string
  hasSocket: boolean
  spaceId: number
  spaceCode: string
  spaceName: string
  spaceType: string
  ownerDept: string
  openTime: string
  closeTime: string
}

const loading = ref(false)
const searching = ref(false)
const spaces = ref<Space[]>([])
const maxHours = ref(4)

// 搜索条件
const spaceId = ref<number>()
const date = ref(formatDate(addDays(new Date(), 1)))
const startHour = ref(9)
const endHour = ref(11)
const onlySocket = ref(false)

// 08:00-22:00 整点时段
const hours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]
const startOptions = computed(() => hours.filter((h) => h < endHour.value))
const endOptions = computed(() => hours.filter((h) => h > startHour.value))

const seats = ref<SearchSeatItem[]>([])

// 预约弹窗
const bookDialogVisible = ref(false)
const bookSeat = ref<SearchSeatItem | null>(null)
const booking = ref(false)

function addDays(d: Date, days: number) {
  const r = new Date(d)
  r.setDate(r.getDate() + days)
  return r
}

function formatDate(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 禁选今天以前（今天及之后可选） */
function disabledDate(d: Date) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d.getTime() < today.getTime()
}

async function loadSpaces() {
  try {
    spaces.value = await listSpaces()
  } catch {
    /* 拦截器已统一提示 */
  }
}

async function loadConfig() {
  try {
    const configs = await listConfigs()
    const cfg = configs.find((c) => c.key === 'BOOKING_MAX_HOURS')
    if (cfg) maxHours.value = Number(cfg.value) || 4
  } catch {
    /* 保持默认值 */
  }
}

async function doSearch() {
  if (!date.value) {
    ElMessage.warning('请选择日期')
    return
  }
  searching.value = true
  loading.value = true
  try {
    const res = (await searchSeats({
      spaceId: spaceId.value,
      date: date.value,
      startHour: startHour.value,
      endHour: endHour.value,
      hasSocket: onlySocket.value || undefined,
    })) as unknown as SearchSeatItem[]
    seats.value = res
    if (!res.length) ElMessage.info('未找到符合条件的可用座位')
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    loading.value = false
    searching.value = false
  }
}

function openBook(row: SearchSeatItem) {
  bookSeat.value = row
  bookDialogVisible.value = true
}

async function confirmBook() {
  if (!bookSeat.value) return
  booking.value = true
  try {
    await book({
      seatId: bookSeat.value.seatId,
      date: date.value,
      startHour: startHour.value,
      endHour: endHour.value,
    })
    ElMessage.success('预约成功')
    bookDialogVisible.value = false
    doSearch()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    booking.value = false
  }
}

onMounted(() => {
  loadSpaces()
  loadConfig()
})
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">座位搜索</h2>
      <p class="page-desc">按空间 / 日期 / 时段搜索可用自习座位并预约，先到先得</p>
    </div>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="tip-alert"
      title="预约规则"
      :description="`单次预约时长最多 ${maxHours} 小时；预约后请在时段开始前到达并签到，超时未签到将记为违约。`"
    />

    <el-card shadow="never" class="search-card">
      <el-form inline class="search-form">
        <el-form-item label="空间">
          <el-select v-model="spaceId" placeholder="全部空间" clearable style="width: 220px">
            <el-option
              v-for="s in spaces"
              :key="s.id"
              :label="`${s.name}（${s.openTime}-${s.closeTime}）`"
              :value="s.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="日期">
          <el-date-picker
            v-model="date"
            type="date"
            value-format="YYYY-MM-DD"
            :disabled-date="disabledDate"
            style="width: 150px"
          />
        </el-form-item>
        <el-form-item label="时段">
          <el-select v-model="startHour" style="width: 100px">
            <el-option v-for="h in startOptions" :key="h" :label="`${h}:00`" :value="h" />
          </el-select>
          <span class="range-sep">至</span>
          <el-select v-model="endHour" style="width: 100px">
            <el-option v-for="h in endOptions" :key="h" :label="`${h}:00`" :value="h" />
          </el-select>
        </el-form-item>
        <el-form-item label="仅靠插座">
          <el-switch v-model="onlySocket" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :icon="Search" :loading="searching" @click="doSearch">搜索</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" v-loading="loading">
      <template #header>
        <span>可用座位（共 {{ seats.length }} 个）</span>
      </template>
      <el-table :data="seats" stripe>
        <el-table-column prop="seatNo" label="座位号" width="100" />
        <el-table-column label="插座" width="90">
          <template #default="{ row }">
            <el-tag v-if="row.hasSocket" type="success" size="small">有插座</el-tag>
            <el-tag v-else type="info" size="small">无插座</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="spaceName" label="空间" min-width="170" />
        <el-table-column label="开放时间" width="120">
          <template #default="{ row }">{{ row.openTime }} - {{ row.closeTime }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default>
            <el-tag type="success" size="small">可预约</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" @click="openBook(row)">预约</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="设置条件后点击搜索，查看可用座位" :image-size="70" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="bookDialogVisible" title="确认预约" width="440">
      <el-descriptions v-if="bookSeat" :column="1" border>
        <el-descriptions-item label="座位">{{ bookSeat.spaceName }} · {{ bookSeat.seatNo }}</el-descriptions-item>
        <el-descriptions-item label="日期">{{ date }}</el-descriptions-item>
        <el-descriptions-item label="时段">{{ startHour }}:00 - {{ endHour }}:00</el-descriptions-item>
        <el-descriptions-item label="时长">{{ endHour - startHour }} 小时</el-descriptions-item>
      </el-descriptions>
      <template #footer>
        <el-button @click="bookDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="booking" @click="confirmBook">确认预约</el-button>
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

.tip-alert {
  margin-bottom: 14px;
}

.search-card {
  margin-bottom: 14px;
}

.search-form .el-form-item {
  margin-bottom: 0;
}

.range-sep {
  margin: 0 8px;
  color: #909399;
}
</style>
