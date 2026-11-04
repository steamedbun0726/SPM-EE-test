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
  /** @deprecated 旧实现遗留字段，ADR-0002 后占用由 occupancy 表达 */
  occupiedSeatIds: number[] | null
  rejectReason: string
  decidedAt: Date | null
  /** 详情接口返回：当前有效的时段占用（含写入来源） */
  occupancy?: OccupancyBlock[]
  approvals?: ApprovalRecord[]
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

/** 时段占用记录（ADR-0002）：一行 = 某座位/某空间在某时段被占用 */
export interface OccupancyBlock {
  occupancyId: number
  scope: 'seat' | 'space'
  source: 'M1' | 'M2' | 'M3' | 'SYSTEM'
  refType: string
  refId: number
  seatId: number | null
  date: string
  startHour: number
  endHour: number
  reason: string
}

/** 提交前冲突预检结果 */
export interface PreflightResult {
  roomRequest: { id: number; requestCode: string } | null
  seatConflicts: number
  reason: string | null
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
  /** 物理状态：ADR-0002 起不再用 occupied_by_room 表达「被预约」 */
  status: 'available' | 'maintenance'
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
