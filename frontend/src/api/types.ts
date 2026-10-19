/**
 * 公共类型定义：与后端接口契约严格对齐
 * 来源：backend/src/database/entities/* 与 controller DTO、JwtUser 定义
 */

/** JWT 用户信息（后端 JwtUser，auth/me 返回） */
export interface JwtUser {
  userId: number
  username: string
  name: string
  roles: string[]
  permissions: string[]
  department: string
}

/** 登录/注册返回结构 */
export interface LoginResult {
  accessToken: string
  user: JwtUser
}

/* ===== M1 座位预约 ===== */

export type ReservationStatus = 'booked' | 'checked_in' | 'cancelled' | 'no_show' | 'completed'

export interface Reservation {
  id: number
  userId: number
  seatId: number
  spaceId: number
  spaceCode: string
  spaceName: string
  seatNo: string
  date: string
  startHour: number
  endHour: number
  status: ReservationStatus
  checkInCode: string
  checkInAt: Date | null
  cancelledAt: Date | null
  noShowAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** 座位搜索入参（SearchSeatsDto） */
export interface SearchSeatsParams {
  spaceId?: number
  spaceName?: string
  date: string
  startHour: number
  endHour: number
  hasSocket?: boolean
}

/** 预约入参（BookSeatDto） */
export interface BookSeatParams {
  seatId: number
  date: string
  startHour: number
  endHour: number
}

/* ===== M2 整教室预约 ===== */

export type RoomRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'

export interface RoomBookingRequest {
  id: number
  requestCode: string
  requesterId: number
  spaceId: number
  spaceCode: string
  spaceName: string
  date: string
  startHour: number
  endHour: number
  purpose: string
  status: RoomRequestStatus
  currentLevel: number
  maxLevel: number
  timeoutAt: Date | null
  occupiedSeatIds: number[] | null
  rejectReason: string
  decidedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/** 审批记录（ApprovalRecord） */
export interface ApprovalRecord {
  id: number
  requestId: number
  approverId: number
  approverName: string
  level: number
  action: 'approve' | 'reject'
  comment: string
  createdAt: Date
}

/** 整教室预约申请入参（ApplyRoomRequestDto） */
export interface ApplyRoomRequestParams {
  spaceId: number
  date: string
  startHour: number
  endHour: number
  purpose?: string
}

/* ===== M3 物业报修 ===== */

export type WorkOrderStatus = 'reported' | 'dispatched' | 'in_progress' | 'completed' | 'accepted' | 'cancelled'
export type WorkOrderPriority = 'low' | 'medium' | 'high' | 'urgent'
export type WorkOrderTargetType = 'space' | 'seat' | 'other'

export interface WorkOrder {
  id: number
  workOrderNo: string
  reporterId: number
  title: string
  description: string
  category: string
  priority: WorkOrderPriority
  targetType: WorkOrderTargetType
  targetId: number | null
  spaceId: number | null
  status: WorkOrderStatus
  assigneeId: number | null
  escalateLevel: number
  slaDeadline: Date | null
  dispatchedAt: Date | null
  inProgressAt: Date | null
  completedAt: Date | null
  acceptedAt: Date | null
  rating: number | null
  ratingComment: string
  cancelReason: string
  createdAt: Date
  updatedAt: Date
}

/** 报修上报入参（ReportWorkOrderDto） */
export interface ReportWorkOrderParams {
  title: string
  description?: string
  category?: string
  priority?: WorkOrderPriority
  targetType: WorkOrderTargetType
  targetId?: number
  spaceId?: number
}

/* ===== 公共数据（空间/座位） ===== */

export type SpaceType = 'study' | 'classroom' | 'library' | 'other'

export interface Space {
  id: number
  code: string
  name: string
  type: SpaceType
  ownerDept: string
  openTime: string
  closeTime: string
  isActive: boolean
  description: string
  createdAt: Date
  updatedAt: Date
}

export interface Seat {
  id: number
  spaceId: number
  seatNo: string
  hasSocket: boolean
  isActive: boolean
  status: 'available' | 'maintenance' | 'occupied_by_room'
  statusSource: 'M1' | 'M2' | 'M3' | 'SYSTEM' | null
  lastStatusAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/* ===== 管理端（RBAC/审计/配置/通知） ===== */

export interface User {
  id: number
  username: string
  name: string
  email: string
  phone: string
  department: string
  isActive: boolean
  roles?: Role[]
  createdAt: Date
  updatedAt: Date
}

export interface Role {
  id: number
  code: string
  name: string
  description: string
  createdAt: Date
}

export interface Permission {
  id: number
  code: string
  name: string
  description: string
}

export interface AuditLog {
  id: number
  userId: number | null
  username: string
  action: string
  resourceType: string
  resourceId: string
  detail: string
  ip: string
  createdAt: Date
}

export interface SystemConfig {
  id: number
  key: string
  value: string
  description: string
}

export interface Notification {
  id: number
  userId: number
  type: 'reminder' | 'no_show' | 'approval' | 'workorder' | 'system'
  title: string
  content: string
  isRead: boolean
  createdAt: Date
}

/** 分页查询通用入参 */
export interface PageParams {
  keyword?: string
  page?: number
  pageSize?: number
}
