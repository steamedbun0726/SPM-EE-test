<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { listConfigs, setConfig } from '@/api/admin'
import type { SystemConfig } from '@/api/types'

const loading = ref(false)
const savingKey = ref('')
const configs = ref<SystemConfig[]>([])

async function load() {
  loading.value = true
  try {
    configs.value = await listConfigs()
  } finally {
    loading.value = false
  }
}

async function save(row: SystemConfig) {
  savingKey.value = row.key
  try {
    await setConfig({ key: row.key, value: row.value, description: row.description })
    ElMessage.success(`参数 ${row.key} 已保存，即时生效`)
  } finally {
    savingKey.value = ''
  }
}

onMounted(load)
</script>

<template>
  <div class="page-container">
    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="notice"
      title="业务参数（预约最大小时、违约宽限、SLA 等）运行时可调，保存后即时生效，无需重启服务。"
    />

    <el-card shadow="never">
      <el-table v-loading="loading" :data="configs" border stripe>
        <el-table-column prop="key" label="参数 Key" min-width="220" />
        <el-table-column label="值" min-width="180">
          <template #default="{ row }">
            <el-input v-model="row.value" size="small" />
          </template>
        </el-table-column>
        <el-table-column prop="description" label="说明" min-width="280" show-overflow-tooltip />
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" size="small" :loading="savingKey === row.key" @click="save(row)">保存</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.notice {
  margin-bottom: 16px;
}
</style>
