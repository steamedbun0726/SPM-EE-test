<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listUsers } from '@/api/admin'
import { pending, dispatch } from '@/api/m3'
import type { User, WorkOrder } from '@/api/types'

const loading = ref(false)
const list = ref<WorkOrder[]>([])

const users = ref<User[]>([])

// 派单弹窗
const dispatchVisible = ref(false)
const dispatchTarget = ref<WorkOrder | null>(null)
const assigneeId = ref<number>()
const submitting = ref(false)

function formatTime(value: string | Date | null) {
  if (!value) return '-'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

/** 优先展示维修员角色用户，无角色信息时展示全部用户 */
const maintainers = computed(() => {
  const withRole = users.value.filter((u) => (u.roles ?? []).some((r) => r.code === 'maintenance'))
  return withRole.length ? withRole : users.value
})

function userLabel(u: User) {
  return `${u.name}（${u.username}${u.department ? ` · ${u.department}` : ''}）`
}

async function load() {
  loading.value = true
  try {
    list.value = await pending()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    loading.value = false
  }
}

async function loadUsers() {
  try {
    const res = await listUsers({ page: 1, pageSize: 100 })
    users.value = res.items
  } catch {
    users.value = []
  }
}

function openDispatch(row: WorkOrder) {
  dispatchTarget.value = row
  assigneeId.value = undefined
  dispatchVisible.value = true
  if (!users.value.length) loadUsers()
}

async function confirmDispatch() {
  if (!dispatchTarget.value) return
  if (!assigneeId.value) {
    ElMessage.warning('请选择维修员')
    return
  }
  submitting.value = true
  try {
    await dispatch(dispatchTarget.value.id, { assigneeId: assigneeId.value })
    ElMessage.success('已派单，等待维修员接单')
    dispatchVisible.value = false
    load()
  } catch {
    /* 拦截器已统一提示 */
  } finally {
    submitting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <div class="page-header">
      <h2 class="page-title">派单台</h2>
      <p class="page-desc">处理待派单的报修工单，指派维修员；SLA 超时会自动升级</p>
    </div>

    <el-card shadow="never">
      <el-table v-loading="loading" :data="list" stripe>
        <el-table-column prop="workOrderNo" label="工单号" width="150" />
        <el-table-column prop="title" label="标题" min-width="160" show-overflow-tooltip />
        <el-table-column prop="category" label="分类" width="90" />
        <el-table-column prop="priority" label="紧急程度" width="90" />
        <el-table-column label="升级层级" width="90">
          <template #default="{ row }">{{ row.escalateLevel }}</template>
        </el-table-column>
        <el-table-column label="上报时间" width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="SLA 截止" width="170">
          <template #default="{ row }">{{ formatTime(row.slaDeadline) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" @click="openDispatch(row)">派单</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty description="当前没有待派单的工单" :image-size="70" />
        </template>
      </el-table>
    </el-card>

    <el-dialog v-model="dispatchVisible" title="派单" width="460">
      <el-alert
        v-if="dispatchTarget"
        type="info"
        :closable="false"
        show-icon
        class="dialog-tip"
        :title="`工单 ${dispatchTarget.workOrderNo}（${dispatchTarget.title}）`"
        :description="dispatchTarget.description || '（无详细描述）'"
      />
      <el-form label-width="70px" class="dialog-form">
        <el-form-item label="维修员" required>
          <el-select v-model="assigneeId" placeholder="请选择维修员" style="width: 100%" filterable>
            <el-option v-for="u in maintainers" :key="u.id" :label="userLabel(u)" :value="u.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dispatchVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="confirmDispatch">确认派单</el-button>
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

.dialog-tip {
  margin-bottom: 16px;
}
</style>
