import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { title: '登录' },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('@/views/RegisterView.vue'),
    meta: { title: '注册' },
  },
  {
    path: '/',
    component: () => import('@/layout/Layout.vue'),
    redirect: '/home',
    children: [
      {
        path: 'home',
        name: 'home',
        component: () => import('@/views/HomeView.vue'),
        meta: { title: '首页' },
      },
      {
        path: 'm1',
        name: 'm1',
        component: () => import('@/views/m1/SeatSearch.vue'),
        meta: { title: '座位搜索', description: 'M1 自习座位预约：搜索可用座位并预约' },
      },
      {
        path: 'm1/my',
        name: 'm1-my',
        component: () => import('@/views/m1/MyReservations.vue'),
        meta: { title: '我的预约', description: 'M1 我的预约：签到 / 取消 / 动态码' },
      },
      {
        path: 'm1/history',
        name: 'm1-history',
        component: () => import('@/views/m1/HistoryView.vue'),
        meta: { title: '预约历史', description: 'M1 预约历史：再次预约' },
      },
      {
        path: 'm1/violations',
        name: 'm1-violations',
        component: () => import('@/views/m1/ViolationsView.vue'),
        meta: { title: '违约记录', description: 'M1 违约记录：no_show 历史' },
      },
      {
        path: 'm2',
        name: 'm2',
        component: () => import('@/views/m2/ApplyRoom.vue'),
        meta: { title: '教室申请', description: 'M2 整教室预约：提交申请' },
      },
      {
        path: 'm2/my',
        name: 'm2-my',
        component: () => import('@/views/m2/MyRequests.vue'),
        meta: { title: '我的申请', description: 'M2 我的申请：撤销 / 审批记录' },
      },
      {
        path: 'm2/approve',
        name: 'm2-approve',
        component: () => import('@/views/m2/ApprovalQueue.vue'),
        meta: { title: '教室审批', description: 'M2 教室审批：多级审批队列' },
      },
      {
        path: 'm3',
        name: 'm3',
        component: () => import('@/views/m3/ReportIssue.vue'),
        meta: { title: '故障上报', description: 'M3 物业报修：上报故障' },
      },
      {
        path: 'm3/my',
        name: 'm3-my',
        component: () => import('@/views/m3/MyWorkOrders.vue'),
        meta: { title: '我的工单', description: 'M3 我的工单：验收 / 取消 / 详情' },
      },
      {
        path: 'm3/assign',
        name: 'm3-assign',
        component: () => import('@/views/m3/AssignWorkOrders.vue'),
        meta: { title: '派单台', description: 'M3 派单：指派维修员' },
      },
      {
        path: 'm3/desk',
        name: 'm3-desk',
        component: () => import('@/views/m3/MaintenanceDesk.vue'),
        meta: { title: '维修台', description: 'M3 维修台：接单 / 完工' },
      },
      {
        path: 'admin',
        redirect: '/admin/stats',
      },
      {
        path: 'admin/users',
        name: 'admin-users',
        component: () => import('@/views/admin/UsersView.vue'),
        meta: { title: '用户管理' },
      },
      {
        path: 'admin/roles',
        name: 'admin-roles',
        component: () => import('@/views/admin/RolesView.vue'),
        meta: { title: '角色与权限' },
      },
      {
        path: 'admin/spaces',
        name: 'admin-spaces',
        component: () => import('@/views/admin/SpacesView.vue'),
        meta: { title: '空间与座位' },
      },
      {
        path: 'admin/stats',
        name: 'admin-stats',
        component: () => import('@/views/admin/StatsView.vue'),
        meta: { title: '运营统计' },
      },
      {
        path: 'admin/audit',
        name: 'admin-audit',
        component: () => import('@/views/admin/AuditView.vue'),
        meta: { title: '审计日志' },
      },
      {
        path: 'admin/configs',
        name: 'admin-configs',
        component: () => import('@/views/admin/ConfigView.vue'),
        meta: { title: '系统参数' },
      },
    ],
  },
  // 404 兜底
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { title: '404' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

// 全局前置守卫：未登录一律去 /login；已登录访问 /login、/register 自动跳 /home
router.beforeEach((to) => {
  const auth = useAuthStore()
  const isAuthPage = to.path === '/login' || to.path === '/register'
  if (!auth.isLoggedIn && !isAuthPage) {
    return { path: '/login', query: to.path !== '/' ? { redirect: to.fullPath } : undefined }
  }
  if (auth.isLoggedIn && isAuthPage) {
    return '/home'
  }
  return true
})

// 切换路由后更新 document 标题
router.afterEach((to) => {
  document.title = to.meta.title ? `${String(to.meta.title)} - 校园资源服务平台` : '校园资源服务平台'
})

export default router
