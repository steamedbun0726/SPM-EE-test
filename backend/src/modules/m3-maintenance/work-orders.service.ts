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
  WORK_ORDER_CATEGORIES,
  categoryName,
  isCategoryCode,
  isPriorityCode,
  resolveResponseHours,
  resolveSlaHours,
  statusLabel,
} from './work-order-policy';

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
}

export interface AcceptWorkOrderInput {
  /** pass=验收通过（默认） fail=验收不通过，退回维修中 */
  result?: 'pass' | 'fail';
  rating?: number;
  comment?: string;
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
      slaUsedRatio = total > 0 ? Math.min(1, Math.max(0, (now - created) / total)) : 1;
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
    await this.assertNoDuplicateActive(userId, target.spaceId, target.seatIds, input.targetType, target.targetId);
    await this.assertReporterNotAbusive(userId);

    const now = new Date();
    const slaHours = resolveSlaHours(category, priority);
    const responseRatio = await this.configService.getInt('WORKORDER_RESPONSE_RATIO_PERCENT', 25);
    const responseHours = resolveResponseHours(slaHours, responseRatio);

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
      slaDeadline: new Date(now.getTime() + slaHours * 3600_000),
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
        status: In(['reported', 'dispatched', 'in_progress'] as WorkOrderStatus[]),
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
      throw new ConflictException(
        `该对象已有处理中的工单 ${other.workOrderNo}（${statusLabel(other.status)}），请勿重复上报`,
      );
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

  /** 完工：in_progress → completed。仅 assignee 本人可操作。 */
  async complete(workOrderId: number, assigneeId: number, operatorName?: string): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    this.assertAssignee(wo, assigneeId);
    if (wo.status !== 'in_progress') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 in_progress 状态可完工`);
    }
    wo.completedAt = new Date();
    wo.escalated = false; // 已完工，不再属于升级待处理
    const saved = await this.transition(wo, {
      type: 'completed',
      toStatus: 'completed',
      operatorId: assigneeId,
      operatorName,
      note: '维修完成，待验收',
    });
    await this.notificationsService.send(
      saved.reporterId,
      'workorder',
      '维修已完成，待您验收',
      `工单 ${saved.workOrderNo}（${saved.title}）已维修完成，请到场确认后验收。`,
    );
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
      statuses: ['reported', 'dispatched', 'in_progress', 'completed', 'accepted', 'cancelled'].map(
        (code) => ({ code, name: statusLabel(code) }),
      ),
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
