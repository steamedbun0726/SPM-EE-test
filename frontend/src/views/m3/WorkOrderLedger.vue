<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { listSpaces, listUsers } from '@/api/admin'
import { listAll } from '@/api/m3'
import { useWorkOrderMeta } from '@/composables/useWorkOrderMeta'
import type { PaginatedWorkOrders, Space, User, WorkOrderListParams } from '@/api/types'

/**
 * 工单台账（M3-16）。
 *
 * 之前各列表页面都只能一次性拉全量：`/mine` 只有状态筛选，`/pending`、`/assignments`
 * 连筛选都没有。工单攒到几百条之后，派单台会越翻越慢，也没法回答「这个月三楼报了几次漏水」
 * 这类问题。这一页把所有筛选条件摊开，并且必须配合分页——否则加 index 页就白加了。
 */
const { meta, ensureLoaded: ensureMeta, categoryLabel, priorityLabel, statusLabel } =
  useWorkOrderMeta()

const loading = ref(false)
const result = ref<PaginatedWorkOrders>({ items: [], total: 0, page: 1, pageSize: 20 })
const spaces = ref<Space[]>([])
const users = ref<User[]>([])

const filter = reactive({
  status: [] as string[],
  category: '',
  priority: '',
  spaceId: undefined as number | undefined,
  assigneeId: undefined as number | undefined,
  escalated: '' as '' | 'true' | 'false',
  range: null as [string, string] | null,
  keyword: '',
  sort: 'createdDesc' as WorkOrderListParams['sort'],
})

const page = ref(1)
const pageSize = ref(20)

function formatTime(value: string | Date | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

/** 多选状态拼成逗号串，与后端约定一致 */
const statusParam = computed(() => (filter.status.length ? filter.status.join(',') : undefined))

function buildParams(): WorkOrderListParams {
  return {
    status: statusParam.value,
    category: filter.category || undefined,
    priority: (filter.priority || undefined) as WorkOrderListParams['priority'],
    spaceId: filter.spaceId,
    assigneeId: filter.assigneeId,
    escalated: filter.escalated === '' ? undefined : filter.escalated === 'true',
    from: filter.range?.[0],
    to: filter.range?.[1],
    keyword: filter.keyword.trim() || undefined,
    sort: filter.sort,
    page: page.value,
    pageSize: pageSize.value,
  }
}

async function load() {
  loading.value = true
  try {
    result.value = await listAll(buildParams())
    // 后端会矫正越界页码（返回空列表且 page 保持原值），这里回写以便 UI 与实际一致
    page.value = result.value.page
    pageSize.value = result.value.pageSize
  } catch {
    result.value = { items: [], total: 0, page: page.value, pageSize: pageSize.value }
  } finally {
    loading.value = false
  }
}

function search() {
  page.value = 1
  load()
}

function reset() {
  filter.status = []
  filter.category = ''
  filter.priority = ''
  filter.spaceId = undefined
  filter.assigneeId = undefined
  filter.escalated = ''
  filter.range = null
  filter.keyword = ''
  filter.sort = 'createdDesc'
  page.value = 1
  pageSize.value = 20
  load()
}

async function loadOptions() {
  try {
    spaces.value = await listSpaces()
  } catch {
    spaces.value = []
  }
  try {
    const res = await listUsers({ page: 1, pageSize: 100 })
    users.value = res.items
  } catch {
    users.value = []
  }
}

/** 维修员优先，没有角色信息时展示全部用户 */
const maintainers = computed(() => {
  const withRole = users.value.filter((u) => (u.roles ?? []).some((r) => r.code === 'maintenance'))
  return withRole.length ? withRole : users.value
})

watch([page, pageSize], () => load())

onMounted(() => {
  ensureMeta()
  loadOptions()
  load()
})
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">工单台账</h2>
      <p class="page-desc">按状态、分类、优先级、空间、时间范围与关键字组合筛选，支持分页检索</p>
    </div>

    <el-card shadow="never" class="filter-card">
      <el-form :inline="true" @submit.prevent="search">
        <el-form-item label="状态">
          <el-select v-model="filter.status" multiple collapse-tags collapse-tags-tooltip clearable
            placeholder="全部状态" style="width: 200px">
            <el-option v-for="s in meta.statuses" :key="s.code" :label="s.name" :value="s.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="分类">
          <el-select v-model="filter.category" clearable placeholder="全部分类" style="width: 150px">
            <el-option v-for="c in meta.categories" :key="c.code" :label="c.name" :value="c.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="优先级">
          <el-select v-model="filter.priority" clearable placeholder="全部优先级" style="width: 130px">
            <el-option v-for="p in meta.priorities" :key="p.code" :label="p.name" :value="p.code" />
          </el-select>
        </el-form-item>
        <el-form-item label="空间">
          <el-select v-model="filter.spaceId" filterable clearable placeholder="全部空间"
            style="width: 180px">
            <el-option v-for="s in spaces" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="维修员">
          <el-select v-model="filter.assigneeId" filterable clearable placeholder="全部维修员"
            style="width: 170px">
            <el-option v-for="u in maintainers" :key="u.id" :label="u.name" :value="u.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="升级">
          <el-select v-model="filter.escalated" clearable placeholder="不限" style="width: 120px">
            <el-option label="已升级" value="true" />
            <el-option label="未升级" value="false" />
          </el-select>
        </el-form-item>
        <el-form-item label="上报日期">
          <el-date-picker v-model="filter.range" type="daterange" value-format="YYYY-MM-DD"
            start-placeholder="开始" end-placeholder="结束" unlink-panels style="width: 240px" />
        </el-form-item>
        <el-form-item label="关键字">
          <el-input v-model="filter.keyword" clearable placeholder="工单号 / 标题 / 描述"
            style="width: 200px" @keyup.enter="search" />
        </el-form-item>
        <el-form-item label="排序">
          <el-select v-model="filter.sort" style="width: 150px">
            <el-option label="最新在前" value="createdDesc" />
            <el-option label="最早在前" value="createdAsc" />
            <el-option label="时限最紧在前" value="slaAsc" />
            <el-option label="优先级最高在前" value="priority" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="search">查询</el-button>
          <el-button @click="reset">重置</el-button>
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <div class="result-bar">
        <span>共 <b>{{ result.total }}</b> 条</span>
        <span class="result-tip">当前第 {{ result.page }} 页 / 每页 {{ result.pageSize }} 条</span>
      </div>

      <el-table v-loading="loading" :data="result.items" stripe>
        <el-table-column prop="workOrderNo" label="工单号" width="150" />
        <el-table-column prop="title" label="标题" min-width="160" show-overflow-tooltip />
        <el-table-column label="状态" width="100">
          <template #default="{ row }">{{ statusLabel(row.status) }}</template>
        </el-table-column>
        <el-table-column label="分类" width="130">
          <template #default="{ row }">{{ categoryLabel(row.category) }}</template>
        </el-table-column>
        <el-table-column label="优先级" width="90">
          <template #default="{ row }">{{ priorityLabel(row.priority) }}</template>
        </el-table-column>
        <el-table-column label="上报时间" width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="SLA 截止" width="170">
          <template #default="{ row }">{{ formatTime(row.slaDeadline) }}</template>
        </el-table-column>
        <el-table-column label="升级" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.escalated" type="danger" size="small">{{ row.escalateLevel }} 级</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="没有符合条件的工单" :image-size="70" />
        </template>
      </el-table>

      <div class="pagination">
        <el-pagination v-model:current-page="page" v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]" :total="result.total" background
          layout="total, sizes, prev, pager, next, jumper" />
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.filter-card {
  margin-bottom: 12px;
}

.result-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  font-size: 13px;
  color: #606266;
}

.result-tip {
  color: #909399;
}

.pagination {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}
</style>
