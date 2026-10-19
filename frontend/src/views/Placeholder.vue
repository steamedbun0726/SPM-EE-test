<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

/**
 * 业务占位组件：m1/m2/m3/admin 路由先复用本组件，
 * 后续任务填充真实业务页面时替换对应路由的 component 即可。
 */
const route = useRoute()

const title = computed(() => String(route.meta.title || '功能开发中'))
const description = computed(() => String(route.meta.description || '该模块正在建设中，敬请期待。'))
</script>

<template>
  <div class="page-container placeholder">
    <el-card shadow="never">
      <el-empty :description="`${title} · 功能开发中`">
        <div class="placeholder-desc">{{ description }}</div>
      </el-empty>
    </el-card>
  </div>
</template>

<style scoped>
.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
}

.placeholder-desc {
  color: #909399;
  font-size: 14px;
  margin-top: 8px;
}
</style>
