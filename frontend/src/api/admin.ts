import http from './http'
import type {
  AuditLog,
  Notification,
  PageParams,
  Permission,
  Role,
  Seat,
  Space,
  SystemConfig,
  User,
} from './types'

/**
 * 管理端与公共数据 API
 * 对照 backend/src/shared/{rbac,spaces,audit,system-config,notifications}/*.controller.ts
 */

/* ===== 用户管理（权限 user.manage） ===== */

/** 用户列表：GET /users?keyword=&page=&pageSize=（后端返回 { items, total }） */
export function listUsers(params?: PageParams): Promise<{ items: User[]; total: number }> {
  return http.get('/users', { params }).then((r) => r.data)
}

/** 用户详情：GET /users/:id */
export function getUser(id: number): Promise<User> {
  return http.get(`/users/${id}`).then((r) => r.data)
}

/** 创建用户：POST /users */
export function createUser(data: {
  username: string
  password: string
  name: string
  email?: string
  phone?: string
  department?: string
  roleCodes?: string[]
}): Promise<User> {
  return http.post('/users', data).then((r) => r.data)
}

/** 更新用户：PUT /users/:id */
export function updateUser(
  id: number,
  data: Partial<{
    name: string
    email: string
    phone: string
    department: string
    roleCodes: string[]
    isActive: boolean
    password: string
  }>,
): Promise<User> {
  return http.put(`/users/${id}`, data).then((r) => r.data)
}

/* ===== 角色与权限（权限 role.manage） ===== */

/** 角色列表：GET /roles */
export function listRoles(): Promise<Role[]> {
  return http.get('/roles').then((r) => r.data)
}

/** 权限目录：GET /roles/permissions */
export function listPermissions(): Promise<Permission[]> {
  return http.get('/roles/permissions').then((r) => r.data)
}

/** 创建角色：POST /roles */
export function createRole(data: {
  code: string
  name: string
  description?: string
  permissionCodes?: string[]
}): Promise<Role> {
  return http.post('/roles', data).then((r) => r.data)
}

/** 更新角色（名称/描述）：PUT /roles/:id */
export function updateRole(id: number, data: { name?: string; description?: string }): Promise<Role> {
  return http.put(`/roles/${id}`, data).then((r) => r.data)
}

/** 设置角色权限：PUT /roles/:id/permissions */
export function setRolePermissions(id: number, permissionCodes: string[]): Promise<Role> {
  return http.put(`/roles/${id}/permissions`, { permissionCodes }).then((r) => r.data)
}

/** 删除角色：DELETE /roles/:id */
export function deleteRole(id: number): Promise<void> {
  return http.delete(`/roles/${id}`).then((r) => r.data)
}

/* ===== 审计日志（权限 audit.view） ===== */

/** 审计日志列表：GET /audit?keyword=&page=&pageSize=（后端返回 { items, total }） */
export function listAudit(params?: PageParams): Promise<{ items: AuditLog[]; total: number }> {
  return http.get('/audit', { params }).then((r) => r.data)
}

/* ===== 空间与座位（列表公开；写操作需 space.manage / seat.manage） ===== */

/** 空间列表：GET /spaces?keyword=&type=&isActive= */
export function listSpaces(params?: { keyword?: string; type?: string; isActive?: string }): Promise<Space[]> {
  return http.get('/spaces', { params }).then((r) => r.data)
}

/** 空间详情：GET /spaces/:id */
export function getSpace(id: number): Promise<Space> {
  return http.get(`/spaces/${id}`).then((r) => r.data)
}

/** 创建空间：POST /spaces（权限 space.manage） */
export function createSpace(data: Partial<Space>): Promise<Space> {
  return http.post('/spaces', data).then((r) => r.data)
}

/** 更新空间：PUT /spaces/:id（权限 space.manage） */
export function updateSpace(id: number, data: Partial<Space>): Promise<Space> {
  return http.put(`/spaces/${id}`, data).then((r) => r.data)
}

/** 删除空间：DELETE /spaces/:id（权限 space.manage） */
export function deleteSpace(id: number): Promise<void> {
  return http.delete(`/spaces/${id}`).then((r) => r.data)
}

/** 空间占用统计：GET /spaces/stats（权限 stats.view） */
export function occupancyStats(): Promise<Record<string, unknown>> {
  return http.get('/spaces/stats').then((r) => r.data)
}

/** 空间下座位列表：GET /spaces/:id/seats */
export function listSpaceSeats(id: number): Promise<Seat[]> {
  return http.get(`/spaces/${id}/seats`).then((r) => r.data)
}

/** 新增座位：POST /spaces/:id/seats（权限 seat.manage） */
export function createSeat(id: number, data: { seatNo: string; hasSocket?: boolean }): Promise<Seat> {
  return http.post(`/spaces/${id}/seats`, data).then((r) => r.data)
}

/** 更新座位：PUT /spaces/seats/:seatId（权限 seat.manage） */
export function updateSeat(seatId: number, data: Partial<Seat>): Promise<Seat> {
  return http.put(`/spaces/seats/${seatId}`, data).then((r) => r.data)
}

/** 座位状态历史：GET /spaces/seats/:seatId/history?limit= */
export function seatHistory(seatId: number, limit?: number): Promise<unknown[]> {
  return http.get(`/spaces/seats/${seatId}/history`, { params: { limit } }).then((r) => r.data)
}

/* ===== 系统配置（写操作需 config.manage） ===== */

/** 配置列表：GET /system-configs */
export function listConfigs(): Promise<SystemConfig[]> {
  return http.get('/system-configs').then((r) => r.data)
}

/** 设置配置：PUT /system-configs（权限 config.manage） */
export function setConfig(data: { key: string; value: string; description?: string }): Promise<SystemConfig> {
  return http.put('/system-configs', data).then((r) => r.data)
}

/* ===== 站内通知 ===== */

/** 通知列表：GET /notifications?unreadOnly= */
export function listNotifications(params?: { unreadOnly?: boolean }): Promise<Notification[]> {
  return http.get('/notifications', { params }).then((r) => r.data)
}

/** 未读数：GET /notifications/unread-count */
export function unreadCount(): Promise<{ count: number }> {
  return http.get('/notifications/unread-count').then((r) => r.data)
}

/** 标记已读：POST /notifications/:id/read */
export function markRead(id: number): Promise<Notification> {
  return http.post(`/notifications/${id}/read`).then((r) => r.data)
}

/** 全部已读：POST /notifications/read-all */
export function markAllRead(): Promise<void> {
  return http.post('/notifications/read-all').then((r) => r.data)
}
