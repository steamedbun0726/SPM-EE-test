<script setup lang="ts">
import { onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

// 全局登录态处理：已登录则刷新一次用户信息（同步最新角色/权限），失败则登出
onMounted(async () => {
  if (auth.isLoggedIn) {
    try {
      await auth.fetchMe()
    } catch {
      auth.logout()
    }
  }
})
</script>

<template>
  <router-view />
</template>
