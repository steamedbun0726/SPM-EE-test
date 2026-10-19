import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, LessThan, Repository } from 'typeorm';
import {
  RoomBookingRequest,
  RoomRequestStatus,
} from '../../database/entities/room-booking-request.entity';
import { ApprovalRecord } from '../../database/entities/approval-record.entity';
import { Seat } from '../../database/entities/seat.entity';
import { Space } from '../../database/entities/space.entity';
import { SeatStateService } from '../../shared/spaces/seat-state.service';
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
  approverName?: string;
}

/**
 * M2 整教室预约与审批服务。
 * 多级审批（maxLevel=2）：逐级通过后最终占用该教室全部可用座位（经 SeatStateService 写回 M1）；
 * 驳回/撤销/超时自动撤销时回滚占用。
 */
@Injectable()
export class RoomRequestsService {
  constructor(
    @InjectRepository(RoomBookingRequest)
    private readonly requestRepo: Repository<RoomBookingRequest>,
    @InjectRepository(ApprovalRecord)
    private readonly approvalRepo: Repository<ApprovalRecord>,
    @InjectRepository(Seat)
    private readonly seatRepo: Repository<Seat>,
    @InjectRepository(Space)
    private readonly spaceRepo: Repository<Space>,
    private readonly seatStateService: SeatStateService,
    private readonly notificationsService: NotificationsService,
    private readonly configService: SystemConfigService,
  ) {}

  /** 生成申请单号 RB-YYYYMMDD-序号（三位补零，如 RB-20261019-0001） */
  private buildCode(date: string, seq: number): string {
    return `RB-${date.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`;
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

  /** 提交整教室预约申请（M2-02） */
  async apply(userId: number, input: ApplyRoomRequestInput): Promise<RoomBookingRequest> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      throw new BadRequestException('date 需为 YYYY-MM-DD 格式');
    }
    if (
      !Number.isInteger(input.startHour) ||
      !Number.isInteger(input.endHour) ||
      input.startHour < 0 ||
      input.endHour > 23 ||
      input.startHour >= input.endHour
    ) {
      throw new BadRequestException('时段不合法：startHour/endHour 需为 0-23 的整数且 startHour < endHour');
    }
    const space = await this.spaceRepo.findOneBy({ id: input.spaceId });
    if (!space) throw new NotFoundException(`空间 ${input.spaceId} 不存在`);

    // 该空间该日期时段无已 approved 的冲突申请
    const conflict = await this.requestRepo
      .createQueryBuilder('r')
      .where('r.spaceId = :spaceId', { spaceId: input.spaceId })
      .andWhere('r.date = :date', { date: input.date })
      .andWhere('r.status = :status', { status: 'approved' })
      .andWhere('r.startHour < :endHour', { endHour: input.endHour })
      .andWhere('r.endHour > :startHour', { startHour: input.startHour })
      .getOne();
    if (conflict) {
      throw new ConflictException(
        `该空间在 ${input.date} ${input.startHour}:00-${input.endHour}:00 已有审批通过的整教室预约`,
      );
    }

    const timeoutHours = await this.configService.getInt('ROOM_APPROVAL_TIMEOUT_HOURS', 2);
    const base: DeepPartial<RoomBookingRequest> = {
      requesterId: userId,
      spaceId: space.id,
      spaceCode: space.code,
      spaceName: space.name,
      date: input.date,
      startHour: input.startHour,
      endHour: input.endHour,
      purpose: input.purpose || '',
      status: 'pending',
      currentLevel: 1,
      maxLevel: 2,
      timeoutAt: new Date(Date.now() + timeoutHours * 3600_000),
    };

    // 单号：当天已创建数量 + 1；unique 冲突时重试一次
    const code = this.buildCode(input.date, (await this.requestRepo.countBy({ date: input.date })) + 1);
    try {
      return await this.requestRepo.save(this.requestRepo.create({ ...base, requestCode: code }));
    } catch (e) {
      if (!this.isUniqueViolation(e)) throw e;
      const retryCode = this.buildCode(input.date, (await this.requestRepo.countBy({ date: input.date })) + 1);
      return await this.requestRepo.save(this.requestRepo.create({ ...base, requestCode: retryCode }));
    }
  }

  /** 审批通过（多级审批，M2-03）。Service 只做业务校验，权限由 Controller 的 @Permissions('room.approve') 保证 */
  async approve(requestId: number, approverUserId: number, options: ReviewInput = {}): Promise<RoomBookingRequest> {
    const request = await this.requestRepo.findOneBy({ id: requestId });
    if (!request) throw new NotFoundException(`申请 ${requestId} 不存在`);
    if (request.status !== 'pending') {
      throw new ConflictException(`申请 ${request.requestCode} 当前状态为 ${request.status}，不可审批`);
    }

    await this.approvalRepo.save(
      this.approvalRepo.create({
        requestId: request.id,
        approverId: approverUserId,
        approverName: options.approverName || `审批人#${approverUserId}`,
        level: request.currentLevel,
        action: 'approve',
        comment: options.comment || '',
      }),
    );

    // 未到最后一层：层级 +1，仍待审批
    if (request.currentLevel < request.maxLevel) {
      request.currentLevel += 1;
      await this.requestRepo.save(request);
      return request;
    }

    // 最后一层通过：占用该空间全部可用座位（M2 → M1 写回），维修中座位由 occupyByRoom 跳过
    request.status = 'approved';
    request.decidedAt = new Date();
    const seats = await this.seatRepo.find({
      where: { spaceId: request.spaceId, isActive: true, status: 'available' },
    });
    const seatIds = seats.map((s) => s.id);
    await this.seatStateService.occupyByRoom(request.spaceId, request.id, seatIds, approverUserId, '整教室审批通过');
    request.occupiedSeatIds = seatIds;
    await this.requestRepo.save(request);

    await this.notificationsService.send(
      request.requesterId,
      'approval',
      '整教室预约审批通过',
      `您的教室预约申请 ${request.requestCode}（${request.spaceName} ${request.date} ${request.startHour}:00-${request.endHour}:00）已审批通过，${seatIds.length} 个座位已占用。`,
    );
    return request;
  }

  /** 审批驳回（M2-03）；若曾占用则回滚座位 */
  async reject(requestId: number, approverUserId: number, options: ReviewInput = {}): Promise<RoomBookingRequest> {
    const request = await this.requestRepo.findOneBy({ id: requestId });
    if (!request) throw new NotFoundException(`申请 ${requestId} 不存在`);
    if (request.status !== 'pending') {
      throw new ConflictException(`申请 ${request.requestCode} 当前状态为 ${request.status}，不可驳回`);
    }

    const comment = options.comment || '';
    if (request.occupiedSeatIds?.length) {
      await this.seatStateService.releaseRoom(
        request.spaceId,
        request.id,
        request.occupiedSeatIds,
        approverUserId,
        '审批驳回，释放座位',
      );
    }
    request.status = 'rejected';
    request.rejectReason = comment;
    request.decidedAt = new Date();
    await this.requestRepo.save(request);

    await this.approvalRepo.save(
      this.approvalRepo.create({
        requestId: request.id,
        approverId: approverUserId,
        approverName: options.approverName || `审批人#${approverUserId}`,
        level: request.currentLevel,
        action: 'reject',
        comment,
      }),
    );

    await this.notificationsService.send(
      request.requesterId,
      'approval',
      '整教室预约申请已驳回',
      `您的教室预约申请 ${request.requestCode}（${request.spaceName} ${request.date} ${request.startHour}:00-${request.endHour}:00）已被驳回。原因：${comment || '未填写'}`,
    );
    return request;
  }

  /** 申请人撤销（仅本人；pending 或 approved 可撤，approved 时回滚占用） */
  async cancel(userId: number, requestId: number): Promise<RoomBookingRequest> {
    const request = await this.requestRepo.findOneBy({ id: requestId });
    if (!request) throw new NotFoundException(`申请 ${requestId} 不存在`);
    if (request.requesterId !== userId) throw new ForbiddenException('只能撤销本人提交的申请');
    if (request.status !== 'pending' && request.status !== 'approved') {
      throw new BadRequestException(`申请 ${request.requestCode} 当前状态为 ${request.status}，不可撤销`);
    }
    if (request.occupiedSeatIds?.length) {
      await this.seatStateService.releaseRoom(
        request.spaceId,
        request.id,
        request.occupiedSeatIds,
        userId,
        '申请人撤销，释放座位',
      );
    }
    request.status = 'cancelled';
    await this.requestRepo.save(request);
    return request;
  }

  /** 我的申请列表 */
  async listMine(userId: number, filter: { status?: RoomRequestStatus } = {}) {
    const where: Record<string, unknown> = { requesterId: userId };
    if (filter.status) where.status = filter.status;
    return this.requestRepo.find({ where, order: { id: 'DESC' } });
  }

  /** 审批队列（待审批） */
  async listPending() {
    return this.requestRepo.find({ where: { status: 'pending' }, order: { id: 'ASC' } });
  }

  /** 申请状态（含审批记录 approvals；本人或审批人可见） */
  async getStatus(
    userId: number,
    requestId: number,
    canApprove = false,
  ): Promise<RoomBookingRequest & { approvals: ApprovalRecord[] }> {
    const request = await this.requestRepo.findOneBy({ id: requestId });
    if (!request) throw new NotFoundException(`申请 ${requestId} 不存在`);
    if (request.requesterId !== userId && !canApprove) {
      throw new ForbiddenException('无权查看该申请');
    }
    const approvals = await this.approvalRepo.find({ where: { requestId }, order: { id: 'ASC' } });
    return { ...request, approvals };
  }

  /** 审批记录列表 */
  async getApprovals(requestId: number): Promise<ApprovalRecord[]> {
    const request = await this.requestRepo.findOneBy({ id: requestId });
    if (!request) throw new NotFoundException(`申请 ${requestId} 不存在`);
    return this.approvalRepo.find({ where: { requestId }, order: { id: 'ASC' } });
  }

  /** 定时任务（每分钟）：超时未完成审批的申请自动撤销，回滚占用并通知申请人（M2-06） */
  async expireOverdue(): Promise<number> {
    const overdue = await this.requestRepo.find({
      where: { status: 'pending', timeoutAt: LessThan(new Date()) },
    });
    for (const request of overdue) {
      request.status = 'expired';
      request.decidedAt = new Date();
      if (request.occupiedSeatIds?.length) {
        await this.seatStateService.releaseRoom(
          request.spaceId,
          request.id,
          request.occupiedSeatIds,
          null,
          '超时未完成审批，自动撤销并释放座位',
        );
      }
      await this.requestRepo.save(request);
      await this.notificationsService.send(
        request.requesterId,
        'approval',
        '整教室预约申请超时撤销',
        `您的教室预约申请 ${request.requestCode}（${request.spaceName} ${request.date} ${request.startHour}:00-${request.endHour}:00）超时未完成审批，申请已自动撤销。`,
      );
    }
    return overdue.length;
  }
}
