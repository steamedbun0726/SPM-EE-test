<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Bell, HomeFilled, OfficeBuilding, Reading, Setting, Tools, User } from '@element-plus/icons-vue'
import type { Component } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { listNotifications, markRead, markAllRead } from '@/api/admin'
import type { Notification } from '@/api/types'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

/* ===== 左侧菜单（按角色权限过滤） ===== */

interface MenuItem {
  path: string
  title: string
  icon: string
  children?: { path: string; title: string }[]
}

const iconMap: Record<string, Component> = {
  HomeFilled,
  Reading,
  OfficeBuilding,
  Tools,
  Setting,
}

// 主菜单：按模块聚合子页面，审批/派单/维修入口按权限动态追加
const menuItems = computed<MenuItem[]>(() => {
  const m2Children = [
    { path: '/m2', title: '教室申请' },
    { path: '/m2/my', title: '我的申请' },
  ]
  if (auth.hasPerm('room.approve')) m2Children.push({ path: '/m2/approve', title: '教室审批' })

  const m3Children = [
    { path: '/m3', title: '故障上报' },
    { path: '/m3/my', title: '我的工单' },
  ]
  if (auth.hasPerm('workorder.dispatch')) m3Children.push({ path: '/m3/assign', title: '派单台' })
  // 台账给「看得比自己的单据更广」的角色：派单、管理与查看统计
  if (
    auth.hasPerm('workorder.dispatch') ||
    auth.hasPerm('workorder.manage') ||
    auth.hasPerm('workorder.stats')
  ) {
    m3Children.push({ path: '/m3/ledger', title: '工单台账' })
  }
  if (auth.roles.includes('maintenance')) m3Children.push({ path: '/m3/desk', title: '维修台' })

  // 管理菜单：按权限码动态挂载到 /admin/* 子页面
  const adminChildren: { path: string; title: string }[] = []
  if (auth.hasPerm('user.manage')) adminChildren.push({ path: '/admin/users', title: '用户管理' })
  if (auth.hasPerm('role.manage')) adminChildren.push({ path: '/admin/roles', title: '角色与权限' })
  if (auth.hasPerm('space.manage') || auth.hasPerm('seat.manage')) {
    adminChildren.push({ path: '/admin/spaces', title: '空间与座位' })
  }
  if (auth.hasPerm('stats.view')) adminChildren.push({ path: '/admin/stats', title: '运营统计' })
  if (auth.hasPerm('audit.view')) adminChildren.push({ path: '/admin/audit', title: '审计日志' })
  if (auth.hasPerm('config.manage')) adminChildren.push({ path: '/admin/configs', title: '系统参数' })

  return [
    { path: '/home', title: '首页', icon: 'HomeFilled' },
    {
      path: '/m1',
      title: '自习座位',
      icon: 'Reading',
      children: [
        { path: '/m1', title: '座位搜索' },
        { path: '/m1/my', title: '我的预约' },
        { path: '/m1/history', title: '预约历史' },
        { path: '/m1/violations', title: '违约记录' },
      ],
    },
    { path: '/m2', title: '整教室预约', icon: 'OfficeBuilding', children: m2Children },
    { path: '/m3', title: '物业报修', icon: 'Tools', children: m3Children },
    ...(adminChildren.length ? [{ path: '/admin', title: '管理后台', icon: 'Setting', children: adminChildren }] : []),
  ]
})

/* ===== 顶栏通知铃铛 ===== */

const notifications = ref<Notification[]>([])
const unreadCount = ref(0)

async function loadNotifications() {
  try {
    notifications.value = await listNotifications()
    unreadCount.value = notifications.value.filter((n) => !n.isRead).length
  } catch {
    /* 已由拦截器统一提示 */
  }
}

async function handleRead(n: Notification) {
  if (n.isRead) return
  await markRead(n.id)
  await loadNotifications()
}

async function handleAllRead() {
  await markAllRead()
  await loadNotifications()
  ElMessage.success('已全部标记为已读')
}

function formatTime(value: string | Date) {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

/* ===== 用户下拉 ===== */

function handleUserCommand(command: string) {
  if (command === 'profile') {
    ElMessageBox.alert(
      `用户名：${auth.user?.username}\n姓名：${auth.user?.name}\n院系：${auth.user?.department || '未填写'}\n角色：${auth.roles.join('、') || '无'}`,
      '个人信息',
      { confirmButtonText: '知道了' },
    )
  } else if (command === 'logout') {
    auth.logout()
    router.push('/login')
    ElMessage.success('已退出登录')
  }
}

onMounted(loadNotifications)
</script>

<template>
  <el-container class="layout">
    <!-- 左侧菜单 -->
    <el-aside width="220px" class="layout-aside">
      <div class="logo">校园资源服务平台</div>
      <el-menu :default-active="route.path" router class="layout-menu">
        <template v-for="item in menuItems" :key="item.path">
          <el-menu-item v-if="!item.children || !item.children.length" :index="item.path">
            <el-icon><component :is="iconMap[item.icon]" /></el-icon>
            <span>{{ item.title }}</span>
          </el-menu-item>
          <el-sub-menu v-else :index="item.path">
            <template #title>
              <el-icon><component :is="iconMap[item.icon]" /></el-icon>
              <span>{{ item.title }}</span>
            </template>
            <el-menu-item v-for="child in item.children" :key="child.path" :index="child.path">
              {{ child.title }}
            </el-menu-item>
          </el-sub-menu>
        </template>
      </el-menu>
    </el-aside>

    <el-container>
      <!-- 顶栏 -->
      <el-header class="layout-header">
        <div class="header-title">CampusHub · {{ String(route.meta.title || '') }}</div>
        <div class="header-actions">
          <!-- 通知铃铛 -->
          <el-popover placement="bottom-end" :width="340" trigger="click" @show="loadNotifications">
            <template #reference>
              <el-badge :value="unreadCount" :hidden="unreadCount === 0" class="bell">
                <el-icon :size="18"><Bell /></el-icon>
              </el-badge>
            </template>
            <div class="noti-panel">
              <div class="noti-header">
                <span class="noti-header-title">通知</span>
                <el-link type="primary" :underline="false" @click="handleAllRead">全部已读</el-link>
              </div>
              <el-scrollbar max-height="320px">
                <el-empty v-if="!notifications.length" description="暂无通知" :image-size="60" />
                <div
                  v-for="n in notifications"
                  :key="n.id"
                  class="noti-item"
                  :class="{ 'is-unread': !n.isRead }"
                  @click="handleRead(n)"
                >
                  <div class="noti-title">{{ n.title }}</div>
                  <div class="noti-content">{{ n.content }}</div>
                  <div class="noti-time">{{ formatTime(n.createdAt) }}</div>
                </div>
              </el-scrollbar>
            </div>
          </el-popover>

          <!-- 用户下拉 -->
          <el-dropdown trigger="click" @command="handleUserCommand">
            <span class="user-trigger">
              <el-icon><User /></el-icon>
              <span class="user-name">{{ auth.user?.name || auth.user?.username }}</span>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">个人信息</el-dropdown-item>
                <el-dropdown-item command="logout" divided>退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </el-header>

      <!-- 内容区 -->
      <el-main class="layout-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.layout {
  height: 100%;
}

.layout-aside {
  background: #fff;
  border-right: 1px solid #e4e7ed;
  display: flex;
  flex-direction: column;
}

.logo {
  height: 56px;
  line-height: 56px;
  text-align: center;
  font-size: 16px;
  font-weight: 700;
  color: #409eff;
  border-bottom: 1px solid #f0f2f5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 12px;
}

.layout-menu {
  border-right: none;
  flex: 1;
}

.layout-header {
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
}

.header-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 24px;
}

.bell {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  color: #606266;
}

.user-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: #303133;
  outline: none;
}

.user-name {
  font-size: 14px;
}

.layout-main {
  background: #f5f7fa;
  overflow: auto;
}

/* 通知面板样式 */
.noti-panel {
  width: 100%;
}

.noti-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.noti-header-title {
  font-weight: 600;
}

.noti-item {
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  border-bottom: 1px solid #f0f2f5;
}

.noti-item:hover {
  background: #f5f7fa;
}

.noti-item.is-unread {
  background: #ecf5ff;
}

.noti-title {
  font-size: 13px;
  font-weight: 600;
  color: #303133;
}

.noti-content {
  font-size: 12px;
  color: #606266;
  margin-top: 2px;
}

.noti-time {
  font-size: 12px;
  color: #909399;
  margin-top: 4px;
}
</style>
