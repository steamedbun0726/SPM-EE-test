import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoomBookingRequest } from '../src/database/entities/room-booking-request.entity';
import { ApprovalRecord } from '../src/database/entities/approval-record.entity';
import { Seat } from '../src/database/entities/seat.entity';
import { Space } from '../src/database/entities/space.entity';
import { SeatStatusLog } from '../src/database/entities/seat-status-log.entity';
import { Notification } from '../src/database/entities/notification.entity';
import { SystemConfig } from '../src/database/entities/system-config.entity';
import { InitSchema1780000000000 } from '../src/database/migrations/1780000000000-init-schema';
import { RoomRequestsService } from '../src/modules/m2-rooms/room-requests.service';
import { SeatStateService } from '../src/shared/spaces/seat-state.service';
import { NotificationsService } from '../src/shared/notifications/notifications.service';
import { SystemConfigService } from '../src/shared/system-config/system-config.service';

describe('M2 整教室预约与审批', () => {
  let moduleRef: TestingModule;
  let service: RoomRequestsService;
  let seatStateService: SeatStateService;
  let requestRepo: Repository<RoomBookingRequest>;
  let approvalRepo: Repository<ApprovalRecord>;
  let seatRepo: Repository<Seat>;
  let spaceRepo: Repository<Space>;
  let notificationRepo: Repository<Notification>;

  const REQUESTER = 101;
  const OTHER_USER = 999;
  const APPROVER1 = 201;
  const APPROVER2 = 202;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqljs',
          autoSave: false,
          migrationsRun: true,
          migrations: [InitSchema1780000000000],
          entities: [
            RoomBookingRequest,
            ApprovalRecord,
            Seat,
            Space,
            SeatStatusLog,
            Notification,
            SystemConfig,
          ],
        }),
        TypeOrmModule.forFeature([
          RoomBookingRequest,
          ApprovalRecord,
          Seat,
          Space,
          SeatStatusLog,
          Notification,
          SystemConfig,
        ]),
      ],
      providers: [RoomRequestsService, SeatStateService, NotificationsService, SystemConfigService],
    }).compile();

    service = moduleRef.get(RoomRequestsService);
    seatStateService = moduleRef.get(SeatStateService);
    requestRepo = moduleRef.get(getRepositoryToken(RoomBookingRequest));
    approvalRepo = moduleRef.get(getRepositoryToken(ApprovalRecord));
    seatRepo = moduleRef.get(getRepositoryToken(Seat));
    spaceRepo = moduleRef.get(getRepositoryToken(Space));
    notificationRepo = moduleRef.get(getRepositoryToken(Notification));
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  /** 建一个教室：3 个可用座位 + 1 个维修中座位 */
  async function seedSpace() {
    const space = await spaceRepo.save(
      spaceRepo.create({
        code: 'TEST-301',
        name: '测试教室 301',
        type: 'classroom',
        openTime: '08:00',
        closeTime: '22:00',
      }),
    );
    const seats = await seatRepo.save([
      seatRepo.create({ spaceId: space.id, seatNo: 'D01' }),
      seatRepo.create({ spaceId: space.id, seatNo: 'D02' }),
      seatRepo.create({ spaceId: space.id, seatNo: 'D03' }),
    ]);
    const maintenanceSeat = await seatRepo.save(
      seatRepo.create({ spaceId: space.id, seatNo: 'D04', status: 'maintenance', statusSource: 'M3' }),
    );
    return { space, availableSeatIds: seats.map((s) => s.id), maintenanceSeatId: maintenanceSeat.id };
  }

  it('多级审批流转：第一级后仍 pending，第二级后 approved 并占用座位（含冲突拦截与审批记录）', async () => {
    const { space, availableSeatIds, maintenanceSeatId } = await seedSpace();

    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2026-10-20',
      startHour: 9,
      endHour: 12,
      purpose: '课程讲座',
    });
    expect(req.status).toBe('pending');
    expect(req.currentLevel).toBe(1);
    expect(req.maxLevel).toBe(2);
    expect(req.requestCode).toMatch(/^RB-20261020-\d{3}$/);
    expect(req.occupiedSeatIds).toBeNull();
    expect(new Date(String(req.timeoutAt)).getTime()).toBeGreaterThan(Date.now());

    // 第一级通过：仍 pending，层级 +1
    const afterL1 = await service.approve(req.id, APPROVER1, { comment: '同意', approverName: '陈审批' });
    expect(afterL1.status).toBe('pending');
    expect(afterL1.currentLevel).toBe(2);

    // 第二级通过：approved + 占用座位
    const afterL2 = await service.approve(req.id, APPROVER2, { comment: '最终通过', approverName: '王老师' });
    expect(afterL2.status).toBe('approved');
    expect(afterL2.decidedAt).not.toBeNull();
    expect(afterL2.occupiedSeatIds?.sort()).toEqual([...availableSeatIds].sort());

    // 座位状态：available → occupied_by_room，写入来源 M2；维修中座位跳过
    for (const sid of availableSeatIds) {
      const seat = await seatRepo.findOneBy({ id: sid });
      expect(seat!.status).toBe('occupied_by_room');
      expect(seat!.statusSource).toBe('M2');
    }
    const maintenanceSeat = await seatRepo.findOneBy({ id: maintenanceSeatId });
    expect(maintenanceSeat!.status).toBe('maintenance');

    // 座位状态历史：写入来源可追溯（M2 / room_request）
    const history = await seatStateService.history(availableSeatIds[0]);
    expect(history[0].source).toBe('M2');
    expect(history[0].refType).toBe('room_request');
    expect(history[0].refId).toBe(req.id);

    // 审批记录：两级 approve
    const records = await approvalRepo.find({ where: { requestId: req.id }, order: { id: 'ASC' } });
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.action)).toEqual(['approve', 'approve']);
    expect(records.map((r) => r.level)).toEqual([1, 2]);
    expect(records[0].approverName).toBe('陈审批');

    // 通知已发给申请人
    const notifs = await notificationRepo.findBy({ userId: REQUESTER });
    expect(notifs.some((n) => n.type === 'approval' && n.title.includes('审批通过'))).toBe(true);

    // 审批队列、我的申请、审批记录接口
    expect(await service.listPending()).toHaveLength(0);
    expect(await service.listMine(REQUESTER)).toHaveLength(1);
    expect(await service.getApprovals(req.id)).toHaveLength(2);

    // 状态查询：本人可见且含 approvals；他人不可见
    const status = await service.getStatus(REQUESTER, req.id);
    expect(status.approvals).toHaveLength(2);
    await expect(service.getStatus(OTHER_USER, req.id)).rejects.toBeInstanceOf(ForbiddenException);

    // 已 approved 时段不可再申请
    await expect(
      service.apply(REQUESTER, { spaceId: space.id, date: '2026-10-20', startHour: 10, endHour: 13 }),
    ).rejects.toBeInstanceOf(ConflictException);

    // approved 后不可再审批
    await expect(service.approve(req.id, APPROVER1)).rejects.toBeInstanceOf(ConflictException);
  });

  it('驳回：状态 rejected、记录驳回意见，座位保持/回滚为 available', async () => {
    const { space, availableSeatIds } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2026-10-21',
      startHour: 14,
      endHour: 16,
    });

    const after = await service.reject(req.id, APPROVER1, { comment: '教室已被占用', approverName: '陈审批' });
    expect(after.status).toBe('rejected');
    expect(after.rejectReason).toBe('教室已被占用');
    expect(after.decidedAt).not.toBeNull();

    const records = await approvalRepo.findBy({ requestId: req.id });
    expect(records).toHaveLength(1);
    expect(records[0].action).toBe('reject');
    expect(records[0].level).toBe(1);
    expect(records[0].comment).toBe('教室已被占用');

    // 座位未被占用（保持/回滚为 available）
    for (const sid of availableSeatIds) {
      const seat = await seatRepo.findOneBy({ id: sid });
      expect(seat!.status).toBe('available');
    }

    // rejected 后不可再审批
    await expect(service.approve(req.id, APPROVER2)).rejects.toBeInstanceOf(ConflictException);

    // 驳回通知已发送
    const notifs = await notificationRepo.findBy({ userId: REQUESTER });
    expect(notifs.some((n) => n.title.includes('驳回'))).toBe(true);
  });

  it('expireOverdue：超时未完成审批自动撤销并通知，未超时不受影响', async () => {
    const { space } = await seedSpace();
    const overdueReq = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2026-10-22',
      startHour: 9,
      endHour: 11,
    });
    overdueReq.timeoutAt = new Date(Date.now() - 1000); // 改为已超时
    await requestRepo.save(overdueReq);
    const okReq = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2026-10-23',
      startHour: 9,
      endHour: 11,
    });

    expect(await service.expireOverdue()).toBe(1);
    const expired = await requestRepo.findOneBy({ id: overdueReq.id });
    expect(expired!.status).toBe('expired');
    expect(expired!.decidedAt).not.toBeNull();
    const ok = await requestRepo.findOneBy({ id: okReq.id });
    expect(ok!.status).toBe('pending');

    // 再次执行不再重复撤销
    expect(await service.expireOverdue()).toBe(0);

    const notifs = await notificationRepo.findBy({ userId: REQUESTER });
    expect(notifs.some((n) => n.title.includes('超时'))).toBe(true);
  });

  it('cancel：approved 撤销后回滚座位为 available；非本人/不可撤状态被拒', async () => {
    const { space, availableSeatIds } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2026-10-24',
      startHour: 10,
      endHour: 12,
    });
    await service.approve(req.id, APPROVER1, { approverName: '陈审批' });
    const approved = await service.approve(req.id, APPROVER2, { approverName: '王老师' });
    expect(approved.status).toBe('approved');

    const cancelled = await service.cancel(REQUESTER, req.id);
    expect(cancelled.status).toBe('cancelled');
    for (const sid of availableSeatIds) {
      const seat = await seatRepo.findOneBy({ id: sid });
      expect(seat!.status).toBe('available');
    }

    // 他人不可撤销
    const otherReq = await service.apply(OTHER_USER, {
      spaceId: space.id,
      date: '2026-10-25',
      startHour: 10,
      endHour: 12,
    });
    await expect(service.cancel(REQUESTER, otherReq.id)).rejects.toBeInstanceOf(ForbiddenException);

    // rejected 状态不可撤销
    const rejectedReq = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2026-10-26',
      startHour: 10,
      endHour: 12,
    });
    await service.reject(rejectedReq.id, APPROVER1, { comment: '不批准' });
    await expect(service.cancel(REQUESTER, rejectedReq.id)).rejects.toBeInstanceOf(BadRequestException);
  });
});
