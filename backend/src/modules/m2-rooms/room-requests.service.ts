import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, DeepPartial, EntityManager, Repository } from 'typeorm';
import {
  RoomBookingRequest,
  RoomRequestStatus,
} from '../../database/entities/room-booking-request.entity';
import { ApprovalRecord } from '../../database/entities/approval-record.entity';
import { Space } from '../../database/entities/space.entity';
import { OccupancyService } from '../../shared/spaces/occupancy.service';
import { NotificationsService } from '../../shared/notifications/notifications.service';
import { SystemConfigService } from '../../shared/system-config/system-config.service';

/** 整教室预约申请入参 */
export interface ApplyRoomRequestInput {
  spaceId: number;
  /** 日期 YYYY-MM-DD */
  date: string;
  /** 起始整点小时 0-23 */
  startHour: number;
  /** 结束整点小时（不含） */
  endHour: number;
  purpose?: string;
}

/** 审批/驳回入参 */
export interface ReviewInput {
  comment?: string;
}

/** 审批人上下文：由 Controller 从 JWT 注入，避免 Service 依赖 HTTP 层 */
export interface ReviewerContext {
  userId: number;
  name: string;
  permissions: string[];
}

/** 冲突预检结果，供前端在提交前提示 */
export interface ConflictReport {
  roomRequest: { id: number; requestCode: string } | null;
  seatConflicts: number;
  reason: string | null;
}

const ACTIVE_STATUSES: RoomRequestStatus[] = ['pending', 'approved'];

/**
 * M2 整教室预约与审批服务（ADR-0003）。
 *
 * 状态机：pending → approved / rejected / cancelled / expired。
 * 两级审批由 `currentLevel` 表达，权限码按级拆分为 room.approve.l1 / room.approve.l2。
 * 审批通过时不再改 `Seat.status`，而是写一条空间级占用（ADR-0002）。
 */
@Injectable()
export class RoomRequestsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RoomBookingRequest)
    private readonly requestRepo: Repository<RoomBookingRequest>,
    @InjectRepository(ApprovalRecord)
    private readonly approvalRepo: Repository<ApprovalRecord>,
    @InjectRepository(Space)
    private readonly spaceRepo: Repository<Space>,
    private readonly occupancyService: OccupancyService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: SystemConfigService,
  ) {}

  // ===== 提交 =====

  async apply(userId: number, input: ApplyRoomRequestInput): Promise<RoomBookingRequest> {
    this.assertSlot(input.date, input.startHour, input.endHour);

    const space = await this.spaceRepo.findOneBy({ id: input.spaceId });
    if (!space) throw new NotFoundException(`空间 ${input.spaceId} 不存在`);
    if (!space.isActive) throw new BadRequestException(`空间 ${space.name} 当前不可用`);

    const openHour = this.parseHour(space.openTime);
    const closeHour = this.parseHour(space.closeTime);
    if (input.startHour < openHour || input.endHour > closeHour) {
      throw new BadRequestException(
        `${space.name} 的开放时间为 ${space.openTime}-${space.closeTime}，申请时段超出范围`,
      );
    }

    await this.assertNoConflict(input.spaceId, input.date, input.startHour, input.endHour);

    const timeoutAt = await this.computeTimeoutAt(input.date, input.startHour);
    const maxLevel = await this.configService.getInt('ROOM_APPROVAL_LEVELS', 2);

    const base: DeepPartial<RoomBookingRequest> = {
      requesterId: userId,
      spaceId: space.id,
      spaceCode: space.code,
      spaceName: space.name,
      date: input.date,
      startHour: input.startHour,
      endHour: input.endHour,
      purpose: (input.purpose || '').trim(),
      status: 'pending',
      currentLevel: 1,
      maxLevel: Math.max(1, maxLevel),
      timeoutAt,
    };

    // 单号：当天已有数量 + 1；唯一约束兜底，冲突时重试一次
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const code = await this.nextRequestCode(input.date);
      try {
        return await this.requestRepo.save(this.requestRepo.create({ ...base, requestCode: code }));
      } catch (e) {
        if (!this.isUniqueViolation(e) || attempt === 1) throw e;
      }
    }
    /* istanbul ignore next */
    throw new ConflictException('申请单号生成失败，请重试');
  }

  /** 提交前冲突预检（不落库），供前端提示 */
  async preflight(input: ApplyRoomRequestInput): Promise<ConflictReport> {
    this.assertSlot(input.date, input.startHour, input.endHour);
    const room = await this.findRoomConflict(
      input.spaceId,
      input.date,
      input.startHour,
      input.endHour,
    );
    const seatConflicts = await this.occupancyService.countSeatBlocks(
      input.spaceId,
      input.date,
      input.startHour,
      input.endHour,
    );
    let reason: string | null = null;
    if (room) reason = `该时段已有审批通过的整教室预约（${room.requestCode}）`;
    else if (seatConflicts > 0) reason = `该时段已有 ${seatConflicts} 个座位被个人预约`;
    return {
      roomRequest: room ? { id: room.id, requestCode: room.requestCode } : null,
      seatConflicts,
      reason,
    };
  }

  // ===== 审批 =====

  async approve(
    requestId: number,
    reviewer: ReviewerContext,
    options: ReviewInput = {},
  ): Promise<RoomBookingRequest> {
    const request = await this.loadForReview(requestId, reviewer);
    const level = request.currentLevel;

    await this.occupancySafetyCheck(request);

    const now = new Date();
    await this.dataSource.transaction(async (manager) => {
      await this.insertApproval(manager, {
        requestId,
        approverId: reviewer.userId,
        approverName: reviewer.name,
        level,
        action: 'approve',
        comment: options.comment || '',
      });

      if (level < request.maxLevel) {
        const res = await manager
          .getRepository(RoomBookingRequest)
          .update(
            { id: requestId, status: 'pending', currentLevel: level },
            { currentLevel: level + 1 },
          );
        if (!res.affected) throw new ConflictException('申请已被其他审批人处理，请刷新后重试');
        return;
      }

      const res = await manager
        .getRepository(RoomBookingRequest)
        .update(
          { id: requestId, status: 'pending', currentLevel: level },
          { status: 'approved', decidedAt: now },
        );
      if (!res.affected) throw new ConflictException('申请已被其他审批人处理，请刷新后重试');

      await this.occupancyService.block(
        {
          scope: 'space',
          spaceId: request.spaceId,
          date: request.date,
          startHour: request.startHour,
          endHour: request.endHour,
          source: 'M2',
          refType: 'room_request',
          refId: request.id,
          operatorId: reviewer.userId,
          reason: `整教室审批通过（${request.requestCode}，${reviewer.name}）`,
        },
        manager,
      );
    });

    const updated = await this.requestRepo.findOneBy({ id: requestId });
    if (updated?.status === 'approved') {
      await this.notificationsService.send(
        updated.requesterId,
        'approval',
        '整教室预约审批通过',
        `您的教室预约申请 ${updated.requestCode}（${updated.spaceName} ${updated.date} ${updated.startHour}:00-${updated.endHour}:00）已通过全部审批。`,
      );
    } else {
      await this.notificationsService.send(
        updated?.requesterId ?? request.requesterId,
        'approval',
        '整教室预约已通过一级审批',
        `您的教室预约申请 ${request.requestCode} 已通过第 ${level} 级审批，正在等待下一级审批。`,
      );
    }
    return updated ?? request;
  }

  async reject(
    requestId: number,
    reviewer: ReviewerContext,
    options: ReviewInput = {},
  ): Promise<RoomBookingRequest> {
    const request = await this.loadForReview(requestId, reviewer);
    const level = request.currentLevel;
    const comment = (options.comment || '').trim();
    if (!comment) throw new BadRequestException('驳回必须填写理由');

    await this.dataSource.transaction(async (manager) => {
      await this.insertApproval(manager, {
        requestId,
        approverId: reviewer.userId,
        approverName: reviewer.name,
        level,
        action: 'reject',
        comment,
      });
      const res = await manager
        .getRepository(RoomBookingRequest)
        .update(
          { id: requestId, status: 'pending', currentLevel: level },
          { status: 'rejected', rejectReason: comment, decidedAt: new Date() },
        );
      if (!res.affected) throw new ConflictException('申请已被其他审批人处理，请刷新后重试');
      await this.occupancyService.releaseByRef('room_request', requestId, manager);
    });

    await this.notificationsService.send(
      request.requesterId,
      'approval',
      '整教室预约申请已驳回',
      `您的教室预约申请 ${request.requestCode}（${request.spaceName} ${request.date} ${request.startHour}:00-${request.endHour}:00）已被驳回。理由：${comment}`,
    );
    return (await this.requestRepo.findOneBy({ id: requestId })) ?? request;
  }

  // ===== 撤销 =====

  async cancel(userId: number, requestId: number): Promise<RoomBookingRequest> {
    const request = await this.requestRepo.findOneBy({ id: requestId });
    if (!request) throw new NotFoundException(`申请 ${requestId} 不存在`);
    if (request.requesterId !== userId) throw new ForbiddenException('只能撤销本人提交的申请');
    if (!ACTIVE_STATUSES.includes(request.status)) {
      throw new BadRequestException(
        `申请 ${request.requestCode} 当前状态为 ${request.status}，不可撤销`,
      );
    }
    if (request.status === 'approved' && this.slotStarted(request)) {
      throw new BadRequestException('活动已开始，无法撤销');
    }

    await this.dataSource.transaction(async (manager) => {
      const res = await manager
        .getRepository(RoomBookingRequest)
        .update(
          { id: requestId, status: request.status },
          { status: 'cancelled', decidedAt: new Date() },
        );
      if (!res.affected) throw new ConflictException('申请状态已变化，请刷新后重试');
      await this.occupancyService.releaseByRef('room_request', requestId, manager);
    });

    return (await this.requestRepo.findOneBy({ id: requestId })) ?? request;
  }

  // ===== 查询 =====

  async listMine(userId: number, filter: { status?: RoomRequestStatus } = {}) {
    const where: Record<string, unknown> = { requesterId: userId };
    if (filter.status) where.status = filter.status;
    return this.requestRepo.find({ where, order: { id: 'DESC' } });
  }

  /** 审批队列：只返回当前审批人有权处理层级的待审单 */
  async listPending(reviewer: ReviewerContext) {
    const rows = await this.requestRepo.find({ where: { status: 'pending' }, order: { id: 'ASC' } });
    return rows.filter((r) => reviewer.permissions.includes(`room.approve.l${r.currentLevel}`));
  }

  async getStatus(
    userId: number,
    permissions: string[],
    requestId: number,
  ): Promise<RoomBookingRequest & { approvals: ApprovalRecord[]; occupancy: unknown[] }> {
    const request = await this.requestRepo.findOneBy({ id: requestId });
    if (!request) throw new NotFoundException(`申请 ${requestId} 不存在`);
    const canApprove = permissions.some((p) => p.startsWith('room.approve'));
    if (request.requesterId !== userId && !canApprove) {
      throw new ForbiddenException('无权查看该申请');
    }
    const approvals = await this.approvalRepo.find({
      where: { requestId },
      order: { id: 'ASC' },
    });
    const occupancy = await this.occupancyService.activeByRef('room_request', requestId);
    return { ...request, approvals, occupancy };
  }

  async getApprovals(
    userId: number,
    permissions: string[],
    requestId: number,
  ): Promise<ApprovalRecord[]> {
    const request = await this.requestRepo.findOneBy({ id: requestId });
    if (!request) throw new NotFoundException(`申请 ${requestId} 不存在`);
    const canApprove = permissions.some((p) => p.startsWith('room.approve'));
    if (request.requesterId !== userId && !canApprove) {
      throw new ForbiddenException('无权查看该申请的审批记录');
    }
    return this.approvalRepo.find({ where: { requestId }, order: { id: 'ASC' } });
  }

  // ===== 超时 =====

  /**
   * 审批超时自动撤销（ADR-0003 第 5 节）。
   * 只处理 pending；条件更新保证重复执行不会二次处理。
   */
  async expireOverdue(now: Date = new Date()): Promise<number> {
    const overdue = await this.requestRepo
      .createQueryBuilder('r')
      .where('r.status = :status', { status: 'pending' })
      .andWhere('r.timeoutAt IS NOT NULL')
      .andWhere('r.timeoutAt < :now', { now })
      .orderBy('r.id', 'ASC')
      .getMany();

    let count = 0;
    for (const request of overdue) {
      const handled = await this.dataSource.transaction(async (manager) => {
        const updated = await manager
          .getRepository(RoomBookingRequest)
          .update({ id: request.id, status: 'pending' }, { status: 'expired', decidedAt: now });
        if (!updated.affected) return false;
        await this.occupancyService.releaseByRef('room_request', request.id, manager);
        return true;
      });
      if (!handled) continue;
      count += 1;
      await this.notificationsService.send(
        request.requesterId,
        'approval',
        '整教室预约申请超时撤销',
        `您的教室预约申请 ${request.requestCode}（${request.spaceName} ${request.date} ${request.startHour}:00-${request.endHour}:00）超时未完成审批，已自动撤销。`,
      );
    }
    return count;
  }

  // ===== 内部 =====

  private assertSlot(date: string, startHour: number, endHour: number): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date 需为 YYYY-MM-DD 格式');
    }
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) {
      throw new BadRequestException('时段必须为整点');
    }
    if (startHour < 0 || endHour > 24 || startHour >= endHour) {
      throw new BadRequestException('时段不合法：startHour 需小于 endHour，且在 0-24 之间');
    }
  }

  private parseHour(hhmm: string): number {
    const h = Number((hhmm || '').slice(0, 2));
    return Number.isNaN(h) ? 0 : h;
  }

  private slotStart(date: string, hour: number): Date {
    return new Date(`${date}T${String(hour).padStart(2, '0')}:00:00`);
  }

  private slotStarted(request: RoomBookingRequest): boolean {
    return this.slotStart(request.date, request.startHour).getTime() <= Date.now();
  }

  /**
   * 审批截止时间 = min(提交时刻 + 审批时限, 活动开始 - 缓冲)。
   * 第二个上界避免「时限还没到、活动已经结束」的无意义待审单。
   */
  private async computeTimeoutAt(date: string, startHour: number): Promise<Date> {
    const timeoutHours = await this.configService.getInt('ROOM_APPROVAL_TIMEOUT_HOURS', 24);
    const cutoffHours = await this.configService.getInt('ROOM_APPROVAL_CUTOFF_HOURS', 2);
    const now = Date.now();
    const byPolicy = now + timeoutHours * 3600_000;
    const beforeSlot = this.slotStart(date, startHour).getTime() - cutoffHours * 3600_000;
    const timeoutAt = new Date(Math.min(byPolicy, beforeSlot));
    if (timeoutAt.getTime() <= now) {
      throw new BadRequestException(
        `距离活动开始不足 ${cutoffHours} 小时，无法提交需要审批的整教室申请`,
      );
    }
    return timeoutAt;
  }

  private async nextRequestCode(date: string): Promise<string> {
    const used = await this.requestRepo.countBy({ date });
    const seq = String(used + 1).padStart(3, '0');
    return `RB-${date.replace(/-/g, '')}-${seq}`;
  }

  /** 审批前统一守卫：状态、自审批、层级权限、跨级同人 */
  private async loadForReview(
    requestId: number,
    reviewer: ReviewerContext,
  ): Promise<RoomBookingRequest> {
    const request = await this.requestRepo.findOneBy({ id: requestId });
    if (!request) throw new NotFoundException(`申请 ${requestId} 不存在`);
    if (request.status !== 'pending') {
      throw new ConflictException(
        `申请 ${request.requestCode} 当前状态为 ${request.status}，不可审批（INVALID_STATE_TRANSITION）`,
      );
    }
    if (request.requesterId === reviewer.userId) {
      throw new ForbiddenException('不能审批本人提交的申请');
    }
    const level = request.currentLevel;
    const required = `room.approve.l${level}`;
    if (!reviewer.permissions.includes(required)) {
      throw new ForbiddenException(`缺少第 ${level} 级审批权限（${required}）`);
    }
    if (level > 1) {
      const previous = await this.approvalRepo.findOneBy({
        requestId,
        level: level - 1,
        action: 'approve',
      });
      if (previous && previous.approverId === reviewer.userId) {
        throw new ForbiddenException('同一审批人不能连续完成两级审批');
      }
    }
    return request;
  }

  private async insertApproval(
    manager: EntityManager,
    input: {
      requestId: number;
      approverId: number;
      approverName: string;
      level: number;
      action: 'approve' | 'reject';
      comment: string;
    },
  ): Promise<void> {
    try {
      await manager.getRepository(ApprovalRecord).insert(input);
    } catch (e) {
      if (this.isUniqueViolation(e)) {
        throw new ConflictException(`第 ${input.level} 级已由其他审批人处理`);
      }
      throw e;
    }
  }

  private async assertNoConflict(
    spaceId: number,
    date: string,
    startHour: number,
    endHour: number,
  ): Promise<void> {
    const room = await this.findRoomConflict(spaceId, date, startHour, endHour);
    if (room) {
      throw new ConflictException(
        `该教室在 ${date} ${startHour}:00-${endHour}:00 已有审批通过的整教室预约（${room.requestCode}）`,
      );
    }
    const seatConflicts = await this.occupancyService.countSeatBlocks(
      spaceId,
      date,
      startHour,
      endHour,
    );
    if (seatConflicts > 0) {
      throw new ConflictException(
        `该教室在 ${date} ${startHour}:00-${endHour}:00 已有 ${seatConflicts} 个座位被个人预约，整教室申请需避开该时段`,
      );
    }
  }

  /** 审批通过前的复查：防止提交后、审批前被其他占用插入 */
  private async occupancySafetyCheck(request: RoomBookingRequest): Promise<void> {
    const seatConflicts = await this.occupancyService.countSeatBlocks(
      request.spaceId,
      request.date,
      request.startHour,
      request.endHour,
    );
    if (seatConflicts > 0) {
      throw new ConflictException(
        `该时段已有 ${seatConflicts} 个座位被个人预约，无法通过审批；请驳回并请申请人改期`,
      );
    }
  }

  private async findRoomConflict(
    spaceId: number,
    date: string,
    startHour: number,
    endHour: number,
  ): Promise<RoomBookingRequest | null> {
    return this.requestRepo
      .createQueryBuilder('r')
      .where('r.spaceId = :spaceId', { spaceId })
      .andWhere('r.date = :date', { date })
      .andWhere('r.status = :status', { status: 'approved' })
      .andWhere('r.startHour < :endHour', { endHour })
      .andWhere('r.endHour > :startHour', { startHour })
      .orderBy('r.id', 'ASC')
      .getOne();
  }

  private isUniqueViolation(e: unknown): boolean {
    const code = (e as { code?: string } | undefined)?.code;
    return (
      code === 'SQLITE_CONSTRAINT' ||
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      code === 'ER_DUP_ENTRY' ||
      code === '23505'
    );
  }
}
