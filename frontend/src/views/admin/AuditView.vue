<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { listAudit } from '@/api/admin'
import type { AuditLog } from '@/api/types'

type TagType = '' | 'success' | 'warning' | 'info' | 'danger'

const loading = ref(false)
const logs = ref<AuditLog[]>([])
const total = ref(0)
const keyword = ref('')
const page = ref(1)
const pageSize = ref(10)

const METHOD_TAG: Record<string, TagType> = {
  GET: '',
  POST: 'success',
  PUT: 'warning',
  PATCH: 'warning',
  DELETE: 'danger',
}

async function load() {
  loading.value = true
  try {
    const res = await listAudit({ keyword: keyword.value || undefined, page: page.value, pageSize: pageSize.value })
    logs.value = res.items
    total.value = res.total
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  page.value = 1
  load()
}

function handleSizeChange() {
  page.value = 1
  load()
}

/** action 形如 "POST /users"，拆分为方法 + 路径 */
function splitAction(action: string) {
  const idx = action.indexOf(' ')
  if (idx <= 0) return { method: '', path: action }
  return { method: action.slice(0, idx), path: action.slice(idx + 1) }
}

function formatTime(v: string | Date) {
  return new Date(v).toLocaleString('zh-CN', { hour12: false })
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <el-card shadow="never">
      <div class="toolbar">
        <el-input
          v-model="keyword"
          placeholder="搜索用户 / 操作 / 详情"
          clearable
          style="width: 260px"
          @keyup.enter="handleSearch"
          @clear="handleSearch"
        >
          <template #append>
            <el-button :icon="Search" @click="handleSearch" />
          </template>
        </el-input>
      </div>

      <el-table v-loading="loading" :data="logs" border stripe>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="username" label="用户" min-width="100" show-overflow-tooltip />
        <el-table-column label="操作" min-width="180">
          <template #default="{ row }">
            <el-tag v-if="row.action.includes(' ')" size="small" :type="METHOD_TAG[row.action.split(' ')[0]] || 'info'">
              {{ row.action.split(' ')[0] }}
            </el-tag>
            <span class="action-path">{{ splitAction(row.action).path }}</span>
          </template>
        </el-table-column>
        <el-table-column label="资源" min-width="150">
          <template #default="{ row }">
            {{ row.resourceType }}{{ row.resourceId ? ` #${row.resourceId}` : '' }}
          </template>
        </el-table-column>
        <el-table-column label="详情" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span>{{ row.detail || '-' }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="ip" label="IP" width="130" show-overflow-tooltip />
      </el-table>

      <el-pagination
        class="pager"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50]"
        layout="total, sizes, prev, pager, next, jumper"
        @size-change="handleSizeChange"
        @current-change="load"
      />
    </el-card>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}

.action-path {
  margin-left: 6px;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  color: #303133;
}
</style>
