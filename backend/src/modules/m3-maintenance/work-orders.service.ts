import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Like, Repository } from 'typeorm';
import { WorkOrder, WorkOrderStatus } from '../../database/entities/work-order.entity';
import { WorkOrderEvent, WorkOrderEventType } from '../../database/entities/work-order-event.entity';
import { Space } from '../../database/entities/space.entity';
import { SeatStateService } from '../../shared/spaces/seat-state.service';
import { NotificationsService } from '../../shared/notifications/notifications.service';
import { SystemConfigService } from '../../shared/system-config/system-config.service';

export interface ReportWorkOrderInput {
  title: string;
  description?: string;
  category?: string;
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  targetType: 'space' | 'seat' | 'other';
  targetId?: number;
  spaceId?: number;
}

export interface AcceptWorkOrderInput {
  /** pass=验收通过（默认） fail=验收不通过，退回维修中 */
  result?: 'pass' | 'fail';
  rating?: number;
  comment?: string;
}

/** M3 物业报修工单：故障上报、派单、维修中、超时升级、完工验收与评价 */
@Injectable()
export class WorkOrdersService {
  constructor(
    @InjectRepository(WorkOrder) private readonly workOrderRepo: Repository<WorkOrder>,
    @InjectRepository(WorkOrderEvent) private readonly eventRepo: Repository<WorkOrderEvent>,
    @InjectRepository(Space) private readonly spaceRepo: Repository<Space>,
    private readonly seatStateService: SeatStateService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: SystemConfigService,
  ) {}

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

  /** 只写事件、不改状态（用于上报、改派、升级这类“状态不变”的场景） */
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

  /**
   * 故障上报。生成工单号；slaDeadline = now + WORKORDER_SLA_HOURS。
   * targetType='space' 且 spaceId 有值时，立即将该室全部座位置为 maintenance（下架）。
   */
  async report(userId: number, input: ReportWorkOrderInput, operatorName?: string): Promise<WorkOrder> {
    if (!input.title || !input.title.trim()) {
      throw new BadRequestException('工单标题不能为空');
    }
    const now = new Date();
    const slaHours = await this.configService.getInt('WORKORDER_SLA_HOURS', 48);

    let space: Space | null = null;
    if (input.targetType === 'space' && input.spaceId != null) {
      space = await this.spaceRepo.findOneBy({ id: input.spaceId });
      if (!space) throw new NotFoundException(`空间 ${input.spaceId} 不存在`);
    }

    const draft = this.workOrderRepo.create({
      workOrderNo: await this.nextWorkOrderNo(now),
      reporterId: userId,
      title: input.title.trim(),
      description: input.description ?? '',
      category: input.category ?? 'other',
      priority: input.priority ?? 'medium',
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      spaceId: input.spaceId ?? null,
      status: 'reported',
      slaDeadline: new Date(now.getTime() + slaHours * 3600_000),
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

    // M3 → M1 跨模块集成：报修空间存在维修中工单时，该室全部座位自动下架
    if (input.targetType === 'space' && input.spaceId != null) {
      await this.seatStateService.setMaintenance(input.spaceId, wo.id, userId, '报修维修中');
    }
    await this.recordEvent(wo, {
      type: 'reported',
      operatorId: userId,
      operatorName,
      note: `上报：${wo.title}`,
      fromStatus: null,
    });
    return wo;
  }

  private isUniqueViolation(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return /unique|duplicate|workOrderNo/i.test(msg);
  }

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
    return this.transition(wo, {
      type: 'dispatched',
      toStatus: 'dispatched',
      operatorId: dispatcherUserId,
      operatorName: dispatcherName,
      note: `派单给维修员 ${assigneeId}`,
    });
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
    return saved;
  }

  /** 维修员接单：dispatched → in_progress。仅 assignee 本人可操作。 */
  async startWork(workOrderId: number, assigneeId: number, operatorName?: string): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    this.assertAssignee(wo, assigneeId);
    if (wo.status !== 'dispatched') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 dispatched 状态可开工`);
    }
    wo.inProgressAt = new Date();
    return this.transition(wo, {
      type: 'started',
      toStatus: 'in_progress',
      operatorId: assigneeId,
      operatorName,
      note: '维修员接单开工',
    });
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
    return this.transition(wo, {
      type: 'completed',
      toStatus: 'completed',
      operatorId: assigneeId,
      operatorName,
      note: '维修完成，待验收',
    });
  }

  /**
   * 验收：completed → accepted（通过）/ in_progress（不通过，返工）。
   *
   * - 通过：记录评分，恢复该室座位（M3 → M1 集成）
   * - 不通过：返工计数 +1，座位**保持下架**（故障未修复不应恢复可约），
   *   超过 WORKORDER_MAX_REOPEN 次后拒绝，提示升级处理
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
      return this.transition(wo, {
        type: 'rejected',
        toStatus: 'in_progress',
        operatorId: reporterId,
        operatorName: reporterName,
        note: input.comment || '验收不通过，退回返工',
      });
    }

    if (input.rating != null && (input.rating < 1 || input.rating > 5)) {
      throw new BadRequestException('验收评分须在 1-5 之间');
    }
    wo.acceptedAt = new Date();
    wo.rating = input.rating ?? null;
    wo.ratingComment = input.comment ?? '';
    const saved = await this.transition(wo, {
      type: 'accepted',
      toStatus: 'accepted',
      operatorId: reporterId,
      operatorName: reporterName,
      note: input.comment ?? '验收通过',
    });

    // 工单关联空间：验收通过后恢复座位
    if (saved.spaceId != null) {
      await this.seatStateService.restoreAfterMaintenance(
        saved.spaceId,
        saved.id,
        reporterId,
        '工单验收通过',
      );
    }
    return saved;
  }

  /** 上报人取消：仅 reported/dispatched 可取消；曾下架座位则恢复。 */
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

    if (saved.spaceId != null && saved.targetType === 'space') {
      await this.seatStateService.restoreAfterMaintenance(
        saved.spaceId,
        saved.id,
        userId,
        '工单取消，恢复座位',
      );
    }
    return saved;
  }

  /** 我上报的工单 */
  async listMine(userId: number, query: { status?: WorkOrderStatus } = {}): Promise<WorkOrder[]> {
    const where: Record<string, unknown> = { reporterId: userId };
    if (query.status) where.status = query.status;
    return this.workOrderRepo.find({ where, order: { id: 'DESC' } });
  }

  /** 待派单队列（reported），权限 workorder.dispatch 在 Controller 层校验 */
  async listPending(): Promise<WorkOrder[]> {
    return this.workOrderRepo.find({ where: { status: 'reported' }, order: { id: 'ASC' } });
  }

  /** 我接的工单（维修员视角） */
  async listAssignments(assigneeId: number): Promise<WorkOrder[]> {
    return this.workOrderRepo.find({ where: { assigneeId }, order: { id: 'DESC' } });
  }

  /** 升级待处理列表（派单员视角）：SLA 超时且尚未被处理的工单 */
  async listEscalated(): Promise<WorkOrder[]> {
    return this.workOrderRepo.find({ where: { escalated: true }, order: { id: 'ASC' } });
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

  /**
   * 定时任务：SLA 超时升级。
   * reported/dispatched/in_progress 且 slaDeadline < now → escalateLevel+1，
   * 重设 slaDeadline = now + WORKORDER_ESCALATE_HOURS，并通知上报人。返回升级数量。
   */
  async escalateOverdue(): Promise<number> {
    const now = new Date();
    const overdue = await this.workOrderRepo.find({
      where: [
        { status: 'reported', slaDeadline: LessThan(now) },
        { status: 'dispatched', slaDeadline: LessThan(now) },
        { status: 'in_progress', slaDeadline: LessThan(now) },
      ],
    });
    const escalateHours = await this.configService.getInt('WORKORDER_ESCALATE_HOURS', 24);
    let count = 0;
    for (const wo of overdue) {
      wo.escalateLevel += 1;
      wo.escalated = true;
      wo.slaDeadline = new Date(now.getTime() + escalateHours * 3600_000);
      const saved = await this.workOrderRepo.save(wo);
      await this.notificationsService.send(
        wo.reporterId,
        'workorder',
        '工单已升级',
        `您的报修工单 ${wo.workOrderNo}（${wo.title}）SLA 超时未完工，已升级至第 ${wo.escalateLevel} 级处理。`,
      );
      await this.recordEvent(saved, {
        type: 'escalated',
        operatorId: null,
        note: `SLA 超时，升级至第 ${saved.escalateLevel} 级`,
      });
      count++;
    }
    return count;
  }

  /** 按 id 批量校验维修员身份 */
  private assertAssignee(wo: WorkOrder, assigneeId: number): void {
    if (wo.assigneeId !== assigneeId) {
      throw new ForbiddenException('仅该工单指派的维修员可操作');
    }
  }
}
