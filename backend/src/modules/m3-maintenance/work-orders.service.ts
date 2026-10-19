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
  rating?: number;
  comment?: string;
}

/** M3 物业报修工单：故障上报、派单、维修中、超时升级、完工验收与评价 */
@Injectable()
export class WorkOrdersService {
  constructor(
    @InjectRepository(WorkOrder) private readonly workOrderRepo: Repository<WorkOrder>,
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
  async report(userId: number, input: ReportWorkOrderInput): Promise<WorkOrder> {
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
    return wo;
  }

  private isUniqueViolation(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return /unique|duplicate|workOrderNo/i.test(msg);
  }

  /** 派单：reported → dispatched。权限 workorder.dispatch 在 Controller 层校验。 */
  async dispatch(workOrderId: number, assigneeId: number, dispatcherUserId: number): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (wo.status !== 'reported') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 reported 状态可派单`);
    }
    if (!Number.isInteger(assigneeId) || assigneeId <= 0) {
      throw new BadRequestException('派单维修员不合法');
    }
    wo.status = 'dispatched';
    wo.assigneeId = assigneeId;
    wo.dispatchedAt = new Date();
    return this.workOrderRepo.save(wo);
  }

  /** 维修员接单：dispatched → in_progress。仅 assignee 本人可操作。 */
  async startWork(workOrderId: number, assigneeId: number): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    this.assertAssignee(wo, assigneeId);
    if (wo.status !== 'dispatched') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 dispatched 状态可开工`);
    }
    wo.status = 'in_progress';
    wo.inProgressAt = new Date();
    return this.workOrderRepo.save(wo);
  }

  /** 完工：in_progress → completed。仅 assignee 本人可操作。 */
  async complete(workOrderId: number, assigneeId: number): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    this.assertAssignee(wo, assigneeId);
    if (wo.status !== 'in_progress') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 in_progress 状态可完工`);
    }
    wo.status = 'completed';
    wo.completedAt = new Date();
    return this.workOrderRepo.save(wo);
  }

  /**
   * 验收：completed → accepted，记录评分/评价。
   * 仅上报人本人可操作；工单关联空间时恢复该室座位（M3 → M1 集成）。
   */
  async accept(workOrderId: number, reporterId: number, input: AcceptWorkOrderInput = {}): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (wo.reporterId !== reporterId) {
      throw new ForbiddenException('仅上报人可验收工单');
    }
    if (wo.status !== 'completed') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 completed 状态可验收`);
    }
    if (input.rating != null && (input.rating < 1 || input.rating > 5)) {
      throw new BadRequestException('验收评分须在 1-5 之间');
    }
    wo.status = 'accepted';
    wo.acceptedAt = new Date();
    wo.rating = input.rating ?? null;
    wo.ratingComment = input.comment ?? '';
    const saved = await this.workOrderRepo.save(wo);

    // 工单关联空间：验收通过后恢复座位
    if (saved.spaceId != null) {
      await this.seatStateService.restoreAfterMaintenance(saved.spaceId, saved.id, reporterId, '工单验收通过');
    }
    return saved;
  }

  /** 上报人取消：仅 reported/dispatched 可取消；曾下架座位则恢复。 */
  async cancel(workOrderId: number, userId: number, input: { reason?: string } = {}): Promise<WorkOrder> {
    const wo = await this.findById(workOrderId);
    if (wo.reporterId !== userId) {
      throw new ForbiddenException('仅上报人可取消工单');
    }
    if (wo.status !== 'reported' && wo.status !== 'dispatched') {
      throw new ConflictException(`工单状态为 ${wo.status}，仅 reported/dispatched 状态可取消`);
    }
    wo.status = 'cancelled';
    wo.cancelReason = input.reason ?? '';
    const saved = await this.workOrderRepo.save(wo);

    if (saved.spaceId != null && saved.targetType === 'space') {
      await this.seatStateService.restoreAfterMaintenance(saved.spaceId, saved.id, userId, '工单取消，恢复座位');
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
      wo.slaDeadline = new Date(now.getTime() + escalateHours * 3600_000);
      await this.workOrderRepo.save(wo);
      await this.notificationsService.send(
        wo.reporterId,
        'workorder',
        '工单已升级',
        `您的报修工单 ${wo.workOrderNo}（${wo.title}）SLA 超时未完工，已升级至第 ${wo.escalateLevel} 级处理。`,
      );
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
