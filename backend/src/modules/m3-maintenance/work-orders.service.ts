import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Like, MoreThanOrEqual, Repository } from 'typeorm';
import {
  WorkOrder,
  WorkOrderPriority,
  WorkOrderStatus,
  WorkOrderTargetType,
  OPEN_WORK_ORDER_STATUSES,
} from '../../database/entities/work-order.entity';
import { WorkOrderEvent, WorkOrderEventType } from '../../database/entities/work-order-event.entity';
import { Seat } from '../../database/entities/seat.entity';
import { Space } from '../../database/entities/space.entity';
import { SeatStateService } from '../../shared/spaces/seat-state.service';
import { NotificationsService } from '../../shared/notifications/notifications.service';
import { SystemConfigService } from '../../shared/system-config/system-config.service';
import { UsersService } from '../../shared/rbac/users.service';
import { ReservationsService } from '../m1-seats/reservations.service';
import {
  PRIORITY_CODES,
  PRIORITY_LABEL,
  PRIORITY_WEIGHT,
  STATUS_CODES,
  WORK_ORDER_CATEGORIES,
  categoryName,
  isCategoryCode,
  isPriorityCode,
  resolveResponseHours,
  resolveSlaHours,
  statusLabel,
} from './work-order-policy';

/** 台账分页边界（M3-16）：单页上限防止一次性拉全量拖垮接口 */
const LIST_DEFAULT_PAGE = 1;
const LIST_DEFAULT_PAGE_SIZE = 20;
const LIST_MAX_PAGE_SIZE = 100;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 转义 LIKE 通配符：不转义时用户输入的 `%` 会让「查无此单」变成「返回全部」 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export interface ReportWorkOrderInput {
  title: string;
  description?: string;
  category?: string;
  priority?: WorkOrderPriority;
  targetType: WorkOrderTargetType;
  targetId?: number;
  spaceId?: number;
  /** 部分下架：只下架这些座位（不传则按 targetType 推导） */
  seatIds?: number[];
  /** 现场照片 URL（最多 WORKORDER_MAX_PHOTOS 张） */
  photoUrls?: string[];
  /** 预计恢复时间（ISO 字符串） */
  etaAt?: string;
  /**
   * 合并到主线工单（M3-15）：同目标已存在未完结工单、且报修人确认「这是同一个故障」时提交。
   * 提交后本单直接落为 merged，不产生新的座位下架。
   */
  mergeIntoId?: number;
}

export interface AcceptWorkOrderInput {
  /** pass=验收通过（默认） fail=验收不通过，退回维修中 */
  result?: 'pass' | 'fail';
  rating?: number;
  comment?: string;
}

export interface CompleteWorkOrderInput {
  /** 维修说明（必填）：故障原因 + 处理方式，报修人验收时可见 */
  resolutionNote?: string;
  /** 完工现场照片（可选，与已有照片合并后仍不超过上限） */
  photoUrls?: string[];
}

/** 工单视图：实体 + 解析后的字段 + 展示用标签与 SLA 进度 */
export interface WorkOrderView extends WorkOrder {
  seatIdList: number[];
  photoUrlList: string[];
  categoryLabel: string;
  priorityLabel: string;
  statusLabel: string;
  /** 距解决时限剩余毫秒（负数为已超时，null 为未设时限） */
  slaRemainMs: number | null;
  /** 解决时限已消耗比例 0-1（超时为 1） */
  slaUsedRatio: number | null;
  /** 累计挂起分钟数（含正在进行中的挂起，实时计算） */
  holdMinutes: number;
}

/** 统计看板查询条件（M3-18） */
export interface WorkOrderStatsQuery {
  /** 起始日期（含），默认近 30 天 */
  from?: string;
  /** 结束日期（不含），默认现在 */
  to?: string;
  /** 只看某个空间 */
  spaceId?: number;
}

/** 列表排序方式（M3-16） */
export type WorkOrderListSort = 'createdDesc' | 'createdAsc' | 'slaAsc' | 'priority';

/**
 * 工单列表查询条件（M3-16）。
 *
 * 与统计口径不同，这里的 `from`/`to` 是**闭区间**：按日期查台账时，
 * 「2026-10-28 到 2026-10-28」应该查到当天，而不是空列表。
 */
export interface WorkOrderListQuery {
  /** 状态：单个或逗号分隔多个，如 `reported,dispatched` */
  status?: string;
  /** 分类 code */
  category?: string;
  /** 优先级 */
  priority?: WorkOrderPriority;
  /** 空间 id */
  spaceId?: number;
  /** 维修员 id */
  assigneeId?: number;
  /** 上报人 id */
  reporterId?: number;
  /** 是否被升级过 */
  escalated?: boolean;
  /** 创建时间下界（含），`YYYY-MM-DD` 视为当天零点 */
  from?: string;
  /** 创建时间上界（含），`YYYY-MM-DD` 视为当天 23:59:59.999 */
  to?: string;
  /** 关键字：匹配工单号 / 标题 / 描述 */
  keyword?: string;
  page?: number;
  pageSize?: number;
  sort?: WorkOrderListSort;
}

/** 分页结果统一形态（M3-16 验收标准 2） */
export interface PaginatedWorkOrders {
  items: WorkOrderView[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 统计看板（M3-18）。
 *
 * 每个比率都把**分母**一并写进 definitions 随数据返回：
 * 同一份数据换个分母就能得出完全相反的结论，口径不能只写在文档里。
 */
export interface WorkOrderStats {
  range: { from: string; to: string };
  totals: {
    /** 区间内上报的工单总数（含被合并单与被取消单） */
    total: number;
    /** 当前仍未完结（reported/dispatched/in_progress/on_hold） */
    open: number;
    /** 已验收 */
    accepted: number;
    /** 已取消 */
    cancelled: number;
    /** 已合并进其它工单 */
    merged: number;
    /** 其中参与比率计算的有效工单数（total - cancelled - merged） */
    effective: number;
  };
  byStatus: Array<{ status: string; name: string; count: number }>;
  byCategory: Array<{ category: string; name: string; count: number; openCount: number }>;
  byPriority: Array<{ priority: string; name: string; count: number }>;
  kpi: {
    /** 完工率 = accepted / effective */
    completionRate: number | null;
    /** 平均首响时长（小时）= mean(firstRespondedAt - createdAt) */
    avgResponseHours: number | null;
    /** 平均解决时长（小时）= mean(acceptedAt - createdAt - 挂起时长) */
    avgResolveHours: number | null;
    /** SLA 达标率 = accepted 中 acceptedAt ≤ originalSlaDeadline 的占比 */
    slaComplianceRate: number | null;
    /** 返工率 = accepted 中 reopenCount > 0 的占比 */
    reworkRate: number | null;
    /** 验收平均分（1-5） */
    avgRating: number | null;
  };
  topSpaces: Array<{ spaceId: number; name: string; code: string; count: number; openCount: number }>;
  definitions: Record<string, string>;
}

/** 维修员负载（派单参考，M3-26） */
export interface TechnicianWorkload {
  userId: number;
  name: string;
  department: string;
  /** 在手工单（dispatched + in_progress） */
  activeCount: number;
  urgentCount: number;
  /** 历史完成数（accepted） */
  completedCount: number;
  avgRating: number | null;
  /** 平均修复时长（小时），从派单到完工 */
  avgHandleHours: number | null;
  /** 高频处理分类（技能画像，取前 3） */
  topCategories: Array<{ category: string; name: string; count: number }>;
}

/** 字典与限制（前端选择器与表单校验共用，M3-31） */
export interface WorkOrderMeta {
  categories: Array<{ code: string; name: string; defaultSlaHours: number }>;
  priorities: Array<{ code: string; name: string; slaFactor: number }>;
  statuses: Array<{ code: string; name: string }>;
  limits: {
    maxPhotos: number;
    maxReopen: number;
    maxAppeal: number;
    etaMaxDays: number;
    commentMaxLength: number;
  };
}

/** M3 物业报修工单：故障上报、派单、维修中、超时升级、完工验收与评价 */
@Injectable()
export class WorkOrdersService {
  constructor(
    @InjectRepository(WorkOrder) private readonly workOrderRepo: Repository<WorkOrder>,
    @InjectRepository(WorkOrderEvent) private readonly eventRepo: Repository<WorkOrderEvent>,
    @InjectRepository(Seat) private readonly seatRepo: Repository<Seat>,
    @InjectRepository(Space) private readonly spaceRepo: Repository<Space>,
    private readonly seatStateService: SeatStateService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: SystemConfigService,
    private readonly usersService: UsersService,
    private readonly reservationsService: ReservationsService,
  ) {}

  // ===== 基础设施 =====

  private async findById(id: number): Promise<WorkOrder> {
    const wo = await this.workOrderRepo.findOneBy({ id });
    if (!wo) throw new NotFoundException(`工单 ${id} 不存在`);
    return wo;
  }

  /**
   * 状态流转统一出口：改状态 + 落库 + 写事件，三步原子完成。
   * 禁止在 Controller 或其它 Service 直接改 wo.status，否则时间线会断链。
   */
  private async transition(
    wo: WorkOrder,
    input: {
      type: WorkOrderEventType;
      toStatus: WorkOrderStatus;
      operatorId: number | null;
      operatorName?: string;
      note?: string;
    },
  ): Promise<WorkOrder> {
    const fromStatus = wo.status;
    wo.status = input.toStatus;
    const saved = await this.workOrderRepo.save(wo);
    await this.eventRepo.save(
      this.eventRepo.create({
        workOrderId: saved.id,
        type: input.type,
        fromStatus,
        toStatus: input.toStatus,
        operatorId: input.operatorId,
        operatorName: input.operatorName ?? '',
        note: input.note ?? '',
      }),
    );
    return saved;
  }

  /** 只写事件、不改状态（用于上报、改派、升级、留言这类“状态不变”的场景） */
  private async recordEvent(
    wo: WorkOrder,
    input: {
      type: WorkOrderEventType;
      operatorId: number | null;
      operatorName?: string;
      note?: string;
      /** 显式指定变更前状态；不传则取当前状态。创建工单时传 null */
      fromStatus?: string | null;
    },
  ): Promise<void> {
    await this.eventRepo.save(
      this.eventRepo.create({
        workOrderId: wo.id,
        type: input.type,
        fromStatus: input.fromStatus === undefined ? wo.status : input.fromStatus,
        toStatus: wo.status,
        operatorId: input.operatorId,
        operatorName: input.operatorName ?? '',
        note: input.note ?? '',
      }),
    );
  }

  private parseSeatIds(raw: string): number[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is number => Number.isInteger(v));
    } catch {
      return [];
    }
  }

  private parsePhotoUrls(raw: string): string[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      return [];
    }
  }

  /** 累计挂起分钟数，含正在进行中的那一段（列表展示「已挂起 3 小时」需要实时值） */
  private holdMinutesOf(wo: WorkOrder): number {
    const base = wo.totalHoldMinutes ?? 0;
    if (wo.status !== 'on_hold' || !wo.onHoldSince) return base;
    const ongoing = Math.max(0, Math.floor((Date.now() - new Date(wo.onHoldSince).getTime()) / 60_000));
    return base + ongoing;
  }

  /** 实体 → 视图：解析 JSON 字段、补展示标签、算 SLA 进度 */
  toView(wo: WorkOrder): WorkOrderView {
    const now = Date.now();
    const created = wo.createdAt ? new Date(wo.createdAt).getTime() : now;
    const deadline = wo.slaDeadline ? new Date(wo.slaDeadline).getTime() : null;
    let slaRemainMs: number | null = null;
    let slaUsedRatio: number | null = null;
    if (deadline != null) {
      slaRemainMs = deadline - now;
      const total = deadline - created;
      // 挂起期间不消耗 SLA：比例按「已用时长 - 挂起时长」算，否则挂起越久进度条越满
      const heldMs = this.holdMinutesOf(wo) * 60_000;
      slaUsedRatio = total > 0 ? Math.min(1, Math.max(0, (now - created - heldMs) / total)) : 1;
    }
    return {
      ...wo,
      seatIdList: this.parseSeatIds(wo.seatIds),
      photoUrlList: this.parsePhotoUrls(wo.photoUrls),
      categoryLabel: categoryName(wo.category),
      priorityLabel: PRIORITY_LABEL[wo.priority] ?? wo.priority,
      statusLabel: statusLabel(wo.status),
      slaRemainMs,
      slaUsedRatio,
      holdMinutes: this.holdMinutesOf(wo),
    };
  }

  private toViewList(list: WorkOrder[]): WorkOrderView[] {
    return list.map((w) => this.toView(w));
  }

  private dateStr(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }

  /** 生成 WO-YYYYMMDD-<当天序号>（当天数量+1，三位补零） */
  private async nextWorkOrderNo(now: Date): Promise<string> {
    const prefix = `WO-${this.dateStr(now)}-`;
    const count = await this.workOrderRepo.countBy({ workOrderNo: Like(`${prefix}%`) });
    return `${prefix}${String(count + 1).padStart(3, '0')}`;
  }

  private isUniqueViolation(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return /unique|duplicate|workOrderNo/i.test(msg);
  }

  /** 派单员/管理员可见性判定（并发通知用） */
  private async managerUserIds(): Promise<number[]> {
    const users = await this.usersService.findByPermission('workorder.dispatch');
    return users.map((u) => u.id);
  }

  private async notifyManagers(title: string, content: string): Promise<void> {
    const ids = await this.managerUserIds();
    if (ids.length) await this.notificationsService.sendBatch(ids, 'workorder', title, content);
  }

  // ===== 上报 =====

  /**
   * 故障上报。
   *
   * - SLA 双时限：responseDeadline（首响）= 解决时限 × 25%，slaDeadline（解决）
   * - 座位下架：seatIds 精确指定，或按 targetType 推导；清单写入 wo.seatIds 供精确回滚
   * - 已受影响预约：调 M1 公开方法作废未来预约并通知（不计违约）
   * - 重复故障：同空间同分类窗口期内达阈值 → 标记疑似设备老化
   */
  async report(userId: number, input: ReportWorkOrderInput, operatorName?: string): Promise<WorkOrder> {
    if (!input.title || !input.title.trim()) {
      throw new BadRequestException('工单标题不能为空');
    }
    const category = input.category ?? 'other';
    if (!isCategoryCode(category)) {
      throw new BadRequestException(`报修分类 ${category} 不合法`);
    }
    const priority: WorkOrderPriority = input.priority ?? 'medium';
    if (!isPriorityCode(priority)) {
      throw new BadRequestException(`优先级 ${priority} 不合法`);
    }

    const photoUrls = await this.normalizePhotos(input.photoUrls);

    // 误报治理（M3-30）：同对象已有未结工单 → 拒绝重复上报
    const target = await this.resolveTarget(input);
    // 合并分支必须排在判重之前：否则用户按 409 提示带上 mergeIntoId 重提，
    // 会被同一条判重规则再拦一次，形成死循环。
    if (input.mergeIntoId != null) {
      return this.reportAsMerge(userId, input, target, photoUrls, category, priority, operatorName);
    }
    await this.assertNoDuplicateActive(userId, target.spaceId, target.seatIds, input.targetType, target.targetId);
    await this.assertReporterNotAbusive(userId);

    const now = new Date();
    const slaHours = resolveSlaHours(category, priority);
    const responseRatio = await this.configService.getInt('WORKORDER_RESPONSE_RATIO_PERCENT', 25);
    const responseHours = resolveResponseHours(slaHours, responseRatio);
    const slaDeadline = new Date(now.getTime() + slaHours * 3600_000);

    const draft = this.workOrderRepo.create({
      workOrderNo: await this.nextWorkOrderNo(now),
      reporterId: userId,
      title: input.title.trim(),
      description: input.description ?? '',
      category,
      priority,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      spaceId: target.spaceId,
      status: 'reported',
      slaDeadline,
      // 两处写同一时刻：后续升级会推后 slaDeadline，统计仍以原始值为准
      originalSlaDeadline: slaDeadline,
      responseDeadline: new Date(now.getTime() + responseHours * 3600_000),
      photoUrls: photoUrls.length ? JSON.stringify(photoUrls) : '',
      seatIds: target.seatIds.length ? JSON.stringify(target.seatIds) : '',
    });

    let wo: WorkOrder;
    try {
      wo = await this.workOrderRepo.save(draft);
    } catch (e) {
      // workOrderNo 唯一冲突：重新生成序号重试一次
      if (this.isUniqueViolation(e)) {
        draft.workOrderNo = await this.nextWorkOrderNo(now);
        wo = await this.workOrderRepo.save(draft);
      } else {
        throw e;
      }
    }

    // M3 → M1：座位下架（部分下架时只动 seatIds 指定的座位）
    if (target.seatIds.length) {
      await this.seatStateService.setSeatsMaintenance(
        target.seatIds,
        wo.id,
        userId,
        `报修维修中（${wo.workOrderNo}）`,
      );
    }

    // 重复故障识别（M3-25）
    if (target.spaceId != null) {
      const degraded = await this.detectDegraded(target.spaceId, category);
      if (degraded) {
        wo.degradedSuspected = true;
        await this.workOrderRepo.save(wo);
        await this.notifyManagers(
          '疑似设备老化',
          `空间 ${wo.spaceId} 的「${categoryName(category)}」类故障在近期已发生多次（工单 ${wo.workOrderNo}），建议安排整体检修而非反复小修。`,
        );
      }
    }

    const noteParts = [`上报：${wo.title}`, `分类 ${categoryName(category)}`, `优先级 ${PRIORITY_LABEL[priority]}`];
    if (target.seatIds.length) noteParts.push(`下架 ${target.seatIds.length} 个座位`);
    await this.recordEvent(wo, {
      type: 'reported',
      operatorId: userId,
      operatorName,
      note: noteParts.join('；'),
      fromStatus: null,
    });

    // 必须排在上报事件之后：时间线第一条永远是 reported，否则事件链首尾不相接
    if (target.seatIds.length) {
      await this.releaseAffectedReservations(wo, target.seatIds, userId);
    }

    // 预计恢复时间：上报时即可填（维修员/派单员后续可改）
    if (input.etaAt) {
      return this.updateEta(wo.id, userId, input.etaAt, operatorName, ['workorder.report']);
    }
    return wo;
  }

  /**
   * 重复工单合并（M3-15）：把本次上报直接挂到主线工单上，不再单独走一遍派工流程。
   *
   * 为什么不自动合并？「同房间另一个座位也坏了」和「同一个座位被重复上报」在数据上
   * 长得几乎一样，机器判错的代价是把真实故障吞掉。所以只做「检出 + 建议」，
   * 由报修人确认后才合并，判断权留在人手里。
   */
  private async reportAsMerge(
    userId: number,
    input: ReportWorkOrderInput,
    target: { spaceId: number | null; targetId: number | null; seatIds: number[] },
    photoUrls: string[],
    category: string,
    priority: WorkOrderPriority,
    operatorName?: string,
  ): Promise<WorkOrder> {
    const main = await this.findById(input.mergeIntoId as number);
    if (!OPEN_WORK_ORDER_STATUSES.includes(main.status)) {
      throw new ConflictException(
        `主线工单 ${main.workOrderNo} 已结束（${statusLabel(main.status)}），无法再合并，请单独上报`,
      );
    }
    if (main.mergedIntoId != null) {
      throw new BadRequestException('只能合并到主线工单，不能挂在已被合并的工单下');
    }
    if (main.spaceId != null && target.spaceId != null && main.spaceId !== target.spaceId) {
      throw new BadRequestException('只能合并到同一空间的工单');
    }

    const now = new Date();
    const draft = this.workOrderRepo.create({
      workOrderNo: await this.nextWorkOrderNo(now),
      reporterId: userId,
      title: input.title.trim(),
      description: input.description ?? '',
      category,
      priority,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      spaceId: target.spaceId,
      status: 'merged',
      mergedIntoId: main.id,
      // 合并单不独立计时：它没有自己的工期，SLA 由主线承担
      slaDeadline: null,
      originalSlaDeadline: null,
      responseDeadline: null,
      photoUrls: photoUrls.length ? JSON.stringify(photoUrls) : '',
      seatIds: target.seatIds.length ? JSON.stringify(target.seatIds) : '',
    });
    let merged: WorkOrder;
    try {
      merged = await this.workOrderRepo.save(draft);
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        draft.workOrderNo = await this.nextWorkOrderNo(now);
        merged = await this.workOrderRepo.save(draft);
      } else {
        throw e;
      }
    }

    // 座位并集交给主线：主线验收时按清单恢复，被合并单不再单独触发任何座位动作。
    // 正常情况下并集里不会出现新座位（真正重复的报修必然座位有交集），
    // 一旦出现说明两次报修覆盖面不同，此时不下架但要让派单员知道。
    const mainSeats = this.parseSeatIds(main.seatIds);
    const extraSeats = target.seatIds.filter((id) => !mainSeats.includes(id));
    main.seatIds = JSON.stringify([...new Set([...mainSeats, ...target.seatIds])]);
    main.mergedCount = (main.mergedCount ?? 0) + 1;
    const savedMain = await this.workOrderRepo.save(main);

    await this.recordEvent(merged, {
      type: 'merged',
      operatorId: userId,
      operatorName,
      note: `合并进工单 ${main.workOrderNo}（${main.title}）`,
      fromStatus: null,
    });
    await this.recordEvent(savedMain, {
      type: 'merge_absorbed',
      operatorId: userId,
      operatorName,
      note: `吸收重复上报 ${merged.workOrderNo}（${merged.title}），累计 ${savedMain.mergedCount} 条`,
    });

    await this.notificationsService.send(
      userId,
      'workorder',
      '已合并到已有工单',
      `您的这次上报与工单 ${main.workOrderNo}（${main.title}）属同一故障，已合并处理，无需重复跟进。维修进展请关注该工单。`,
    );
    if (extraSeats.length) {
      await this.notifyManagers(
        '合并后仍有座位未下架',
        `工单 ${main.workOrderNo} 吸收了 ${merged.workOrderNo}，后者涉及 ${extraSeats.length} 个主线未覆盖的座位（${extraSeats.join(',')}）。按合并规则未自动下架，如确认受影响请手动下架。`,
      );
    }
    return merged;
  }

  /** 照片校验（M3-28）：数量上限 + 协议白名单，防 javascript: 等注入 */
  private async normalizePhotos(photoUrls?: string[]): Promise<string[]> {
    if (!photoUrls?.length) return [];
    const maxPhotos = await this.configService.getInt('WORKORDER_MAX_PHOTOS', 3);
    if (photoUrls.length > maxPhotos) {
      throw new BadRequestException(`现场照片最多上传 ${maxPhotos} 张`);
    }
    const safe = photoUrls.map((u) => u.trim()).filter(Boolean);
    for (const url of safe) {
      const ok = /^https?:\/\//i.test(url) || /^\/uploads\//i.test(url) || /^\/api\/files\//i.test(url);
      if (!ok) throw new BadRequestException(`照片地址不合法：${url.slice(0, 32)}`);
    }
    return safe;
  }

  /**
   * 解析本次要下架的座位清单。
   * 优先级：显式 seatIds > targetType='seat' 的单座位 > targetType='space' 的全室座位。
   */
  private async resolveTarget(input: ReportWorkOrderInput): Promise<{
    spaceId: number | null;
    targetId: number | null;
    seatIds: number[];
  }> {
    // 1) 显式座位清单（部分下架）
    if (input.seatIds?.length) {
      const unique = [...new Set(input.seatIds)];
      const seats = await this.seatRepo.findBy({ id: In(unique) });
      if (seats.length !== unique.length) {
        const found = new Set(seats.map((s) => s.id));
        const missing = unique.filter((id) => !found.has(id));
        throw new NotFoundException(`座位不存在：${missing.join(',')}`);
      }
      const spaceIds = [...new Set(seats.map((s) => s.spaceId))];
      if (spaceIds.length > 1) {
        throw new BadRequestException('一次报修只能涉及同一空间的座位');
      }
      const spaceId = spaceIds[0];
      if (input.spaceId != null && input.spaceId !== spaceId) {
        throw new BadRequestException('座位与所选空间不匹配');
      }
      const invalid = seats.filter((s) => !s.isActive);
      if (invalid.length) {
        throw new BadRequestException(`座位已停用：${invalid.map((s) => s.seatNo).join(',')}`);
      }
      return { spaceId, targetId: input.targetId ?? null, seatIds: unique };
    }

    // 2) 单座位
    if (input.targetType === 'seat') {
      const seatId = input.targetId;
      if (seatId == null) throw new BadRequestException('按座位报修时必须指定 targetId');
      const seat = await this.seatRepo.findOneBy({ id: seatId });
      if (!seat) throw new NotFoundException(`座位 ${seatId} 不存在`);
      if (!seat.isActive) throw new BadRequestException('该座位已停用');
      return { spaceId: seat.spaceId, targetId: seatId, seatIds: [seatId] };
    }

    // 3) 整空间
    if (input.targetType === 'space' && input.spaceId != null) {
      const space = await this.spaceRepo.findOneBy({ id: input.spaceId });
      if (!space) throw new NotFoundException(`空间 ${input.spaceId} 不存在`);
      const seats = await this.seatRepo.find({ where: { spaceId: space.id, isActive: true } });
      return { spaceId: space.id, targetId: input.targetId ?? null, seatIds: seats.map((s) => s.id) };
    }

    return { spaceId: input.spaceId ?? null, targetId: input.targetId ?? null, seatIds: [] };
  }

  /**
   * 防重复上报（M3-30）：同一对象已有未结工单时拒绝。
   * 判重口径：同空间 + 同分类 + 未结状态。座位级报修额外要求座位集合有交集。
   */
  private async assertNoDuplicateActive(
    userId: number,
    spaceId: number | null,
    seatIds: number[],
    targetType: WorkOrderTargetType,
    targetId: number | null,
  ): Promise<void> {
    if (spaceId == null) return;
    const actives = await this.workOrderRepo.find({
      where: {
        spaceId,
        // on_hold 也算未完结：挂起期间同一故障不能再开一张新单
        status: In(OPEN_WORK_ORDER_STATUSES),
      },
    });
    for (const other of actives) {
      const otherSeats = this.parseSeatIds(other.seatIds);
      const overlap =
        seatIds.length === 0 || otherSeats.length === 0
          ? true
          : seatIds.some((id) => otherSeats.includes(id));
      if (!overlap) continue;
      // 单座位报修必须命中同一座位，避免"同房间另一个座位坏了"被误判重复
      if (targetType === 'seat' && other.targetType === 'seat' && other.targetId !== targetId) continue;
      // 附上主线工单 id：前端据此提供「合并到该工单」入口，而不是只让用户干瞪眼
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `该对象已有处理中的工单 ${other.workOrderNo}（${statusLabel(other.status)}），请勿重复上报；如为同一故障可选择合并。`,
        existingWorkOrderId: other.id,
        existingWorkOrderNo: other.workOrderNo,
        existingWorkOrderStatus: other.status,
      });
    }
  }

  /**
   * 恶意误报限制（M3-30）：窗口期内取消次数超阈值则限制上报。
   * 只统计「自己取消」的记录，不涉及被驳回场景，误伤面小。
   */
  private async assertReporterNotAbusive(userId: number): Promise<void> {
    const windowDays = await this.configService.getInt('WORKORDER_REPORT_WINDOW_DAYS', 7);
    const limit = await this.configService.getInt('WORKORDER_MAX_CANCEL_PER_WINDOW', 5);
    const since = new Date(Date.now() - windowDays * 86400_000);
    const cancelled = await this.workOrderRepo.count({
      where: { reporterId: userId, status: 'cancelled', createdAt: MoreThanOrEqual(since) },
    });
    if (cancelled >= limit) {
      throw new ConflictException(
        `近 ${windowDays} 天内已取消 ${cancelled} 条报修（上限 ${limit}），为减少无效派工已暂时限制上报，如有紧急情况请联系物业管理员`,
      );
    }
  }

  /** 重复故障识别（M3-25）：同空间同分类窗口期内达阈值 → 疑似设备老化 */
  private async detectDegraded(spaceId: number, category: string): Promise<boolean> {
    const windowDays = await this.configService.getInt('WORKORDER_DEGRADE_WINDOW_DAYS', 30);
    const threshold = await this.configService.getInt('WORKORDER_DEGRADE_THRESHOLD', 3);
    const since = new Date(Date.now() - windowDays * 86400_000);
    const count = await this.workOrderRepo.count({
      where: { spaceId, category, createdAt: MoreThanOrEqual(since) },
    });
    return count >= threshold;
  }

  /**
   * 下架导致的预约失效处置（M3-24）。
   *
   * 这是「下架」这个动作最容易被忽略的副作用：座位被置为维修中，
   * 但学生已经约好的时段还挂在那里，到点来了发现座位不能用 —— 责任在系统。
   * 所以下架后必须立即作废未来预约并通知，且不计违约。
   */
  private async releaseAffectedReservations(
    wo: WorkOrder,
    seatIds: number[],
    operatorId: number,
  ): Promise<void> {
    const affected = await this.reservationsService.cancelForSeatsUnderMaintenance(seatIds);
    if (!affected.length) return;

    const cancelled = affected.filter((a) => a.cancelled);
    const ongoing = affected.filter((a) => a.ongoing);

    for (const item of cancelled) {
      await this.notificationsService.send(
        item.userId,
        'workorder',
        '预约已被取消（座位维修）',
        `您 ${item.date} ${item.startHour}:00-${item.endHour}:00 在「${item.spaceName}」${item.seatNo} 的预约，因该座位报修（工单 ${wo.workOrderNo}）已自动取消，不会记入违约。请重新选择其他座位。`,
      );
    }
    for (const item of ongoing) {
      await this.notificationsService.send(
        item.userId,
        'workorder',
        '座位维修提醒',
        `您正在使用或即将开始使用的「${item.spaceName}」${item.seatNo} 因报修（工单 ${wo.workOrderNo}）需要维修，工作人员会尽快与您协调，请留意现场通知。`,
      );
    }
    // 正在使用的座位若需即刻施工，必须让人工介入，不能只发一条系统消息了事
    if (ongoing.length) {
      await this.notifyManagers(
        '维修与在座用户冲突',
        `工单 ${wo.workOrderNo} 涉及的 ${ongoing.length} 个座位当前有人在使用，需现场协调后再施工。`,
      );
    }

    const note = [
      `下架影响：作废预约 ${cancelled.length} 条`,
      ongoing.length ? `在座待协调 ${ongoing.length} 条` : '',
    ]
      .filter(Boolean)
      .join('；');
    await this.recordEvent(wo, {
      type: 'seats_released',
      operatorId,
      note,
    });
  }

  // ===== 派单 / 改派 / 开工 / 完工 =====

  private assertAssigneeId(assigneeId: number): void {
    if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
      throw new BadRequestException('派单维修员不合法');
    }
  }

  /** 派单：reported → dispatched。权限 workorder.dispatch 在 Controller 层校验。 */
  async dispatch(
    workOrderId: number,
    assigneeId: number,
    dispatcherUserId: number,
    dispatcherName?: string,
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (wo.status !== 'reported') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 reported 状态可派单`);
    }
    this.assertAssigneeId(assigneeId);
    wo.assigneeId = assigneeId;
    wo.dispatchedAt = new Date();
    wo.escalated = false;
    const saved = await this.transition(wo, {
      type: 'dispatched',
      toStatus: 'dispatched',
      operatorId: dispatcherUserId,
      operatorName: dispatcherName,
      note: `派单给维修员 ${assigneeId}`,
    });
    await this.notificationsService.send(
      assigneeId,
      'workorder',
      '新工单待接单',
      `工单 ${saved.workOrderNo}（${saved.title}）已派给您，优先级 ${PRIORITY_LABEL[saved.priority]}，请在首响时限前接单。`,
    );
    return saved;
  }

  /**
   * 改派：dispatched / in_progress 状态下更换维修员。
   * 状态与工单号不变，时间线记录原维修员，便于追责与统计。
   */
  async reassign(
    workOrderId: number,
    assigneeId: number,
    operatorId: number,
    operatorName?: string,
    reason?: string,
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (wo.status !== 'dispatched' && wo.status !== 'in_progress') {
      throw new ConflictException(
        `工单状态为 ${wo.status}，仅 dispatched / in_progress 状态可改派`,
      );
    }
    this.assertAssigneeId(assigneeId);
    if (wo.assigneeId === assigneeId) {
      throw new BadRequestException('新维修员与当前维修员相同，无需改派');
    }
    const previous = wo.assigneeId;
    wo.assigneeId = assigneeId;
    if (wo.status === 'dispatched') wo.dispatchedAt = new Date();
    wo.escalated = false;
    const saved = await this.workOrderRepo.save(wo);
    await this.recordEvent(saved, {
      type: 'reassigned',
      operatorId,
      operatorName,
      note: `由维修员 ${previous ?? '未指派'} 改派给 ${assigneeId}${reason ? `；原因：${reason}` : ''}`,
    });
    await this.notificationsService.send(
      assigneeId,
      'workorder',
      '工单已改派给您',
      `工单 ${saved.workOrderNo}（${saved.title}）改派给您处理${reason ? `，原因：${reason}` : ''}。`,
    );
    return saved;
  }

  /** 维修员接单：dispatched → in_progress。仅 assignee 本人可操作。 */
  async startWork(workOrderId: number, assigneeId: number, operatorName?: string): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    this.assertAssignee(wo, assigneeId);
    if (wo.status !== 'dispatched') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 dispatched 状态可开工`);
    }
    const now = new Date();
    wo.inProgressAt = now;
    // 首响只记第一次：返工后重新开工不应把「响应慢」洗成「响应快」
    if (!wo.firstRespondedAt) wo.firstRespondedAt = now;
    // 首响时限只用于考核，不阻断操作：超时也要能干活，但要留痕
    const lateHours =
      wo.responseDeadline && now > new Date(wo.responseDeadline)
        ? Math.round((now.getTime() - new Date(wo.responseDeadline).getTime()) / 3600_000)
        : 0;
    const saved = await this.transition(wo, {
      type: 'started',
      toStatus: 'in_progress',
      operatorId: assigneeId,
      operatorName,
      note: lateHours > 0 ? `维修员接单开工（首响超时 ${lateHours} 小时）` : '维修员接单开工',
    });
    await this.notificationsService.send(
      saved.reporterId,
      'workorder',
      '工单已开工',
      `您的报修工单 ${saved.workOrderNo}（${saved.title}）维修员已接单开工。`,
    );
    return saved;
  }

  /**
   * 完工：in_progress → completed。仅 assignee 本人可操作。
   *
   * 维修说明（resolutionNote）在这里是**必填**。原因很实际：报修人验收时看到的
   * 若只有一句「已修好」，既无法判断问题是否真的解决，也让事后追责无据可依。
   * 强制写清楚「换了什么、为什么坏、后续注意事项」，验收才有意义。
   */
  async complete(
    workOrderId: number,
    assigneeId: number,
    input: CompleteWorkOrderInput = {},
    operatorName?: string,
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    this.assertAssignee(wo, assigneeId);
    if (wo.status !== 'in_progress') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 in_progress 状态可完工`);
    }
    const resolutionNote = (input.resolutionNote ?? '').trim();
    if (!resolutionNote) {
      throw new BadRequestException('完工必须填写维修说明（说明故障原因与处理方式），便于上报人验收');
    }
    if (resolutionNote.length > 1000) {
      throw new BadRequestException('维修说明不能超过 1000 字');
    }

    // 完工时可一并补传现场照片（与上报时的照片合并去重，仍受张数上限约束）
    if (input.photoUrls?.length) {
      const incoming = await this.normalizePhotos(input.photoUrls);
      const merged = [...new Set([...this.parsePhotoUrls(wo.photoUrls), ...incoming])];
      const maxPhotos = await this.configService.getInt('WORKORDER_MAX_PHOTOS', 3);
      if (merged.length > maxPhotos) {
        throw new BadRequestException(`现场照片最多 ${maxPhotos} 张`);
      }
      wo.photoUrls = merged.length ? JSON.stringify(merged) : '';
    }

    wo.resolutionNote = resolutionNote;
    wo.completedAt = new Date();
    wo.escalated = false; // 已完工，不再属于升级待处理
    const saved = await this.transition(wo, {
      type: 'completed',
      toStatus: 'completed',
      operatorId: assigneeId,
      operatorName,
      note: resolutionNote,
    });
    await this.notificationsService.send(
      saved.reporterId,
      'workorder',
      '维修已完成，待您验收',
      `工单 ${saved.workOrderNo}（${saved.title}）已维修完成，请到场确认后验收。维修说明：${resolutionNote.slice(0, 100)}`,
    );
    return saved;
  }

  // ===== 挂起与恢复（M3-14） =====

  /**
   * 维修员申请挂起（第一步）。
   *
   * 关键设计：申请时**不改状态、不停表**。挂起的本质是「我要暂停 SLA 考核」，
   * 如果维修员一按按钮就停表，那 SLA 制度就退化成自证豁免；
   * 必须由派单员确认，才轮到时钟暂停。
   */
  async requestHold(
    workOrderId: number,
    assigneeId: number,
    reason: string,
    operatorName?: string,
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    this.assertAssignee(wo, assigneeId);
    if (wo.status !== 'dispatched' && wo.status !== 'in_progress') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅已派单/维修中可申请挂起`);
    }
    if (wo.holdRequested) {
      throw new ConflictException('已有待确认的挂起申请，请等待派单员处理');
    }
    const text = (reason ?? '').trim();
    if (!text) throw new BadRequestException('挂起必须填写原因（如：等厂家配件、需停电作业）');
    if (text.length > 200) throw new BadRequestException('挂起原因不能超过 200 字');

    wo.holdReason = text;
    wo.holdRequested = true;
    wo.holdRequestedAt = new Date();
    wo.holdRequestedBy = assigneeId;
    const saved = await this.workOrderRepo.save(wo);
    await this.recordEvent(saved, {
      type: 'hold_requested',
      operatorId: assigneeId,
      operatorName,
      note: `申请挂起：${text}`,
    });
    await this.notifyManagers(
      '挂起申请待确认',
      `工单 ${saved.workOrderNo}（${saved.title}）维修员申请挂起：${text}。确认后 SLA 计时暂停。`,
    );
    return saved;
  }

  /**
   * 派单员确认/驳回挂起申请（第二步）。
   *
   * 同意后：状态置 on_hold，记录 onHoldSince，SLA 从此刻起暂停；
   * 座位**保持下架**（故障没修好，不能因为流程暂停就放回可预约池）。
   */
  async confirmHold(
    workOrderId: number,
    handlerId: number,
    approve: boolean,
    handlerName?: string,
    note?: string,
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (!wo.holdRequested) {
      throw new ConflictException('该工单没有待确认的挂起申请');
    }
    if (wo.status !== 'dispatched' && wo.status !== 'in_progress') {
      throw new ConflictException(`工单状态为 ${wo.status}，当前不可挂起`);
    }

    if (!approve) {
      wo.holdRequested = false;
      wo.holdRequestedAt = null;
      wo.holdRequestedBy = null;
      const saved = await this.workOrderRepo.save(wo);
      await this.recordEvent(saved, {
        type: 'hold_rejected',
        operatorId: handlerId,
        operatorName: handlerName,
        note: `挂起申请驳回${note ? `：${note}` : ''}`,
      });
      if (saved.assigneeId != null) {
        await this.notificationsService.send(
          saved.assigneeId,
          'workorder',
          '挂起申请未通过',
          `工单 ${saved.workOrderNo} 的挂起申请未通过${note ? `，原因：${note}` : ''}，请按原时限继续处理。`,
        );
      }
      return saved;
    }

    const now = new Date();
    wo.preHoldStatus = wo.status;
    wo.onHoldSince = now;
    wo.holdRequested = false;
    wo.holdEscalated = false;
    const saved = await this.transition(wo, {
      type: 'hold',
      toStatus: 'on_hold',
      operatorId: handlerId,
      operatorName: handlerName,
      note: `挂起生效：${wo.holdReason}${note ? `；${note}` : ''}`,
    });

    if (saved.assigneeId != null) {
      await this.notificationsService.send(
        saved.assigneeId,
        'workorder',
        '挂起已生效',
        `工单 ${saved.workOrderNo} 已挂起，SLA 计时暂停。原因：${saved.holdReason}。恢复处理后请及时点击「恢复」。`,
      );
    }
    await this.notificationsService.send(
      saved.reporterId,
      'workorder',
      '维修进度：暂时挂起',
      `您的报修工单 ${saved.workOrderNo}（${saved.title}）因「${saved.holdReason}」暂时挂起，维修时限相应顺延。如急需处理请联系物业说明情况。`,
    );
    return saved;
  }

  /**
   * 恢复维修（第三步）：状态回到挂起前，两个时限按挂起时长整体顺延。
   *
   * 顺延而不是重算：重算会凭空多出一段工期，等于挂起一次奖励一段时间。
   * 同时更新 originalSlaDeadline，保证事后统计 SLA 达标率时不会把挂起算成超时。
   */
  async resumeFromHold(
    workOrderId: number,
    operatorId: number,
    operatorName?: string,
    privileges: string[] = [],
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (wo.status !== 'on_hold' || !wo.onHoldSince) {
      throw new ConflictException(`工单状态为 ${wo.status}，仅已挂起状态可恢复`);
    }
    const isManager =
      privileges.includes('workorder.dispatch') || privileges.includes('workorder.manage');
    if (wo.assigneeId !== operatorId && !isManager) {
      throw new ForbiddenException('仅该工单维修员或派单员可恢复维修');
    }

    const now = new Date();
    const holdMs = Math.max(0, now.getTime() - new Date(wo.onHoldSince).getTime());
    const holdMinutes = Math.round(holdMs / 60_000);
    wo.totalHoldMinutes = (wo.totalHoldMinutes ?? 0) + holdMinutes;
    if (wo.slaDeadline) wo.slaDeadline = new Date(new Date(wo.slaDeadline).getTime() + holdMs);
    if (wo.originalSlaDeadline) {
      wo.originalSlaDeadline = new Date(new Date(wo.originalSlaDeadline).getTime() + holdMs);
    }
    if (wo.responseDeadline) {
      wo.responseDeadline = new Date(new Date(wo.responseDeadline).getTime() + holdMs);
    }
    const backTo: WorkOrderStatus =
      wo.preHoldStatus === 'dispatched' ? 'dispatched' : 'in_progress';
    wo.onHoldSince = null;
    wo.preHoldStatus = '';
    wo.holdEscalated = false;
    wo.slaWarned = false; // 时限已变，允许重新预警

    const holdHours = Math.max(1, Math.round(holdMinutes / 60));
    const totalHours = Math.round((wo.totalHoldMinutes ?? 0) / 60);
    const saved = await this.transition(wo, {
      type: 'resumed',
      toStatus: backTo,
      operatorId,
      operatorName,
      note: `恢复维修，本次挂起 ${holdHours} 小时，累计挂起 ${totalHours} 小时`,
    });
    await this.notificationsService.send(
      saved.reporterId,
      'workorder',
      '维修已恢复',
      `您的报修工单 ${saved.workOrderNo}（${saved.title}）已恢复处理，解决时限已按挂起时长顺延 ${holdHours} 小时。`,
    );
    return saved;
  }

  // ===== 事后合并（M3-15） =====

  /**
   * 把一张已存在的工单合并到主线。
   *
   * 与上报时直接合并的区别：这里是「两张单都已经开出来了，事后发现是同一件事」。
   * 处置要点是**座位恢复责任转移**：被合并单名下的座位清单并入主线，
   * 今后由主线的验收/取消来恢复；被合并单自己清空清单，避免它被单独操作时
   * 把主线还在修的座位提前放出去。
   */
  async mergeInto(
    workOrderId: number,
    intoId: number,
    operatorId: number,
    operatorName?: string,
    privileges: string[] = [],
  ): Promise<WorkOrder> {
    if (workOrderId === intoId) {
      throw new BadRequestException('不能将工单合并到自身');
    }
    const wo = await this.findById(workOrderId);
    const main = await this.findById(intoId);

    const isManager =
      privileges.includes('workorder.dispatch') || privileges.includes('workorder.manage');
    if (wo.reporterId !== operatorId && !isManager) {
      throw new ForbiddenException('仅上报人本人或派单员可合并工单');
    }
    if (!OPEN_WORK_ORDER_STATUSES.includes(wo.status)) {
      throw new ConflictException(`工单 ${wo.workOrderNo} 已结束（${statusLabel(wo.status)}），无需合并`);
    }
    if (!OPEN_WORK_ORDER_STATUSES.includes(main.status)) {
      throw new ConflictException(
        `目标工单 ${main.workOrderNo} 已结束（${statusLabel(main.status)}），不能作为主线`,
      );
    }
    if (main.mergedIntoId != null) {
      throw new BadRequestException('目标工单自身已被合并，请合并到它的主线工单');
    }
    if (wo.spaceId != null && main.spaceId != null && wo.spaceId !== main.spaceId) {
      throw new BadRequestException('只能合并同一空间的工单');
    }

    const mainSeats = this.parseSeatIds(main.seatIds);
    const woSeats = this.parseSeatIds(wo.seatIds);
    main.seatIds = JSON.stringify([...new Set([...mainSeats, ...woSeats])]);
    main.mergedCount = (main.mergedCount ?? 0) + 1;
    const savedMain = await this.workOrderRepo.save(main);

    // 被合并单交出自己的座位清单与时限：它不再独立承担任何 SLA 与恢复义务
    wo.seatIds = '';
    wo.slaDeadline = null;
    wo.responseDeadline = null;
    wo.holdRequested = false;
    wo.mergedIntoId = main.id;
    const saved = await this.transition(wo, {
      type: 'merged',
      toStatus: 'merged',
      operatorId,
      operatorName,
      note: `合并进工单 ${main.workOrderNo}（${main.title}）${
        woSeats.length ? `；${woSeats.length} 个座位的恢复责任转移至主线` : ''
      }`,
    });
    await this.recordEvent(savedMain, {
      type: 'merge_absorbed',
      operatorId,
      operatorName,
      note: `吸收工单 ${saved.workOrderNo}（${saved.title}），累计 ${savedMain.mergedCount} 条`,
    });

    if (saved.reporterId !== operatorId) {
      await this.notificationsService.send(
        saved.reporterId,
        'workorder',
        '您的工单已合并',
        `工单 ${saved.workOrderNo}（${saved.title}）与 ${main.workOrderNo} 属同一故障，已合并处理，请关注 ${main.workOrderNo} 的进展。`,
      );
    }
    if (saved.assigneeId != null && saved.assigneeId !== savedMain.assigneeId) {
      await this.notificationsService.send(
        saved.assigneeId,
        'workorder',
        '工单已合并，无需继续处理',
        `工单 ${saved.workOrderNo} 已合并到 ${main.workOrderNo}，无需单独处理。`,
      );
    }
    return saved;
  }

  // ===== 验收 / 返还 / 申诉 =====

  /**
   * 验收：completed → accepted（通过）/ in_progress（不通过，返工）。
   *
   * - 通过：记录评分，恢复座位；评分 ≤ 阈值时自动进入回访队列
   * - 不通过：返工计数 +1，座位**保持下架**（故障未修复不应恢复可约），
   *   超过 WORKORDER_MAX_REOPEN 次后拒绝，提示走申诉/升级
   */
  async accept(
    workOrderId: number,
    reporterId: number,
    input: AcceptWorkOrderInput = {},
    reporterName?: string,
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (wo.reporterId !== reporterId) {
      throw new ForbiddenException('仅上报人可验收工单');
    }
    if (wo.status !== 'completed') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 completed 状态可验收`);
    }

    // 验收不通过 → 返工
    if (input.result === 'fail') {
      const maxReopen = await this.configService.getInt('WORKORDER_MAX_REOPEN', 3);
      if (wo.reopenCount >= maxReopen) {
        throw new ConflictException(
          `该工单已返工 ${wo.reopenCount} 次，达到上限 ${maxReopen}，请升级由派单员处理`,
        );
      }
      wo.reopenCount += 1;
      wo.completedAt = null;
      wo.rating = null;
      wo.ratingComment = '';
      // 新的返工事实产生，旧申诉结论失效，允许维修员重新申诉
      wo.appealReason = '';
      wo.appealAt = null;
      wo.appealResult = null;
      wo.appealHandledBy = null;
      wo.appealHandledAt = null;
      const saved = await this.transition(wo, {
        type: 'rejected',
        toStatus: 'in_progress',
        operatorId: reporterId,
        operatorName: reporterName,
        note: input.comment || '验收不通过，退回返工',
      });
      if (saved.assigneeId != null) {
        await this.notificationsService.send(
          saved.assigneeId,
          'workorder',
          '验收未通过，需返工',
          `工单 ${saved.workOrderNo}（${saved.title}）验收未通过：${input.comment || '未填写原因'}。第 ${saved.reopenCount} 次返工，如认为判断有误可提交申诉。`,
        );
      }
      return saved;
    }

    if (input.rating != null && (input.rating < 1 || input.rating > 5)) {
      throw new BadRequestException('验收评分须在 1-5 之间');
    }
    wo.acceptedAt = new Date();
    wo.rating = input.rating ?? null;
    wo.ratingComment = input.comment ?? '';

    // 低分自动回访（M3-27）：差评不能只存下来，要有人跟
    const revisitThreshold = await this.configService.getInt('WORKORDER_REVISIT_RATING', 2);
    const needRevisit = wo.rating != null && wo.rating <= revisitThreshold;
    if (needRevisit) {
      wo.revisitRequired = true;
      wo.revisitHandled = false;
    }

    const saved = await this.transition(wo, {
      type: 'accepted',
      toStatus: 'accepted',
      operatorId: reporterId,
      operatorName: reporterName,
      note: input.comment ?? '验收通过',
    });

    await this.restoreSeats(saved, reporterId, '工单验收通过');

    if (needRevisit) {
      await this.notifyManagers(
        '低分回访待处理',
        `工单 ${saved.workOrderNo}（${saved.title}）验收评分 ${saved.rating} 分：${saved.ratingComment || '未填写评价'}，请安排回访。`,
      );
    }
    return saved;
  }

  /** 按工单记录的座位清单精确恢复；旧数据无清单时回退到整空间恢复 */
  private async restoreSeats(wo: WorkOrder, operatorId: number, reason: string): Promise<number> {
    const ids = this.parseSeatIds(wo.seatIds);
    if (ids.length) {
      return this.seatStateService.restoreSeatsAfterMaintenance(ids, wo.id, operatorId, reason);
    }
    if (wo.spaceId != null) {
      return this.seatStateService.restoreAfterMaintenance(wo.spaceId, wo.id, operatorId, reason);
    }
    return 0;
  }

  /**
   * 维修员申诉（M3-22）：对「验收不通过」有异议时提出，由派单员裁决。
   * 只允许在返工状态下申诉，且同一轮返工只能申诉一次。
   */
  async appeal(
    workOrderId: number,
    assigneeId: number,
    reason: string,
    operatorName?: string,
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    this.assertAssignee(wo, assigneeId);
    if (wo.status !== 'in_progress' || wo.reopenCount === 0) {
      throw new ConflictException('仅在被验收不通过、处于返工状态时可申诉');
    }
    if (!reason || !reason.trim()) {
      throw new BadRequestException('申诉必须填写理由');
    }
    if (wo.appealAt != null && wo.appealResult == null) {
      throw new ConflictException('已有待裁决的申诉，请等待处理');
    }
    const maxAppeal = await this.configService.getInt('WORKORDER_MAX_APPEAL', 2);
    const appealTimes = await this.eventRepo.countBy({ workOrderId, type: 'appealed' });
    if (appealTimes >= maxAppeal) {
      throw new ConflictException(`同一工单最多申诉 ${maxAppeal} 次，请通过其他渠道反馈`);
    }

    wo.appealReason = reason.trim();
    wo.appealAt = new Date();
    wo.appealResult = null;
    wo.appealHandledBy = null;
    wo.appealHandledAt = null;
    const saved = await this.workOrderRepo.save(wo);
    await this.recordEvent(saved, {
      type: 'appealed',
      operatorId: assigneeId,
      operatorName,
      note: reason.trim(),
    });
    await this.notificationsService.send(
      saved.reporterId,
      'workorder',
      '维修员提出申诉',
      `工单 ${saved.workOrderNo} 的维修员对验收意见提出申诉：${reason.trim()}。将由物业管理员裁决。`,
    );
    await this.notifyManagers(
      '工单申诉待裁决',
      `工单 ${saved.workOrderNo}（${saved.title}）维修员申诉：${reason.trim()}`,
    );
    return saved;
  }

  /**
   * 申诉裁决（M3-22）。
   *
   * - upheld（维持返工）：维修员仍需返工，状态保持 in_progress
   * - overturned（推翻返工）：认定维修合格，**视同验收通过**并恢复座位。
   *   之所以不退回 completed 让报修人再验一次，是为了避免「拒验—申诉—再拒验」死循环；
   *   争议一旦进入管理员裁决，就以裁决为终局。
   */
  async resolveAppeal(
    workOrderId: number,
    handlerId: number,
    result: 'upheld' | 'overturned',
    handlerName?: string,
    note?: string,
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (wo.appealAt == null || wo.appealResult != null) {
      throw new ConflictException('该工单没有待裁决的申诉');
    }
    if (result !== 'upheld' && result !== 'overturned') {
      throw new BadRequestException('裁决结果只能是 upheld 或 overturned');
    }

    wo.appealResult = result;
    wo.appealHandledBy = handlerId;
    wo.appealHandledAt = new Date();

    if (result === 'overturned') {
      wo.reopenCount = Math.max(0, wo.reopenCount - 1);
      wo.acceptedAt = new Date();
      const saved = await this.transition(wo, {
        type: 'appeal_resolved',
        toStatus: 'accepted',
        operatorId: handlerId,
        operatorName: handlerName,
        note: `申诉成立，推翻验收不通过意见，视同验收通过${note ? `；${note}` : ''}`,
      });
      await this.restoreSeats(saved, handlerId, '申诉裁决通过，恢复座位');
      await this.notificationsService.send(
        saved.reporterId,
        'workorder',
        '申诉裁决结果：维修合格',
        `工单 ${saved.workOrderNo} 的申诉经核查成立，认定维修已完成，工单关闭${note ? `。说明：${note}` : ''}。如仍有问题请重新报修。`,
      );
      if (saved.assigneeId != null) {
        await this.notificationsService.send(
          saved.assigneeId,
          'workorder',
          '申诉裁决结果：申诉成立',
          `工单 ${saved.workOrderNo} 的申诉成立，返工要求已撤销。`,
        );
      }
      return saved;
    }

    const saved = await this.workOrderRepo.save(wo);
    await this.recordEvent(saved, {
      type: 'appeal_resolved',
      operatorId: handlerId,
      operatorName: handlerName,
      note: `申诉不成立，维持返工${note ? `；${note}` : ''}`,
    });
    if (saved.assigneeId != null) {
      await this.notificationsService.send(
        saved.assigneeId,
        'workorder',
        '申诉裁决结果：维持返工',
        `工单 ${saved.workOrderNo} 的申诉未获支持，请继续返工${note ? `。说明：${note}` : ''}。`,
      );
    }
    return saved;
  }

  // ===== 留言 / ETA / 照片 =====

  /** 参与者判定：上报人、指派维修员、具派单/管理权限者 */
  private assertParticipant(wo: WorkOrder, userId: number, privileges: string[] = []): void {
    const isOwner = wo.reporterId === userId;
    const isAssignee = wo.assigneeId === userId;
    const isManager =
      privileges.includes('workorder.dispatch') || privileges.includes('workorder.manage');
    if (!isOwner && !isAssignee && !isManager) {
      throw new ForbiddenException('无权操作该工单');
    }
  }

  /** 工单留言（M3-20）：作为时间线事件留痕，不单独建表 */
  async addComment(
    workOrderId: number,
    userId: number,
    content: string,
    operatorName?: string,
    privileges: string[] = [],
  ): Promise<WorkOrderEvent> {
    const wo = await this.findById(workOrderId);
    this.assertParticipant(wo, userId, privileges);
    const text = (content ?? '').trim();
    if (!text) throw new BadRequestException('留言内容不能为空');
    if (text.length > 500) throw new BadRequestException('留言不能超过 500 字');

    await this.recordEvent(wo, {
      type: 'commented',
      operatorId: userId,
      operatorName,
      note: text,
    });
    const events = await this.eventRepo.find({
      where: { workOrderId, type: 'commented' },
      order: { id: 'DESC' },
      take: 1,
    });
    const created = events[0];

    // 留言要送到「对方」那里，否则等于自言自语
    const targets = new Set<number>();
    if (wo.reporterId !== userId) targets.add(wo.reporterId);
    if (wo.assigneeId != null && wo.assigneeId !== userId) targets.add(wo.assigneeId);
    if (targets.size) {
      await this.notificationsService.sendBatch(
        [...targets],
        'workorder',
        '工单有新留言',
        `工单 ${wo.workOrderNo}（${wo.title}）${operatorName || '有人'}留言：${text.slice(0, 80)}`,
      );
    }
    return created;
  }

  /**
   * 更新预计恢复时间（M3-21）。
   * 报修人最关心的不是「修没修完」，而是「还要多久」，所以 ETA 必须可改、可通知。
   */
  async updateEta(
    workOrderId: number,
    userId: number,
    etaAt: string,
    operatorName?: string,
    privileges: string[] = [],
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    this.assertParticipant(wo, userId, privileges);
    if (wo.status === 'accepted' || wo.status === 'cancelled') {
      throw new ConflictException('工单已结束，无法更新预计恢复时间');
    }
    const eta = new Date(etaAt);
    if (Number.isNaN(eta.getTime())) throw new BadRequestException('预计恢复时间格式不合法');
    const now = Date.now();
    if (eta.getTime() <= now) {
      throw new BadRequestException('预计恢复时间必须晚于当前时间');
    }
    const maxDays = await this.configService.getInt('WORKORDER_ETA_MAX_DAYS', 30);
    if (eta.getTime() > now + maxDays * 86400_000) {
      throw new BadRequestException(`预计恢复时间不能超过 ${maxDays} 天`);
    }

    const previous = wo.etaAt;
    wo.etaAt = eta;
    const saved = await this.workOrderRepo.save(wo);
    await this.recordEvent(saved, {
      type: 'eta_updated',
      operatorId: userId,
      operatorName,
      note: previous
        ? `预计恢复时间由 ${new Date(previous).toLocaleString('zh-CN')} 调整为 ${eta.toLocaleString('zh-CN')}`
        : `预计恢复时间 ${eta.toLocaleString('zh-CN')}`,
    });
    await this.notificationsService.send(
      saved.reporterId,
      'workorder',
      '预计恢复时间已更新',
      `工单 ${saved.workOrderNo}（${saved.title}）预计于 ${eta.toLocaleString('zh-CN')} 前恢复使用。`,
    );
    return saved;
  }

  /** 补传现场照片（M3-28）：上报人/维修员均可，覆盖式更新 */
  async updatePhotos(
    workOrderId: number,
    userId: number,
    photoUrls: string[],
    operatorName?: string,
    privileges: string[] = [],
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    this.assertParticipant(wo, userId, privileges);
    if (wo.status === 'accepted' || wo.status === 'cancelled') {
      throw new ConflictException('工单已结束，无法补传照片');
    }
    const safe = await this.normalizePhotos(photoUrls);
    wo.photoUrls = safe.length ? JSON.stringify(safe) : '';
    const saved = await this.workOrderRepo.save(wo);
    await this.recordEvent(saved, {
      type: 'commented',
      operatorId: userId,
      operatorName,
      note: `更新现场照片 ${safe.length} 张`,
    });
    return saved;
  }

  // ===== 取消 =====

  /** 上报人取消：仅 reported/dispatched 可取消；曾下架座位则按清单恢复。 */
  async cancel(
    workOrderId: number,
    userId: number,
    input: { reason?: string } = {},
    operatorName?: string,
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (wo.reporterId !== userId) {
      throw new ForbiddenException('仅上报人可取消工单');
    }
    if (wo.status !== 'reported' && wo.status !== 'dispatched') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 reported/dispatched 状态可取消`);
    }
    wo.cancelReason = input.reason ?? '';
    const saved = await this.transition(wo, {
      type: 'cancelled',
      toStatus: 'cancelled',
      operatorId: userId,
      operatorName,
      note: input.reason ?? '',
    });

    // 取消后座位应恢复可约：按清单精确恢复，避免把别的工单下架的座位一起放开
    const restored = await this.restoreSeats(saved, userId, '工单取消，恢复座位');
    if (restored) {
      await this.recordEvent(saved, {
        type: 'seats_released',
        operatorId: userId,
        note: `恢复座位 ${restored} 个`,
      });
    }
    if (saved.assigneeId != null) {
      await this.notificationsService.send(
        saved.assigneeId,
        'workorder',
        '工单已取消',
        `工单 ${saved.workOrderNo}（${saved.title}）已由上报人取消${input.reason ? `，原因：${input.reason}` : ''}。`,
      );
    }
    return saved;
  }

  // ===== 查询 =====

  /** 我上报的工单 */
  async listMine(userId: number, query: { status?: WorkOrderStatus } = {}): Promise<WorkOrderView[]> {
    const where: Record<string, unknown> = { reporterId: userId };
    if (query.status) where.status = query.status;
    const rows = await this.workOrderRepo.find({ where, order: { id: 'DESC' } });
    return this.toViewList(rows);
  }

  /**
   * 待派单队列：按优先级降序，同级按解决时限升序（越急越前）。
   * 优先级如果只体现在字段上、不影响排队顺序，那就只是个装饰。
   */
  async listPending(): Promise<WorkOrderView[]> {
    const rows = await this.workOrderRepo
      .createQueryBuilder('w')
      .where('w.status = :status', { status: 'reported' })
      .orderBy(
        `CASE w.priority WHEN 'urgent' THEN ${PRIORITY_WEIGHT.urgent} WHEN 'high' THEN ${PRIORITY_WEIGHT.high} WHEN 'medium' THEN ${PRIORITY_WEIGHT.medium} ELSE ${PRIORITY_WEIGHT.low} END`,
        'DESC',
      )
      .addOrderBy('w.slaDeadline', 'ASC')
      .addOrderBy('w.id', 'ASC')
      .getMany();
    return this.toViewList(rows);
  }

  /** 我接的工单（维修员视角） */
  async listAssignments(assigneeId: number): Promise<WorkOrderView[]> {
    const rows = await this.workOrderRepo.find({ where: { assigneeId }, order: { id: 'DESC' } });
    return this.toViewList(rows);
  }

  /** 升级待处理列表（派单员视角）：SLA 超时且尚未被处理的工单 */
  async listEscalated(): Promise<WorkOrderView[]> {
    const rows = await this.workOrderRepo.find({ where: { escalated: true }, order: { id: 'ASC' } });
    return this.toViewList(rows);
  }

  /** 低分回访待处理（M3-27） */
  async listRevisits(): Promise<WorkOrderView[]> {
    const rows = await this.workOrderRepo.find({
      where: { revisitRequired: true, revisitHandled: false },
      order: { id: 'ASC' },
    });
    return this.toViewList(rows);
  }

  /** 疑似设备老化清单（M3-25） */
  async listDegraded(): Promise<WorkOrderView[]> {
    const rows = await this.workOrderRepo.find({
      where: { degradedSuspected: true },
      order: { id: 'DESC' },
      take: 100,
    });
    return this.toViewList(rows);
  }

  /**
   * 挂起总览（M3-14）：派单员一处看完「谁在申请挂起」与「哪些已经挂着」。
   * 拆成两个数组而不是一个列表，因为两类要做的事完全不同：前者是审批，后者是催办。
   */
  async listHoldOverview(): Promise<{ requests: WorkOrderView[]; onHold: WorkOrderView[] }> {
    const [requests, onHold] = await Promise.all([
      this.workOrderRepo.find({ where: { holdRequested: true }, order: { id: 'ASC' } }),
      this.workOrderRepo.find({ where: { status: 'on_hold' }, order: { id: 'ASC' } }),
    ]);
    return { requests: this.toViewList(requests), onHold: this.toViewList(onHold) };
  }

  /**
   * 工单台账（M3-16）：多条件组合筛选 + 分页 + 关键字搜索。
   *
   * 三个看着是细节、实际会咬人的地方：
   * 1. **非法页码必须返回空列表**。前端刷新过快、书签里的旧页码都会越界，
   *    一次 500 就是整页白屏，而台账是运营每天都在翻的页面。
   * 2. **关键字要转义 LIKE 通配符**。用户搜一个不存在的编号但带了 `%`，
   *    不转义就会变成「返回全部数据」，排查问题的人会把这个结果当真。
   * 3. **时间区间取闭区间**。按日期查台账时「同一天到同一天」应该有结果，
   *    沿用统计接口的左闭右开会让人以为当天没数据。
   */
  async listAll(query: WorkOrderListQuery = {}): Promise<PaginatedWorkOrders> {
    const page =
      Number.isInteger(query.page) && (query.page as number) >= 1
        ? (query.page as number)
        : LIST_DEFAULT_PAGE;
    const pageSizeRaw = Number.isInteger(query.pageSize) ? (query.pageSize as number) : 0;
    const pageSize =
      pageSizeRaw >= 1 ? Math.min(pageSizeRaw, LIST_MAX_PAGE_SIZE) : LIST_DEFAULT_PAGE_SIZE;

    const statuses = this.parseStatusList(query.status);
    if (query.category && !isCategoryCode(query.category)) {
      throw new BadRequestException(`未知故障分类：${query.category}`);
    }
    if (query.priority && !isPriorityCode(query.priority)) {
      throw new BadRequestException(`未知优先级：${query.priority}`);
    }
    if (query.from && query.to) {
      const from = this.parseListBoundary(query.from, 'from', 'start');
      const to = this.parseListBoundary(query.to, 'to', 'end');
      if (from.getTime() > to.getTime()) {
        throw new BadRequestException('查询起始时间不能晚于结束时间');
      }
    }

    const qb = this.workOrderRepo.createQueryBuilder('w');
    if (statuses.length) {
      qb.andWhere('w.status IN (:...statuses)', { statuses });
    }
    if (query.category) qb.andWhere('w.category = :category', { category: query.category });
    if (query.priority) qb.andWhere('w.priority = :priority', { priority: query.priority });
    if (Number.isInteger(query.spaceId)) qb.andWhere('w.spaceId = :spaceId', { spaceId: query.spaceId });
    if (Number.isInteger(query.assigneeId)) {
      qb.andWhere('w.assigneeId = :assigneeId', { assigneeId: query.assigneeId });
    }
    if (Number.isInteger(query.reporterId)) {
      qb.andWhere('w.reporterId = :reporterId', { reporterId: query.reporterId });
    }
    if (typeof query.escalated === 'boolean') {
      qb.andWhere('w.escalated = :escalated', { escalated: query.escalated });
    }
    if (query.from) {
      qb.andWhere('w.createdAt >= :from', {
        from: this.parseListBoundary(query.from, 'from', 'start'),
      });
    }
    if (query.to) {
      qb.andWhere('w.createdAt <= :to', { to: this.parseListBoundary(query.to, 'to', 'end') });
    }
    if (query.keyword && query.keyword.trim()) {
      const kw = `%${escapeLike(query.keyword.trim())}%`;
      qb.andWhere(
        '(w.workOrderNo LIKE :kw ESCAPE \'\\\' OR w.title LIKE :kw ESCAPE \'\\\' OR w.description LIKE :kw ESCAPE \'\\\')',
        { kw },
      );
    }

    this.applyListSort(qb, query.sort);

    const [rows, total] = await qb
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { items: this.toViewList(rows), total, page, pageSize };
  }

  /** 状态筛选：`reported,dispatched` → ['reported','dispatched']，非法状态直接 400 */
  private parseStatusList(raw?: string): WorkOrderStatus[] {
    if (!raw || !raw.trim()) return [];
    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!parts.length) return [];
    for (const code of parts) {
      if (!STATUS_CODES.includes(code as WorkOrderStatus)) {
        throw new BadRequestException(`未知工单状态：${code}`);
      }
    }
    return parts as WorkOrderStatus[];
  }

  /** 区间边界：`YYYY-MM-DD` 按整天处理（起点零点、终点最后一毫秒） */
  private parseListBoundary(raw: string, field: string, edge: 'start' | 'end'): Date {
    const text = raw.trim();
    if (DATE_ONLY.test(text)) {
      const day = new Date(`${text}T00:00:00.000Z`);
      return edge === 'end' ? new Date(day.getTime() + 86400_000 - 1) : day;
    }
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${field} 时间格式不合法`);
    return d;
  }

  /** 排序：默认最新在前；`priority` 与待派单队列同一套权重，避免两处队列标准不一致 */
  private applyListSort(
    qb: ReturnType<Repository<WorkOrder>['createQueryBuilder']>,
    sort?: WorkOrderListSort,
  ): void {
    switch (sort) {
      case 'createdAsc':
        qb.orderBy('w.createdAt', 'ASC').addOrderBy('w.id', 'ASC');
        break;
      case 'slaAsc':
        // 无时限（如已合并单）排最后，否则它们会因为 NULL 最小而永远占据第一页
        qb.orderBy('CASE WHEN w.slaDeadline IS NULL THEN 1 ELSE 0 END', 'ASC')
          .addOrderBy('w.slaDeadline', 'ASC')
          .addOrderBy('w.id', 'ASC');
        break;
      case 'priority':
        qb.orderBy(
          `CASE w.priority WHEN 'urgent' THEN ${PRIORITY_WEIGHT.urgent} WHEN 'high' THEN ${PRIORITY_WEIGHT.high} WHEN 'medium' THEN ${PRIORITY_WEIGHT.medium} ELSE ${PRIORITY_WEIGHT.low} END`,
          'DESC',
        )
          .addOrderBy('w.slaDeadline', 'ASC')
          .addOrderBy('w.id', 'ASC');
        break;
      default:
        qb.orderBy('w.createdAt', 'DESC').addOrderBy('w.id', 'DESC');
    }
  }

  /** 处理低分回访：记录处置说明后关闭回访任务 */
  async handleRevisit(
    workOrderId: number,
    handlerId: number,
    note: string,
    handlerName?: string,
  ): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (!wo.revisitRequired) throw new ConflictException('该工单不需要回访');
    if (wo.revisitHandled) throw new ConflictException('该回访已处理');
    if (!note || !note.trim()) throw new BadRequestException('请填写回访处置说明');

    wo.revisitHandled = true;
    const saved = await this.workOrderRepo.save(wo);
    await this.recordEvent(saved, {
      type: 'revisited',
      operatorId: handlerId,
      operatorName: handlerName,
      note: note.trim(),
    });
    return saved;
  }

  /** 工单时间线：按发生顺序返回全部事件 */
  async listEvents(workOrderId: number): Promise<WorkOrderEvent[]> {
    await this.findById(workOrderId);
    return this.eventRepo.find({ where: { workOrderId }, order: { id: 'ASC' } });
  }

  /** 查询工单状态：上报人 / 维修员 / 具 workorder.dispatch 权限者 */
  async getStatus(userId: number, workOrderId: number, user?: { permissions?: string[] }): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    const isOwner = wo.reporterId === userId;
    const isAssignee = wo.assigneeId === userId;
    const isManager = user?.permissions?.includes('workorder.dispatch') === true;
    if (!isOwner && !isAssignee && !isManager) {
      throw new ForbiddenException('无权查看该工单');
    }
    return wo;
  }

  /** 详情视图（含照片与座位清单的解析结果，访问控制同 getStatus） */
  async getDetail(userId: number, workOrderId: number, user?: { permissions?: string[] }): Promise<WorkOrderView> {
    return this.toView(await this.getStatus(userId, workOrderId, user));
  }

  /** 字典与限制（M3-31）：前端表单选择器与校验共用的唯一数据源 */
  meta(): WorkOrderMeta {
    return {
      categories: WORK_ORDER_CATEGORIES.map((c) => ({
        code: c.code,
        name: c.name,
        defaultSlaHours: c.defaultSlaHours,
      })),
      priorities: PRIORITY_CODES.map((code) => ({
        code,
        name: PRIORITY_LABEL[code],
        slaFactor: code === 'urgent' ? 0.3 : code === 'high' ? 0.6 : code === 'medium' ? 1 : 1.5,
      })),
      statuses: STATUS_CODES.map((code) => ({ code, name: statusLabel(code) })),
      limits: {
        maxPhotos: 3,
        maxReopen: 3,
        maxAppeal: 2,
        etaMaxDays: 30,
        commentMaxLength: 500,
      },
    };
  }

  // ===== 管理视图 =====

  /**
   * 维修员负载与技能画像（M3-26）。
   *
   * 解决的实际问题：派单员手里只有一串 id，凭印象派单会导致
   * 忙的人越忙、擅长的人接不到对口活。这里把「在手几个单、差评多少、擅长什么」
   * 摊开到一张表上，派单才有依据。
   */
  async technicianWorkload(): Promise<TechnicianWorkload[]> {
    const users = await this.usersService.findByPermission('workorder.handle');
    const all = await this.workOrderRepo
      .createQueryBuilder('w')
      .where('w.assigneeId IS NOT NULL')
      .getMany();

    const byUser = new Map<number, WorkOrder[]>();
    for (const wo of all) {
      const id = wo.assigneeId as number;
      const list = byUser.get(id) ?? [];
      list.push(wo);
      byUser.set(id, list);
    }

    return users.map((u) => {
      const list = byUser.get(u.id) ?? [];
      const active = list.filter((w) => w.status === 'dispatched' || w.status === 'in_progress');
      const accepted = list.filter((w) => w.status === 'accepted');
      const rated = accepted.filter((w) => w.rating != null);

      const durations = accepted
        .filter((w) => w.dispatchedAt && w.completedAt)
        .map((w) => (new Date(w.completedAt as Date).getTime() - new Date(w.dispatchedAt as Date).getTime()) / 3600_000);
      const avgHandleHours = durations.length
        ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
        : null;

      const categoryCount = new Map<string, number>();
      for (const w of list) {
        categoryCount.set(w.category, (categoryCount.get(w.category) ?? 0) + 1);
      }
      const topCategories = [...categoryCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([category, count]) => ({ category, name: categoryName(category), count }));

      return {
        userId: u.id,
        name: u.name,
        department: u.department,
        activeCount: active.length,
        urgentCount: active.filter((w) => w.priority === 'urgent' || w.priority === 'high').length,
        completedCount: accepted.length,
        avgRating: rated.length
          ? Math.round((rated.reduce((a, b) => a + (b.rating as number), 0) / rated.length) * 10) / 10
          : null,
        avgHandleHours,
        topCategories,
      };
    });
  }

  // ===== 统计看板（M3-18） =====

  /**
   * 工单统计看板。
   *
   * 口径是这个接口最容易出错的地方，所以把每条定义随数据一起返回（definitions），
   * 前端直接展示，不给人「同一个数字两种解释」的空间。三个关键决定：
   *
   * 1. 完工率分母剔除 cancelled 与 merged —— 取消单和合并单不是「没修好」，
   *    把它们算进分母等于惩罚合理操作；
   * 2. 平均解决时长扣掉累计挂起时长 —— 挂起是客观停工（等配件），
   *    算进作业效率会让「等了两周配件」的工单看起来像维修员手慢；
   * 3. SLA 达标率用 originalSlaDeadline 而不是 slaDeadline —— 后者每次升级都会被推后，
   *    用它算达标率，超时的单子全是「被升级过的」，结果虚高。
   */
  async stats(query: WorkOrderStatsQuery = {}): Promise<WorkOrderStats> {
    const now = new Date();
    const to = query.to ? new Date(query.to) : now;
    if (Number.isNaN(to.getTime())) throw new BadRequestException('统计结束时间格式不合法');
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86400_000);
    if (Number.isNaN(from.getTime())) throw new BadRequestException('统计起始时间格式不合法');
    if (from.getTime() >= to.getTime()) throw new BadRequestException('起始时间必须早于结束时间');

    const qb = this.workOrderRepo
      .createQueryBuilder('w')
      .where('w.createdAt >= :from AND w.createdAt < :to', { from, to });
    if (query.spaceId != null) qb.andWhere('w.spaceId = :spaceId', { spaceId: query.spaceId });
    const rows = await qb.getMany();

    const t = (d: Date | string | null | undefined): number => (d ? new Date(d).getTime() : 0);
    const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length;
    const round1 = (v: number): number => Math.round(v * 10) / 10;
    const pct = (num: number, den: number): number | null =>
      den > 0 ? round1((num / den) * 100) : null;

    const accepted = rows.filter((r) => r.status === 'accepted');
    const cancelled = rows.filter((r) => r.status === 'cancelled');
    const merged = rows.filter((r) => r.status === 'merged');
    const effective = rows.length - cancelled.length - merged.length;
    const open = rows.filter((r) => OPEN_WORK_ORDER_STATUSES.includes(r.status)).length;

    // 首响：以首次开工时刻为准（返工不重算）
    const responded = rows.filter((r) => r.firstRespondedAt);
    const avgResponseHours = responded.length
      ? round1(mean(responded.map((r) => (t(r.firstRespondedAt) - t(r.createdAt)) / 3600_000)))
      : null;

    // 解决：扣挂起时长
    const resolved = accepted.filter((r) => r.acceptedAt);
    const avgResolveHours = resolved.length
      ? round1(
          Math.max(
            0,
            mean(
              resolved.map(
                (r) =>
                  (t(r.acceptedAt) - t(r.createdAt) - (r.totalHoldMinutes ?? 0) * 60_000) / 3600_000,
              ),
            ),
          ),
        )
      : null;

    // SLA 达标：原始时限优先，老数据回退到 slaDeadline
    const slaComparable = accepted.filter(
      (r) => r.acceptedAt && (r.originalSlaDeadline ?? r.slaDeadline),
    );
    const slaOk = slaComparable.filter(
      (r) => t(r.acceptedAt) <= t(r.originalSlaDeadline ?? r.slaDeadline),
    );

    const rated = accepted.filter((r) => r.rating != null);

    // 分组统计
    const byStatus = STATUS_CODES.map((code) => ({
      status: code,
      name: statusLabel(code),
      count: rows.filter((r) => r.status === code).length,
    })).filter((x) => x.count > 0);

    const categoryCodes = [...new Set(rows.map((r) => r.category))];
    const byCategory = categoryCodes
      .map((code) => ({
        category: code,
        name: categoryName(code),
        count: rows.filter((r) => r.category === code).length,
        openCount: rows.filter(
          (r) => r.category === code && OPEN_WORK_ORDER_STATUSES.includes(r.status),
        ).length,
      }))
      .sort((a, b) => b.count - a.count);

    const byPriority = PRIORITY_CODES.map((code) => ({
      priority: code,
      name: PRIORITY_LABEL[code],
      count: rows.filter((r) => r.priority === code).length,
    })).filter((x) => x.count > 0);

    // 空间故障排行
    const spaceIds = [...new Set(rows.map((r) => r.spaceId).filter((v): v is number => v != null))];
    const spaces = spaceIds.length ? await this.spaceRepo.findBy({ id: In(spaceIds) }) : [];
    const spaceMap = new Map(spaces.map((s) => [s.id, s]));
    const topSpaces = spaceIds
      .map((id) => {
        const list = rows.filter((r) => r.spaceId === id);
        return {
          spaceId: id,
          name: spaceMap.get(id)?.name ?? `空间 ${id}`,
          code: spaceMap.get(id)?.code ?? '',
          count: list.length,
          openCount: list.filter((r) => OPEN_WORK_ORDER_STATUSES.includes(r.status)).length,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    return {
      range: { from: from.toISOString(), to: to.toISOString() },
      totals: {
        total: rows.length,
        open,
        accepted: accepted.length,
        cancelled: cancelled.length,
        merged: merged.length,
        effective,
      },
      byStatus,
      byCategory,
      byPriority,
      kpi: {
        completionRate: pct(accepted.length, effective),
        avgResponseHours,
        avgResolveHours,
        slaComplianceRate: pct(slaOk.length, slaComparable.length),
        reworkRate: pct(accepted.filter((r) => r.reopenCount > 0).length, accepted.length),
        avgRating: rated.length ? round1(mean(rated.map((r) => r.rating as number))) : null,
      },
      topSpaces,
      definitions: {
        total: '区间内上报的工单总数（按上报时间落入区间统计），含已取消与被合并单',
        effective: '参与比率计算的有效工单数 = total − cancelled − merged',
        completionRate: '完工率(%) = 已验收 ÷ 有效工单；取消单与合并单不计入分母',
        avgResponseHours: '平均首响时长(小时) = 平均(首次开工时刻 − 上报时刻)，仅统计已开工工单',
        avgResolveHours:
          '平均解决时长(小时) = 平均(验收时刻 − 上报时刻 − 累计挂起时长)；挂起属客观停工，不计入作业时长',
        slaComplianceRate:
          'SLA 达标率(%) = 已验收工单中「验收时刻 ≤ 原始解决时限」的占比；原始时限不随升级推后、随挂起顺延',
        reworkRate: '返工率(%) = 已验收工单中返工次数 > 0 的占比',
        avgRating: '验收平均分(1-5)，仅统计有评分的工单',
      },
    };
  }

  // ===== 定时任务 =====

  /**
   * 定时任务：SLA 超时升级。
   *
   * 两类超时都会触发升级：
   * - 解决时限（slaDeadline）已过，工单仍未完工
   * - 首响时限（responseDeadline）已过，工单还没被接单（仍在 reported）
   */
  async escalateOverdue(): Promise<number> {
    const now = new Date();
    const overdue = await this.workOrderRepo.find({
      where: [
        { status: 'reported', slaDeadline: LessThan(now) },
        { status: 'dispatched', slaDeadline: LessThan(now) },
        { status: 'in_progress', slaDeadline: LessThan(now) },
        { status: 'reported', responseDeadline: LessThan(now) },
      ],
    });
    const escalateHours = await this.configService.getInt('WORKORDER_ESCALATE_HOURS', 24);
    let count = 0;
    for (const wo of overdue) {
      const lateType = wo.status === 'reported' ? '首响超时' : '解决超时';
      wo.escalateLevel += 1;
      wo.escalated = true;
      wo.slaDeadline = new Date(now.getTime() + escalateHours * 3600_000);
      // 首响时限也必须一起推后，否则下一轮调度会立刻重新命中
      // `{status:'reported', responseDeadline < now}` 这条条件，
      // 结果是每跑一轮 escalateLevel +1 并再发一遍通知（实测线上已累加到 113 级）。
      if (wo.responseDeadline && new Date(wo.responseDeadline).getTime() < now.getTime()) {
        wo.responseDeadline = new Date(now.getTime() + escalateHours * 3600_000);
      }
      wo.slaWarned = false; // 新的时限窗口，预警重置
      const saved = await this.workOrderRepo.save(wo);
      await this.notificationsService.send(
        wo.reporterId,
        'workorder',
        '工单已升级',
        `您的报修工单 ${wo.workOrderNo}（${wo.title}）${
          wo.status === 'reported' ? '长时间无人接单' : 'SLA 超时未完工'
        }，已升级至第 ${wo.escalateLevel} 级处理。`,
      );
      await this.recordEvent(saved, {
        type: 'escalated',
        operatorId: null,
        note: `${lateType}，升级至第 ${saved.escalateLevel} 级`,
      });
      count++;
    }
    // 挂起超期兜底（M3-14 验收 4）：挂起等于「合法停摆」，但不能无限停。
    // 超过上限仍未恢复，说明配件/协调环节出了问题，必须升级到人，而不是让单子安静地烂在状态里。
    const holdMaxDays = await this.configService.getInt('WORKORDER_HOLD_MAX_DAYS', 7);
    const holdCutoff = new Date(now.getTime() - holdMaxDays * 86400_000);
    const staleHolds = await this.workOrderRepo.find({
      where: { status: 'on_hold', holdEscalated: false, onHoldSince: LessThan(holdCutoff) },
    });
    for (const wo of staleHolds) {
      const heldDays = Math.floor(
        (now.getTime() - new Date(wo.onHoldSince as Date).getTime()) / 86400_000,
      );
      wo.escalateLevel += 1;
      wo.escalated = true;
      wo.holdEscalated = true; // 只告警一次，避免每轮定时任务重复轰炸
      const saved = await this.workOrderRepo.save(wo);
      await this.recordEvent(saved, {
        type: 'escalated',
        operatorId: null,
        note: `挂起已持续 ${heldDays} 天（上限 ${holdMaxDays} 天），自动升级`,
      });
      await this.notifyManagers(
        '挂起超期',
        `工单 ${saved.workOrderNo}（${saved.title}）已挂起 ${heldDays} 天（原因：${saved.holdReason || '未填写'}），超过上限 ${holdMaxDays} 天，请介入协调。`,
      );
      await this.notificationsService.send(
        saved.reporterId,
        'workorder',
        '工单处理延迟说明',
        `您的报修工单 ${saved.workOrderNo}（${saved.title}）因「${saved.holdReason || '客观原因'}」仍在等待，已升级至物业管理员协调处理。`,
      );
      count++;
    }

    return count;
  }

  /**
   * 定时任务：SLA 即将超时预警（M3-23）。
   *
   * 在剩余时间不足总时长 WORKORDER_SLA_WARN_RATIO% 时提醒维修员与派单员。
   * 预警的价值在于「还有时间能补救」，等到超时再升级，用户已经不满意了。
   * slaWarned 保证同一时限窗口只提醒一次，避免每分钟轰炸。
   */
  async warnSlaApproaching(): Promise<number> {
    const now = Date.now();
    const ratio = await this.configService.getInt('WORKORDER_SLA_WARN_RATIO', 20);
    const open = await this.workOrderRepo.find({
      where: [
        { status: 'dispatched', slaWarned: false },
        { status: 'in_progress', slaWarned: false },
      ],
    });
    let count = 0;
    for (const wo of open) {
      if (!wo.slaDeadline) continue;
      const deadline = new Date(wo.slaDeadline).getTime();
      const created = new Date(wo.createdAt).getTime();
      const total = deadline - created;
      if (total <= 0) continue;
      const remain = deadline - now;
      if (remain <= 0) continue; // 已超时，交给升级任务处理
      if (remain > (total * ratio) / 100) continue;

      wo.slaWarned = true;
      const saved = await this.workOrderRepo.save(wo);
      const remainHours = Math.max(1, Math.round(remain / 3600_000));
      await this.recordEvent(saved, {
        type: 'warned',
        operatorId: null,
        note: `解决时限剩余约 ${remainHours} 小时，已发出预警`,
      });
      if (saved.assigneeId != null) {
        await this.notificationsService.send(
          saved.assigneeId,
          'workorder',
          '工单即将超时',
          `工单 ${saved.workOrderNo}（${saved.title}）距解决时限仅剩约 ${remainHours} 小时，请优先处理。`,
        );
      }
      await this.notifyManagers(
        '工单即将超时',
        `工单 ${saved.workOrderNo}（${saved.title}）距解决时限仅剩约 ${remainHours} 小时。`,
      );
      count++;
    }
    return count;
  }

  /** 上报人 / 维修员身份校验 */
  private assertAssignee(wo: WorkOrder, assigneeId: number): void {
    if (wo.assigneeId !== assigneeId) {
      throw new ForbiddenException('仅该工单指派的维修员可操作');
    }
  }
}
