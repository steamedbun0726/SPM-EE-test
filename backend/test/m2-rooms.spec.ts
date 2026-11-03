import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoomBookingRequest } from '../src/database/entities/room-booking-request.entity';
import { ApprovalRecord } from '../src/database/entities/approval-record.entity';
import { Occupancy } from '../src/database/entities/occupancy.entity';
import { Seat } from '../src/database/entities/seat.entity';
import { Space } from '../src/database/entities/space.entity';
import { Notification } from '../src/database/entities/notification.entity';
import { SystemConfig } from '../src/database/entities/system-config.entity';
import { InitSchema1780000000000 } from '../src/database/migrations/1780000000000-init-schema';
import { M2Occupancy1780000004000 } from '../src/database/migrations/1780000004000-m2-occupancy';
import {
  RoomRequestsService,
  ReviewerContext,
} from '../src/modules/m2-rooms/room-requests.service';
import { OccupancyService } from '../src/shared/spaces/occupancy.service';
import { NotificationsService } from '../src/shared/notifications/notifications.service';
import { SystemConfigService } from '../src/shared/system-config/system-config.service';

describe('M2 整教室预约与审批（ADR-0002 / ADR-0003）', () => {
  let moduleRef: TestingModule;
  let service: RoomRequestsService;
  let occupancy: OccupancyService;
  let requestRepo: Repository<RoomBookingRequest>;
  let approvalRepo: Repository<ApprovalRecord>;
  let occupancyRepo: Repository<Occupancy>;
  let seatRepo: Repository<Seat>;
  let spaceRepo: Repository<Space>;
  let notificationRepo: Repository<Notification>;

  const REQUESTER = 101;
  const OUTSIDER = 999;
  const L1 = 201;
  const L2 = 202;

  const reviewerL1: ReviewerContext = {
    userId: L1,
    name: '王老师',
    permissions: ['room.approve.l1'],
  };
  const reviewerL2: ReviewerContext = {
    userId: L2,
    name: '教务处',
    permissions: ['room.approve.l2'],
  };
  const reviewerBoth: ReviewerContext = {
    userId: 203,
    name: '全能审批',
    permissions: ['room.approve.l1', 'room.approve.l2'],
  };

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqljs',
          autoSave: false,
          migrationsRun: true,
          migrations: [InitSchema1780000000000, M2Occupancy1780000004000],
          entities: [
            RoomBookingRequest,
            ApprovalRecord,
            Occupancy,
            Seat,
            Space,
            Notification,
            SystemConfig,
          ],
        }),
        TypeOrmModule.forFeature([
          RoomBookingRequest,
          ApprovalRecord,
          Occupancy,
          Seat,
          Space,
          Notification,
          SystemConfig,
        ]),
      ],
      providers: [RoomRequestsService, OccupancyService, NotificationsService, SystemConfigService],
    }).compile();

    service = moduleRef.get(RoomRequestsService);
    occupancy = moduleRef.get(OccupancyService);
    requestRepo = moduleRef.get(getRepositoryToken(RoomBookingRequest));
    approvalRepo = moduleRef.get(getRepositoryToken(ApprovalRecord));
    occupancyRepo = moduleRef.get(getRepositoryToken(Occupancy));
    seatRepo = moduleRef.get(getRepositoryToken(Seat));
    spaceRepo = moduleRef.get(getRepositoryToken(Space));
    notificationRepo = moduleRef.get(getRepositoryToken(Notification));
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  /** 建一个教室：3 个可用座位 */
  async function seedSpace(code = 'TEST-301', openTime = '08:00', closeTime = '22:00') {
    const space = await spaceRepo.save(
      spaceRepo.create({ code, name: `测试教室 ${code}`, type: 'classroom', openTime, closeTime }),
    );
    const seats = await seatRepo.save([
      seatRepo.create({ spaceId: space.id, seatNo: 'D01' }),
      seatRepo.create({ spaceId: space.id, seatNo: 'D02' }),
      seatRepo.create({ spaceId: space.id, seatNo: 'D03' }),
    ]);
    return { space, seats };
  }

  // ===== 提交 =====

  it('提交申请：状态 pending、单号格式正确、审批截止时间在未来', async () => {
    const { space } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-01',
      startHour: 9,
      endHour: 12,
      purpose: '课程讲座',
    });

    expect(req.status).toBe('pending');
    expect(req.currentLevel).toBe(1);
    expect(req.maxLevel).toBe(2);
    expect(req.requestCode).toBe('RB-20990501-001');
    expect(new Date(String(req.timeoutAt)).getTime()).toBeGreaterThan(Date.now());
  });

  it('提交申请：超出教室开放时间被拒绝', async () => {
    const { space } = await seedSpace('TEST-302', '08:00', '22:00');
    await expect(
      service.apply(REQUESTER, { spaceId: space.id, date: '2099-05-01', startHour: 6, endHour: 9 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('提交申请：时段不合法被拒绝', async () => {
    const { space } = await seedSpace();
    await expect(
      service.apply(REQUESTER, { spaceId: space.id, date: '2099-05-01', startHour: 12, endHour: 12 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('提交申请：已有座位级占用时被拒绝（M1 预约冲突）', async () => {
    const { space, seats } = await seedSpace();
    await occupancy.block({
      scope: 'seat',
      spaceId: space.id,
      seatId: seats[0].id,
      date: '2099-05-02',
      startHour: 10,
      endHour: 12,
      source: 'M1',
      refType: 'reservation',
      refId: 1,
      reason: '学生个人预约',
    });

    await expect(
      service.apply(REQUESTER, { spaceId: space.id, date: '2099-05-02', startHour: 11, endHour: 13 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // ===== 多级审批 =====

  it('多级审批：一级后仍 pending，二级后 approved 并写一条空间级占用', async () => {
    const { space, seats } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-03',
      startHour: 9,
      endHour: 12,
    });

    const afterL1 = await service.approve(req.id, reviewerL1, { comment: '同意' });
    expect(afterL1.status).toBe('pending');
    expect(afterL1.currentLevel).toBe(2);
    // 一级审批不产生占用
    expect(await occupancyRepo.count()).toBe(0);

    const afterL2 = await service.approve(req.id, reviewerL2, { comment: '终审通过' });
    expect(afterL2.status).toBe('approved');
    expect(afterL2.decidedAt).not.toBeNull();

    // 占用：整间教室一条 space 级记录，而不是每个座位一条
    const blocks = await occupancyRepo.find();
    expect(blocks).toHaveLength(1);
    expect(blocks[0].scope).toBe('space');
    expect(blocks[0].source).toBe('M2');
    expect(blocks[0].refType).toBe('room_request');
    expect(blocks[0].refId).toBe(req.id);
    expect(blocks[0].startHour).toBe(9);
    expect(blocks[0].endHour).toBe(12);

    // 关键回归：座位物理状态不被改写（旧实现会写成 occupied_by_room）
    for (const seat of seats) {
      const fresh = await seatRepo.findOneBy({ id: seat.id });
      expect(fresh!.status).toBe('available');
    }

    const records = await approvalRepo.find({ where: { requestId: req.id }, order: { id: 'ASC' } });
    expect(records.map((r) => [r.level, r.action])).toEqual([
      [1, 'approve'],
      [2, 'approve'],
    ]);
    const notifs = await notificationRepo.findBy({ userId: REQUESTER });
    expect(notifs.some((n) => n.title.includes('审批通过'))).toBe(true);
  });

  it('审批独立性：不能审批本人提交的申请', async () => {
    const { space } = await seedSpace();
    const req = await service.apply(L1, {
      spaceId: space.id,
      date: '2099-05-04',
      startHour: 9,
      endHour: 10,
    });
    await expect(service.approve(req.id, reviewerL1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('审批独立性：同一审批人不能连续完成两级', async () => {
    const { space } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-05',
      startHour: 9,
      endHour: 10,
    });
    await service.approve(req.id, reviewerBoth, { comment: '一级' });
    await expect(service.approve(req.id, reviewerBoth, { comment: '二级' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('层级权限：只有二级权限的审批人不能处理一级待审单', async () => {
    const { space } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-06',
      startHour: 9,
      endHour: 10,
    });
    await expect(service.approve(req.id, reviewerL2)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('审批队列：按当前层级过滤，只返回有权处理的待审单', async () => {
    const { space } = await seedSpace();
    const r1 = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-07',
      startHour: 9,
      endHour: 10,
    });
    const r2 = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-07',
      startHour: 14,
      endHour: 15,
    });
    await service.approve(r1.id, reviewerL1, { comment: '同意' });

    const l1Queue = await service.listPending(reviewerL1);
    const l2Queue = await service.listPending(reviewerL2);
    expect(l1Queue.map((r) => r.id)).toEqual([r2.id]);
    expect(l2Queue.map((r) => r.id)).toEqual([r1.id]);
  });

  // ===== 驳回 =====

  it('驳回：状态 rejected，必须填写理由，且不产生占用', async () => {
    const { space } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-08',
      startHour: 14,
      endHour: 16,
    });

    await expect(service.reject(req.id, reviewerL1, { comment: '' })).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const after = await service.reject(req.id, reviewerL1, { comment: '该教室已被占用' });
    expect(after.status).toBe('rejected');
    expect(after.rejectReason).toBe('该教室已被占用');
    expect(await occupancyRepo.count()).toBe(0);

    // 驳回后不可再审批
    await expect(service.approve(req.id, reviewerL2)).rejects.toBeInstanceOf(ConflictException);
  });

  // ===== 撤销 =====

  it('撤销：approved 撤销后释放占用，座位重新可约', async () => {
    const { space, seats } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-09',
      startHour: 10,
      endHour: 12,
    });
    await service.approve(req.id, reviewerL1, { comment: '同意' });
    await service.approve(req.id, reviewerL2, { comment: '同意' });

    expect(await occupancy.isSeatAvailable(seats[0].id, space.id, '2099-05-09', 10, 11)).toBe(
      false,
    );

    const cancelled = await service.cancel(REQUESTER, req.id);
    expect(cancelled.status).toBe('cancelled');

    const released = await occupancyRepo.find();
    expect(released.every((r) => r.releasedAt !== null)).toBe(true);
    expect(await occupancy.isSeatAvailable(seats[0].id, space.id, '2099-05-09', 10, 11)).toBe(true);
  });

  it('撤销：非本人不能撤销', async () => {
    const { space } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-10',
      startHour: 10,
      endHour: 12,
    });
    await expect(service.cancel(OUTSIDER, req.id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ===== 超时 =====

  it('超时撤销：只处理已过期的 pending，且重复执行不重复处理', async () => {
    const { space } = await seedSpace();
    const overdue = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-11',
      startHour: 9,
      endHour: 10,
    });
    overdue.timeoutAt = new Date(Date.now() - 60_000);
    await requestRepo.save(overdue);

    const notOverdue = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-12',
      startHour: 9,
      endHour: 10,
    });

    expect(await service.expireOverdue()).toBe(1);
    expect((await requestRepo.findOneBy({ id: overdue.id }))!.status).toBe('expired');
    expect((await requestRepo.findOneBy({ id: notOverdue.id }))!.status).toBe('pending');
    // 幂等：再跑一次不再处理
    expect(await service.expireOverdue()).toBe(0);

    const notifs = await notificationRepo.findBy({ userId: REQUESTER });
    expect(notifs.some((n) => n.title.includes('超时'))).toBe(true);
  });

  it('超时撤销：已通过审批的单子不受超时影响', async () => {
    const { space } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-13',
      startHour: 9,
      endHour: 10,
    });
    await service.approve(req.id, reviewerL1, { comment: '同意' });
    await service.approve(req.id, reviewerL2, { comment: '同意' });

    const row = await requestRepo.findOneBy({ id: req.id });
    row!.timeoutAt = new Date(Date.now() - 60_000);
    await requestRepo.save(row!);

    expect(await service.expireOverdue()).toBe(0);
    expect((await requestRepo.findOneBy({ id: req.id }))!.status).toBe('approved');
  });

  // ===== 核心回归：时间维度 =====

  it('回归：审批通过只占用该时段，同一教室其他日期/时段仍可预约', async () => {
    const { space, seats } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-14',
      startHour: 10,
      endHour: 12,
    });
    await service.approve(req.id, reviewerL1, { comment: '同意' });
    await service.approve(req.id, reviewerL2, { comment: '同意' });

    // 占用时段不可约
    expect(await occupancy.isSeatAvailable(seats[0].id, space.id, '2099-05-14', 10, 12)).toBe(
      false,
    );
    // 同一天下午可约（旧实现会把整间教室永久下架）
    expect(await occupancy.isSeatAvailable(seats[0].id, space.id, '2099-05-14', 14, 16)).toBe(
      true,
    );
    // 次日可约
    expect(await occupancy.isSeatAvailable(seats[0].id, space.id, '2099-05-15', 10, 12)).toBe(
      true,
    );
    // 并给出可追溯的不可约原因
    const reason = await occupancy.explain(seats[0].id, space.id, '2099-05-14', 10, 12);
    expect(reason).not.toBeNull();
    expect(reason!.source).toBe('M2');
    expect(reason!.refId).toBe(req.id);
  });

  it('回归：已批准的整教室申请阻止同时段的新申请，相邻时段允许', async () => {
    const { space } = await seedSpace();
    const req = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-16',
      startHour: 9,
      endHour: 11,
    });
    await service.approve(req.id, reviewerL1, { comment: '同意' });
    await service.approve(req.id, reviewerL2, { comment: '同意' });

    await expect(
      service.apply(REQUESTER, {
        spaceId: space.id,
        date: '2099-05-16',
        startHour: 10,
        endHour: 12,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const adjacent = await service.apply(REQUESTER, {
      spaceId: space.id,
      date: '2099-05-16',
      startHour: 11,
      endHour: 12,
    });
    expect(adjacent.status).toBe('pending');
  });
});
