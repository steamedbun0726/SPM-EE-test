import { WorkOrderPriority } from '../../database/entities/work-order.entity';

/** 报修分类（固定字典，禁止自由文本，保证统计可聚合） */
export type WorkOrderCategory =
  | 'electrical' // 水电照明
  | 'plumbing' // 给排水
  | 'network' // 网络与多媒体
  | 'furniture' // 家具桌椅
  | 'lock' // 门锁门禁
  | 'hvac' // 空调通风
  | 'cleaning' // 清洁卫生
  | 'other'; // 其他

export interface WorkOrderCategoryDef {
  code: WorkOrderCategory;
  name: string;
  /** 该分类的标准解决时限（小时），作为 SLA 计算基线 */
  defaultSlaHours: number;
  /** 该分类是否通常涉及断水断电等需要立即止损的场景 */
  emergencyCapable: boolean;
}

/**
 * 分类字典。
 *
 * defaultSlaHours 的选择依据：故障对「座位能否继续使用」的影响程度。
 * 漏水/门锁直接影响当日使用，压到 8 小时；桌椅可临时规避，放宽到 48 小时。
 * 这里给的是**基线**，实际 SLA 还要乘优先级系数（见 PRIORITY_SLA_FACTOR）。
 */
export const WORK_ORDER_CATEGORIES: WorkOrderCategoryDef[] = [
  { code: 'plumbing', name: '给排水', defaultSlaHours: 8, emergencyCapable: true },
  { code: 'lock', name: '门锁门禁', defaultSlaHours: 8, emergencyCapable: true },
  { code: 'network', name: '网络与多媒体', defaultSlaHours: 12, emergencyCapable: false },
  { code: 'electrical', name: '水电照明', defaultSlaHours: 24, emergencyCapable: true },
  { code: 'hvac', name: '空调通风', defaultSlaHours: 24, emergencyCapable: false },
  { code: 'cleaning', name: '清洁卫生', defaultSlaHours: 24, emergencyCapable: false },
  { code: 'furniture', name: '家具桌椅', defaultSlaHours: 48, emergencyCapable: false },
  { code: 'other', name: '其他', defaultSlaHours: 48, emergencyCapable: false },
];

const CATEGORY_MAP = new Map(WORK_ORDER_CATEGORIES.map((c) => [c.code, c]));

export const CATEGORY_CODES = WORK_ORDER_CATEGORIES.map((c) => c.code);

export function isCategoryCode(value: unknown): value is WorkOrderCategory {
  return typeof value === 'string' && CATEGORY_MAP.has(value as WorkOrderCategory);
}

export function categoryName(code: string): string {
  return CATEGORY_MAP.get(code as WorkOrderCategory)?.name ?? '其他';
}

export function categoryDefaultSlaHours(code: string): number {
  return CATEGORY_MAP.get(code as WorkOrderCategory)?.defaultSlaHours ?? 48;
}

/**
 * 优先级系数：乘在分类基线之上。
 *
 * 为什么不给每个优先级配一个绝对小时数？因为「紧急的水电」和「紧急的桌椅」
 * 本就不该是同一个时限。锚定分类基线再按优先级缩放，才能同时表达
 * 「什么故障」和「多急」两个维度。
 */
export const PRIORITY_SLA_FACTOR: Record<WorkOrderPriority, number> = {
  urgent: 0.3, // 从 48h 压到 14h，从 8h 压到 2h
  high: 0.6,
  medium: 1,
  low: 1.5,
};

/** 优先级权重：用于待派单队列排序（数值越大越靠前） */
export const PRIORITY_WEIGHT: Record<WorkOrderPriority, number> = {
  urgent: 3,
  high: 2,
  medium: 1,
  low: 0,
};

export const PRIORITY_LABEL: Record<WorkOrderPriority, string> = {
  urgent: '紧急',
  high: '高',
  medium: '中',
  low: '低',
};

export const PRIORITY_CODES: WorkOrderPriority[] = ['low', 'medium', 'high', 'urgent'];

export function isPriorityCode(value: unknown): value is WorkOrderPriority {
  return typeof value === 'string' && (PRIORITY_CODES as string[]).includes(value);
}

/** 解决时限（小时）= 分类基线 × 优先级系数，最小 1 小时，四舍五入到整小时 */
export function resolveSlaHours(category: string, priority: WorkOrderPriority): number {
  const base = categoryDefaultSlaHours(category);
  const scaled = base * (PRIORITY_SLA_FACTOR[priority] ?? 1);
  return Math.max(1, Math.round(scaled));
}

/**
 * 首次响应时限（小时）= 解决时限 × 响应比例（默认 25%，最小 1 小时）。
 *
 * 双时限的意义：解决时限管「修好」，响应时限管「有人理」。
 * 很多差评的真实原因是「没人回话」，而不是「修得慢」，所以两者必须分开考核。
 */
export function resolveResponseHours(slaHours: number, responseRatioPercent: number): number {
  const ratio = responseRatioPercent > 0 && responseRatioPercent <= 100 ? responseRatioPercent : 25;
  return Math.max(1, Math.round((slaHours * ratio) / 100));
}

/** 状态中文标签（前端展示与通知文案共用） */
export const STATUS_LABEL: Record<string, string> = {
  reported: '待派单',
  dispatched: '已派单',
  in_progress: '维修中',
  on_hold: '已挂起',
  completed: '待验收',
  accepted: '已完成',
  cancelled: '已取消',
  merged: '已合并',
};

/** 全部状态码（含终态），用于字典接口与筛选器 */
export const STATUS_CODES = [
  'reported',
  'dispatched',
  'in_progress',
  'on_hold',
  'completed',
  'accepted',
  'cancelled',
  'merged',
];

/** 终态：不再参与任何计时与升级扫描 */
export const TERMINAL_STATUS_CODES = ['accepted', 'cancelled', 'merged'];

export function isTerminalStatus(code: string): boolean {
  return TERMINAL_STATUS_CODES.includes(code);
}

export function statusLabel(code: string): string {
  return STATUS_LABEL[code] ?? code;
}
