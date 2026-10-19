<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { FormInstance, FormRules } from 'element-plus'
import { Plus } from '@element-plus/icons-vue'
import {
  createSeat,
  createSpace,
  deleteSpace,
  listSpaceSeats,
  listSpaces,
  seatHistory,
  updateSeat,
  updateSpace,
} from '@/api/admin'
import type { Seat, Space, SpaceType } from '@/api/types'

/* ===== 类型 ===== */
/** 后端 GET /spaces 返回带 seatCount 的空间 */
interface SpaceRow extends Space {
  seatCount: number
}

/** 后端 GET /spaces/seats/:id/history 返回的座位状态日志 */
interface SeatStatusLogItem {
  id: number
  seatId: number
  spaceId: number
  seatNo: string
  fromStatus: string
  toStatus: string
  source: string
  refType: string
  refId: number | null
  reason: string
  operatorId: number | null
  createdAt: string
}

type TagType = '' | 'success' | 'warning' | 'info' | 'danger'

/* ===== 常量映射 ===== */
const SPACE_TYPE_OPTIONS: Array<{ value: SpaceType; label: string }> = [
  { value: 'study', label: '自习室' },
  { value: 'classroom', label: '教室' },
  { value: 'library', label: '图书馆' },
  { value: 'other', label: '其他' },
]

const SPACE_TYPE_TAG: Record<string, TagType> = { study: '', classroom: 'success', library: 'warning', other: 'info' }

const SEAT_STATUS: Record<string, { label: string; tag: TagType }> = {
  available: { label: '可用', tag: 'success' },
  maintenance: { label: '维修中', tag: 'danger' },
  occupied_by_room: { label: '整教室占用', tag: 'warning' },
}

const SEAT_SOURCE: Record<string, { label: string; tag: TagType }> = {
  M1: { label: 'M1 预约', tag: '' },
  M2: { label: 'M2 审批占用', tag: 'warning' },
  M3: { label: 'M3 报修', tag: 'danger' },
  SYSTEM: { label: '系统', tag: 'info' },
}

const REF_TYPES: Record<string, string> = {
  work_order: '工单',
  room_request: '教室审批单',
  reservation: '预约单',
}

function typeLabel(t: SpaceType) {
  return SPACE_TYPE_OPTIONS.find((o) => o.value === t)?.label ?? t
}

function statusLabel(s: string) {
  return SEAT_STATUS[s]?.label ?? s
}

function sourceLabel(s: string) {
  return SEAT_SOURCE[s]?.label ?? s
}

function refLabel(item: SeatStatusLogItem) {
  if (!item.refType && item.refId == null) return '-'
  return `${REF_TYPES[item.refType] ?? item.refType}${item.refId != null ? ` #${item.refId}` : ''}`
}

function formatTime(v: string | Date | null | undefined) {
  return v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '-'
}

/* ===== 空间列表 ===== */
const spacesLoading = ref(false)
const spaces = ref<SpaceRow[]>([])
const selectedSpace = ref<SpaceRow | null>(null)

async function loadSpaces() {
  spacesLoading.value = true
  try {
    spaces.value = (await listSpaces()) as unknown as SpaceRow[]
    if (selectedSpace.value) {
      const kept = spaces.value.find((s) => s.id === selectedSpace.value!.id)
      if (kept) {
        selectedSpace.value = kept
        loadSeats(kept.id)
      } else {
        selectedSpace.value = null
        seats.value = []
      }
    }
  } finally {
    spacesLoading.value = false
  }
}

function selectSpace(row: SpaceRow) {
  selectedSpace.value = row
  loadSeats(row.id)
}

/* ===== 座位列表 ===== */
const seatsLoading = ref(false)
const seats = ref<Seat[]>([])

async function loadSeats(spaceId: number) {
  seatsLoading.value = true
  try {
    seats.value = await listSpaceSeats(spaceId)
  } finally {
    seatsLoading.value = false
  }
}

/* ===== 空间新建 / 编辑 / 注销 ===== */
const spaceDialog = reactive({ visible: false, mode: 'create' as 'create' | 'edit', id: 0 })
const spaceFormRef = ref<FormInstance>()
const spaceForm = reactive({
  code: '',
  name: '',
  type: 'study' as SpaceType,
  ownerDept: '',
  openTime: '08:00',
  closeTime: '22:00',
  description: '',
  isActive: true,
})

const spaceRules: FormRules = {
  code: [{ required: true, message: '请输入空间编码', trigger: 'blur' }],
  name: [{ required: true, message: '请输入空间名称', trigger: 'blur' }],
}

function openSpaceCreate() {
  spaceDialog.mode = 'create'
  spaceDialog.id = 0
  Object.assign(spaceForm, {
    code: '',
    name: '',
    type: 'study',
    ownerDept: '',
    openTime: '08:00',
    closeTime: '22:00',
    description: '',
    isActive: true,
  })
  spaceDialog.visible = true
}

function openSpaceEdit(row: SpaceRow) {
  spaceDialog.mode = 'edit'
  spaceDialog.id = row.id
  Object.assign(spaceForm, {
    code: row.code,
    name: row.name,
    type: row.type,
    ownerDept: row.ownerDept,
    openTime: row.openTime,
    closeTime: row.closeTime,
    description: row.description,
    isActive: row.isActive,
  })
  spaceDialog.visible = true
}

async function submitSpace() {
  const valid = await spaceFormRef.value?.validate().then(() => true).catch(() => false)
  if (!valid) return
  if (spaceDialog.mode === 'create') {
    await createSpace({
      code: spaceForm.code,
      name: spaceForm.name,
      type: spaceForm.type,
      ownerDept: spaceForm.ownerDept,
      openTime: spaceForm.openTime,
      closeTime: spaceForm.closeTime,
      description: spaceForm.description,
    })
    ElMessage.success('空间创建成功')
  } else {
    await updateSpace(spaceDialog.id, {
      name: spaceForm.name,
      type: spaceForm.type,
      ownerDept: spaceForm.ownerDept,
      openTime: spaceForm.openTime,
      closeTime: spaceForm.closeTime,
      description: spaceForm.description,
      isActive: spaceForm.isActive,
    })
    ElMessage.success('空间已更新')
  }
  spaceDialog.visible = false
  await loadSpaces()
}

async function handleDeleteSpace(row: SpaceRow) {
  try {
    await ElMessageBox.confirm(
      `确定注销空间「${row.name}」（${row.code}）吗？注销后其下座位一并失效。`,
      '注销确认',
      { type: 'warning' },
    )
  } catch {
    return
  }
  await deleteSpace(row.id)
  ElMessage.success('空间已注销')
  if (selectedSpace.value?.id === row.id) {
    selectedSpace.value = null
    seats.value = []
  }
  await loadSpaces()
}

/* ===== 新增座位（批量 / 单个） ===== */
const seatDialog = reactive({
  visible: false,
  mode: 'batch' as 'batch' | 'single',
  seatNos: '',
  seatNo: '',
  hasSocket: false,
})

function openSeatCreate() {
  Object.assign(seatDialog, { visible: true, mode: 'batch', seatNos: '', seatNo: '', hasSocket: false })
}

async function submitSeats() {
  if (!selectedSpace.value) return
  const nos =
    seatDialog.mode === 'batch'
      ? [
          ...new Set(
            seatDialog.seatNos
              .split(/[,，\s]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ]
      : [seatDialog.seatNo.trim()]
  if (!nos.length) {
    ElMessage.warning('请输入座位号')
    return
  }
  let ok = 0
  for (const no of nos) {
    try {
      await createSeat(selectedSpace.value.id, { seatNo: no, hasSocket: seatDialog.hasSocket })
      ok++
    } catch {
      /* 重复等错误已由拦截器统一提示 */
    }
  }
  if (ok > 0) {
    ElMessage.success(`新增 ${ok} 个座位`)
    seatDialog.visible = false
    await Promise.all([loadSpaces(), loadSeats(selectedSpace.value.id)])
  }
}

/* ===== 座位编辑 / 注销 ===== */
const seatEdit = reactive({ visible: false, id: 0, seatNo: '', hasSocket: false, isActive: true })

function openSeatEdit(row: Seat) {
  Object.assign(seatEdit, {
    visible: true,
    id: row.id,
    seatNo: row.seatNo,
    hasSocket: row.hasSocket,
    isActive: row.isActive,
  })
}

async function submitSeatEdit() {
  if (!seatEdit.seatNo.trim()) {
    ElMessage.warning('请输入座位号')
    return
  }
  await updateSeat(seatEdit.id, { seatNo: seatEdit.seatNo, hasSocket: seatEdit.hasSocket, isActive: seatEdit.isActive })
  ElMessage.success('座位已更新')
  seatEdit.visible = false
  if (selectedSpace.value) loadSeats(selectedSpace.value.id)
}

async function handleDeleteSeat(row: Seat) {
  try {
    await ElMessageBox.confirm(`确定注销座位「${row.seatNo}」吗？`, '注销确认', { type: 'warning' })
  } catch {
    return
  }
  await updateSeat(row.id, { isActive: false })
  ElMessage.success('座位已注销')
  if (selectedSpace.value) {
    await Promise.all([loadSpaces(), loadSeats(selectedSpace.value.id)])
  }
}

/* ===== 座位状态历史（跨模块追溯） ===== */
const historyDrawer = reactive({ visible: false, seatNo: '', logs: [] as SeatStatusLogItem[], loading: false })

async function openHistory(row: Seat) {
  historyDrawer.seatNo = `${selectedSpace.value?.name ?? ''} · ${row.seatNo}`
  historyDrawer.visible = true
  historyDrawer.loading = true
  try {
    historyDrawer.logs = (await seatHistory(row.id, 50)) as unknown as SeatStatusLogItem[]
  } finally {
    historyDrawer.loading = false
  }
}

onMounted(loadSpaces)
</script>

<template>
  <div class="page-container">
    <el-row :gutter="16">
      <el-col :span="14">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span>空间列表</span>
              <el-button type="primary" size="small" :icon="Plus" @click="openSpaceCreate">新建空间</el-button>
            </div>
          </template>
          <el-table
            v-loading="spacesLoading"
            :data="spaces"
            highlight-current-row
            size="small"
            @row-click="selectSpace"
          >
            <el-table-column prop="code" label="编码" width="110" />
            <el-table-column prop="name" label="名称" min-width="150" show-overflow-tooltip />
            <el-table-column label="类型" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="SPACE_TYPE_TAG[row.type]">{{ typeLabel(row.type) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="院系" width="120">
              <template #default="{ row }">
                <span>{{ row.ownerDept || '全校' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="开放时间" width="115">
              <template #default="{ row }">{{ row.openTime }} - {{ row.closeTime }}</template>
            </el-table-column>
            <el-table-column prop="seatCount" label="座位数" width="75" />
            <el-table-column label="状态" width="80">
              <template #default="{ row }">
                <el-tag size="small" :type="row.isActive ? 'success' : 'info'">
                  {{ row.isActive ? '启用' : '已注销' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="130" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click.stop="openSpaceEdit(row)">编辑</el-button>
                <el-button link type="danger" @click.stop="handleDeleteSpace(row)">注销</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>

      <el-col :span="10">
        <el-card shadow="never">
          <template #header>
            <div class="card-head">
              <span>座位管理{{ selectedSpace ? `：${selectedSpace.name}` : '' }}</span>
              <el-button type="primary" size="small" :icon="Plus" :disabled="!selectedSpace" @click="openSeatCreate">
                新增座位
              </el-button>
            </div>
          </template>
          <el-empty v-if="!selectedSpace" description="点击左侧空间行查看座位" :image-size="60" />
          <el-table v-else v-loading="seatsLoading" :data="seats" size="small" max-height="480">
            <el-table-column prop="seatNo" label="座位号" width="80" />
            <el-table-column label="插座" width="70">
              <template #default="{ row }">
                <el-tag v-if="row.hasSocket" size="small" type="success">有</el-tag>
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="105">
              <template #default="{ row }">
                <el-tag size="small" :type="SEAT_STATUS[row.status]?.tag ?? 'info'">
                  {{ statusLabel(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="状态来源" width="120">
              <template #default="{ row }">
                <el-tag v-if="row.statusSource" size="small" :type="SEAT_SOURCE[row.statusSource]?.tag ?? 'info'">
                  {{ sourceLabel(row.statusSource) }}
                </el-tag>
                <span v-else>-</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="150" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" @click="openSeatEdit(row)">编辑</el-button>
                <el-button link type="danger" @click="handleDeleteSeat(row)">注销</el-button>
                <el-button link @click="openHistory(row)">历史</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-col>
    </el-row>

    <!-- 新建 / 编辑空间 -->
    <el-dialog v-model="spaceDialog.visible" :title="spaceDialog.mode === 'create' ? '新建空间' : '编辑空间'" width="520px">
      <el-form ref="spaceFormRef" :model="spaceForm" :rules="spaceRules" label-width="90px">
        <el-form-item label="空间编码" prop="code">
          <el-input v-model="spaceForm.code" :disabled="spaceDialog.mode === 'edit'" placeholder="如 LIB-A-103" />
        </el-form-item>
        <el-form-item label="空间名称" prop="name">
          <el-input v-model="spaceForm.name" placeholder="如 图书馆自习区 A103" />
        </el-form-item>
        <el-form-item label="类型">
          <el-select v-model="spaceForm.type" style="width: 100%">
            <el-option v-for="o in SPACE_TYPE_OPTIONS" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="院系">
          <el-input v-model="spaceForm.ownerDept" placeholder="留空表示全校开放" />
        </el-form-item>
        <el-form-item label="开放时间">
          <el-time-select v-model="spaceForm.openTime" start="00:00" step="00:30" end="23:30" placeholder="开放时间" />
          <span class="time-sep">至</span>
          <el-time-select v-model="spaceForm.closeTime" start="00:00" step="00:30" end="23:30" placeholder="关闭时间" />
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="spaceForm.description" type="textarea" :rows="2" placeholder="选填" />
        </el-form-item>
        <el-form-item v-if="spaceDialog.mode === 'edit'" label="状态">
          <el-switch v-model="spaceForm.isActive" active-text="启用" inactive-text="已注销" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="spaceDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitSpace">确定</el-button>
      </template>
    </el-dialog>

    <!-- 新增座位 -->
    <el-dialog v-model="seatDialog.visible" title="新增座位" width="480px">
      <el-form label-width="90px">
        <el-form-item label="添加方式">
          <el-radio-group v-model="seatDialog.mode">
            <el-radio value="batch">批量添加</el-radio>
            <el-radio value="single">逐个添加</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="seatDialog.mode === 'batch'" label="座位号">
          <el-input
            v-model="seatDialog.seatNos"
            type="textarea"
            :rows="4"
            placeholder="多个座位号用逗号或换行分隔，如：E01,E02,E03"
          />
        </el-form-item>
        <el-form-item v-else label="座位号">
          <el-input v-model="seatDialog.seatNo" placeholder="如：E01" />
        </el-form-item>
        <el-form-item label="带插座">
          <el-checkbox v-model="seatDialog.hasSocket">该批座位带插座</el-checkbox>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="seatDialog.visible = false">取消</el-button>
        <el-button type="primary" @click="submitSeats">确定</el-button>
      </template>
    </el-dialog>

    <!-- 编辑座位 -->
    <el-dialog v-model="seatEdit.visible" title="编辑座位" width="420px">
      <el-form label-width="90px">
        <el-form-item label="座位号">
          <el-input v-model="seatEdit.seatNo" placeholder="如：E01" />
        </el-form-item>
        <el-form-item label="带插座">
          <el-checkbox v-model="seatEdit.hasSocket">带插座</el-checkbox>
        </el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="seatEdit.isActive" active-text="启用" inactive-text="已注销" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="seatEdit.visible = false">取消</el-button>
        <el-button type="primary" @click="submitSeatEdit">确定</el-button>
      </template>
    </el-dialog>

    <!-- 座位状态历史抽屉 -->
    <el-drawer v-model="historyDrawer.visible" :title="`座位状态历史：${historyDrawer.seatNo}`" size="640px">
      <el-table v-loading="historyDrawer.loading" :data="historyDrawer.logs" size="small">
        <el-table-column label="时间" width="165">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="状态变更" min-width="120">
          <template #default="{ row }">{{ statusLabel(row.fromStatus) }} → {{ statusLabel(row.toStatus) }}</template>
        </el-table-column>
        <el-table-column label="来源" width="115">
          <template #default="{ row }">
            <el-tag size="small" :type="SEAT_SOURCE[row.source]?.tag ?? 'info'">{{ sourceLabel(row.source) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="关联单据" width="120">
          <template #default="{ row }">{{ refLabel(row) }}</template>
        </el-table-column>
        <el-table-column prop="reason" label="原因" min-width="110" show-overflow-tooltip />
      </el-table>
    </el-drawer>
  </div>
</template>

<style scoped>
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.time-sep {
  margin: 0 8px;
  color: #909399;
}
</style>
