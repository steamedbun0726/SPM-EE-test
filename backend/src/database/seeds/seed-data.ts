import { SpaceType } from '../../database/entities/space.entity';

/** 权限目录 */
export const PERMISSIONS: Array<{ code: string; name: string; description: string }> = [
  { code: 'user.manage', name: '用户管理', description: '创建/编辑用户与角色分配' },
  { code: 'role.manage', name: '角色管理', description: '维护角色与权限' },
  { code: 'config.manage', name: '系统配置', description: '修改系统参数' },
  { code: 'space.manage', name: '空间管理', description: '登记/注销/维护自习室与教室' },
  { code: 'seat.manage', name: '座位管理', description: '登记/注销/维护座位' },
  { code: 'seat.search', name: '座位查询', description: '搜索可用座位' },
  { code: 'seat.book', name: '座位预约', description: '发起/取消座位预约' },
  { code: 'seat.signin', name: '座位签到', description: '录入签到码签到' },
  { code: 'room.apply', name: '教室预约申请', description: '提交整教室预约申请' },
  { code: 'room.approve', name: '教室审批', description: '审批整教室预约' },
  { code: 'workorder.report', name: '报修上报', description: '上报物业故障' },
  { code: 'workorder.dispatch', name: '工单派单', description: '派单、改派与升级处理' },
  { code: 'workorder.handle', name: '工单处理', description: '维修员接单、完工' },
  { code: 'workorder.accept', name: '工单验收', description: '上报人验收与评价' },
  { code: 'workorder.manage', name: '工单管理', description: '合并、强制处理等管理动作' },
  { code: 'workorder.stats', name: '工单统计', description: '查看工单统计看板' },
  { code: 'stats.view', name: '运营统计', description: '查看预约与工单统计' },
  { code: 'audit.view', name: '审计查看', description: '查看操作审计日志' },
];

/** 角色 → 权限 */
export const ROLES: Array<{ code: string; name: string; description: string; permissions: string[] }> = [
  {
    code: 'admin',
    name: '系统管理员',
    description: '拥有全部权限',
    permissions: PERMISSIONS.map((p) => p.code),
  },
  {
    code: 'room_admin',
    name: '教室管理员',
    description: '管理自习室/座位主数据、审批教室预约、查看统计',
    permissions: ['space.manage', 'seat.manage', 'room.approve', 'stats.view', 'audit.view', 'seat.search', 'workorder.report', 'workorder.handle', 'workorder.accept'],
  },
  {
    code: 'ops',
    name: '运营管理员',
    description: '查看运营统计与审计、查询座位、派单与工单管理',
    permissions: ['stats.view', 'audit.view', 'seat.search', 'workorder.report', 'workorder.dispatch', 'workorder.accept', 'workorder.manage', 'workorder.stats'],
  },
  {
    code: 'approver',
    name: '审批员',
    description: '审批整教室预约',
    permissions: ['room.approve', 'seat.search'],
  },
  {
    code: 'maintenance',
    name: '物业维修员',
    description: '接收并处理报修工单',
    permissions: ['seat.search', 'workorder.report', 'workorder.handle'],
  },
  {
    code: 'student',
    name: '学生',
    description: '预约自习座位、提交教室预约申请、上报故障、验收工单',
    permissions: ['seat.search', 'seat.book', 'seat.signin', 'room.apply', 'workorder.report', 'workorder.accept'],
  },
];

/** 演示账号（密码统一见 README） */
export const USERS: Array<{ username: string; password: string; name: string; department: string; roles: string[] }> = [
  { username: 'admin', password: 'admin123', name: '系统管理员', department: '', roles: ['admin'] },
  { username: 'room_admin', password: 'room123', name: '王老师', department: '教务办公室', roles: ['room_admin'] },
  { username: 'ops', password: 'ops123', name: '李运营', department: '后勤保障部', roles: ['ops'] },
  { username: 'maintenance', password: 'maint123', name: '张师傅', department: '后勤保障部', roles: ['maintenance'] },
  { username: 'approver', password: 'approve123', name: '陈审批', department: '教务办公室', roles: ['approver'] },
  { username: 'student', password: 'student123', name: '张三', department: '计算机学院', roles: ['student'] },
  { username: 'student2', password: 'student123', name: '李四', department: '数学学院', roles: ['student'] },
];

/** 空间与座位种子 */
export const SPACES: Array<{
  code: string;
  name: string;
  type: SpaceType;
  ownerDept: string;
  openTime: string;
  closeTime: string;
  description: string;
  seats: Array<{ seatNo: string; hasSocket: boolean }>;
}> = [
  {
    code: 'LIB-A-101',
    name: '图书馆自习区 A101',
    type: 'library',
    ownerDept: '',
    openTime: '08:00',
    closeTime: '22:00',
    description: '图书馆一层专用自习区，靠墙座位带插座',
    seats: [
      { seatNo: 'A01', hasSocket: true }, { seatNo: 'A02', hasSocket: true },
      { seatNo: 'A03', hasSocket: false }, { seatNo: 'A04', hasSocket: false },
      { seatNo: 'A05', hasSocket: true }, { seatNo: 'A06', hasSocket: false },
      { seatNo: 'A07', hasSocket: false }, { seatNo: 'A08', hasSocket: true },
      { seatNo: 'A09', hasSocket: false }, { seatNo: 'A10', hasSocket: false },
    ],
  },
  {
    code: 'LIB-A-102',
    name: '图书馆自习区 A102',
    type: 'library',
    ownerDept: '',
    openTime: '08:00',
    closeTime: '22:00',
    description: '图书馆二层自习区',
    seats: [
      { seatNo: 'B01', hasSocket: true }, { seatNo: 'B02', hasSocket: false },
      { seatNo: 'B03', hasSocket: false }, { seatNo: 'B04', hasSocket: true },
      { seatNo: 'B05', hasSocket: false }, { seatNo: 'B06', hasSocket: true },
      { seatNo: 'B07', hasSocket: false }, { seatNo: 'B08', hasSocket: false },
    ],
  },
  {
    code: 'CS-B-201',
    name: '计算机学院自习室 201',
    type: 'study',
    ownerDept: '计算机学院',
    openTime: '09:00',
    closeTime: '21:00',
    description: '院系自习室，仅对本院系同学开放',
    seats: [
      { seatNo: 'C01', hasSocket: true }, { seatNo: 'C02', hasSocket: true },
      { seatNo: 'C03', hasSocket: false }, { seatNo: 'C04', hasSocket: false },
      { seatNo: 'C05', hasSocket: true }, { seatNo: 'C06', hasSocket: false },
    ],
  },
  {
    code: 'CLASS-301',
    name: '普通教室 301',
    type: 'classroom',
    ownerDept: '',
    openTime: '07:00',
    closeTime: '22:00',
    description: '可整教室预约的普通教室',
    seats: [
      { seatNo: 'D01', hasSocket: false }, { seatNo: 'D02', hasSocket: false },
      { seatNo: 'D03', hasSocket: true }, { seatNo: 'D04', hasSocket: false },
      { seatNo: 'D05', hasSocket: false }, { seatNo: 'D06', hasSocket: true },
      { seatNo: 'D07', hasSocket: false }, { seatNo: 'D08', hasSocket: false },
      { seatNo: 'D09', hasSocket: true }, { seatNo: 'D10', hasSocket: false },
      { seatNo: 'D11', hasSocket: false }, { seatNo: 'D12', hasSocket: true },
    ],
  },
];

/** 系统参数默认值 */
export const SYSTEM_CONFIGS: Array<{ key: string; value: string; description: string }> = [
  { key: 'BOOKING_MAX_HOURS', value: '4', description: '单次预约最大小时数（M1）' },
  { key: 'NO_SHOW_GRACE_MINUTES', value: '15', description: '预约开始后未签到自动取消并记违约的宽限分钟数' },
  { key: 'REMINDER_BEFORE_MINUTES', value: '15', description: '预约开始前提醒的分钟数' },
  { key: 'REMINDER_AFTER_MINUTES', value: '10', description: '预约开始后再次提醒的分钟数' },
  { key: 'ROOM_APPROVAL_TIMEOUT_HOURS', value: '2', description: '整教室审批超时自动撤销的小时数（M2）' },
  { key: 'WORKORDER_SLA_HOURS', value: '48', description: '工单维修 SLA 兜底小时数（分类未定义时使用，M3）' },
  { key: 'WORKORDER_ESCALATE_HOURS', value: '24', description: '升级后重新计算 SLA 的小时数' },
  { key: 'WORKORDER_MAX_REOPEN', value: '3', description: '同一工单允许的最大返工次数，超过后需升级处理' },
  { key: 'WORKORDER_RESPONSE_RATIO_PERCENT', value: '25', description: '首响时限占解决时限的比例（%），构成双时限考核' },
  { key: 'WORKORDER_SLA_WARN_RATIO', value: '20', description: '剩余时限低于总时长该比例时发出超时预警（%）' },
  { key: 'WORKORDER_MAX_PHOTOS', value: '3', description: '单张工单允许上传的现场照片张数' },
  { key: 'WORKORDER_MAX_APPEAL', value: '2', description: '同一工单允许的维修员申诉次数' },
  { key: 'WORKORDER_REVISIT_RATING', value: '2', description: '验收评分低于等于该值时自动进入回访队列' },
  { key: 'WORKORDER_ETA_MAX_DAYS', value: '30', description: '预计恢复时间最远可填天数' },
  { key: 'WORKORDER_DEGRADE_WINDOW_DAYS', value: '30', description: '重复故障识别的时间窗口（天）' },
  { key: 'WORKORDER_DEGRADE_THRESHOLD', value: '3', description: '窗口期内同空间同分类故障达该次数即标记疑似设备老化' },
  { key: 'WORKORDER_REPORT_WINDOW_DAYS', value: '7', description: '恶意误报限制的统计窗口（天）' },
  { key: 'WORKORDER_MAX_CANCEL_PER_WINDOW', value: '5', description: '窗口期内允许自行取消的工单数上限，超过则限制上报' },
  { key: 'WORKORDER_HOLD_MAX_DAYS', value: '7', description: '挂起最长持续天数，超过仍未恢复则自动升级并通知派单员（M3-14）' },
];
