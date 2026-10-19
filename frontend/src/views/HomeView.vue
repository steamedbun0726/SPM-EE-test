<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { OfficeBuilding, Reading, Setting, Tools } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 14) return '中午好'
  if (hour < 18) return '下午好'
  return '晚上好'
})

// 快捷入口：主模块常显，管理后台按权限显示首个可用页面
const managerEntries = [
  { path: '/admin/users', perm: 'user.manage' },
  { path: '/admin/roles', perm: 'role.manage' },
  { path: '/admin/spaces', perm: 'space.manage' },
  { path: '/admin/stats', perm: 'stats.view' },
  { path: '/admin/audit', perm: 'audit.view' },
  { path: '/admin/configs', perm: 'config.manage' },
]

const entries = computed(() => {
  const list = [
    { path: '/m1', title: '自习座位', desc: '搜索并预约自习座位', icon: Reading },
    { path: '/m2', title: '整教室预约', desc: '申请整教室使用', icon: OfficeBuilding },
    { path: '/m3', title: '物业报修', desc: '上报设施故障', icon: Tools },
  ]
  const managerCodes = [
    'user.manage', 'role.manage', 'room.approve', 'workorder.dispatch',
    'stats.view', 'audit.view', 'config.manage', 'space.manage', 'seat.manage',
  ]
  if (managerCodes.some((c) => auth.hasPerm(c))) {
    const first = managerEntries.find((e) => auth.hasPerm(e.perm)) ?? managerEntries[0]
    list.push({ path: first.path, title: '管理后台', desc: '用户 / 角色 / 空间 / 统计 / 审计', icon: Setting })
  }
  return list
})
</script>

<template>
  <div class="page-container">
    <el-card shadow="never" class="welcome-card">
      <div class="welcome-title">{{ greeting }}，{{ auth.user?.name || auth.user?.username }}</div>
      <div class="welcome-sub">
        欢迎使用校园资源服务平台（CampusHub），一站式预约自习座位、整教室与物业报修。
      </div>
    </el-card>

    <el-row :gutter="16" class="entry-row">
      <el-col v-for="e in entries" :key="e.path" :span="6">
        <el-card shadow="hover" class="entry-card" @click="router.push(e.path)">
          <el-icon :size="36" class="entry-icon"><component :is="e.icon" /></el-icon>
          <div class="entry-title">{{ e.title }}</div>
          <div class="entry-desc">{{ e.desc }}</div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<style scoped>
.welcome-card {
  border-radius: 10px;
  margin-bottom: 16px;
  background: linear-gradient(120deg, #409eff 0%, #67c23a 100%);
  color: #fff;
  border: none;
}

.welcome-title {
  font-size: 22px;
  font-weight: 700;
}

.welcome-sub {
  margin-top: 8px;
  font-size: 14px;
  opacity: 0.9;
}

.entry-row {
  margin-top: 4px;
}

.entry-card {
  cursor: pointer;
  text-align: center;
  padding: 12px 0;
  border-radius: 10px;
  transition: transform 0.2s;
}

.entry-card:hover {
  transform: translateY(-4px);
}

.entry-icon {
  color: #409eff;
}

.entry-title {
  font-size: 16px;
  font-weight: 600;
  margin-top: 10px;
  color: #303133;
}

.entry-desc {
  font-size: 13px;
  color: #909399;
  margin-top: 4px;
}
</style>
