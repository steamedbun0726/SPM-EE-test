import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ConflictException } from '@nestjs/common';

import { M1SeatsModule } from '../src/modules/m1-seats/m1-seats.module';
import { M2RoomsModule } from '../src/modules/m2-rooms/m2-rooms.module';
import { M3MaintenanceModule } from '../src/modules/m3-maintenance/m3-maintenance.module';
import { SharedModule } from '../src/shared/shared.module';
import { InitSchema1780000000000 } from '../src/database/migrations/1780000000000-init-schema';

import { ReservationsService } from '../src/modules/m1-seats/reservations.service';
import { RoomRequestsService } from '../src/modules/m2-rooms/room-requests.service';
import { WorkOrdersService } from '../src/modules/m3-maintenance/work-orders.service';
import { SeatStateService } from '../src/shared/spaces/seat-state.service';

import { User } from '../src/database/entities/user.entity';
import { Role } from '../src/database/entities/role.entity';
import { Permission } from '../src/database/entities/permission.entity';
import { Space } from '../src/database/entities/space.entity';
import { Seat } from '../src/database/entities/seat.entity';
import { SeatStatusLog } from '../src/database/entities/seat-status-log.entity';
import { Reservation } from '../src/database/entities/reservation.entity';
import { Violation } from '../src/database/entities/violation.entity';
import { Notification } from '../src/database/entities/notification.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { SystemConfig } from '../src/database/entities/system-config.entity';
import { RoomBookingRequest } from '../src/database/entities/room-booking-request.entity';
import { ApprovalRecord } from '../src/database/entities/approval-record.entity';
import { WorkOrder } from '../src/database/entities/work-order.entity';

/**
 * 跨模块集成回归（阶段 6）：
 * 1. M2 二级审批通过 → 座位被占用（M1 搜索该室该时段返回 0、个人预约被拒）；撤销/超时后回滚。
 * 2. M3 报修上报 → 座位下架（M1 搜索返回 0）；验收通过后恢复。
 * 3. seat_status_logs 写入来源 M2 / M3 可追溯；M1 个人预约以 Reservation 表达占用，不篡改座位状态。
 */
describe('跨模块集成回归（M2→M1 / M3→M1 / 来源追溯）', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let reservations: ReservationsService;
  let roomRequests: RoomRequestsService;
  let workOrders: WorkOrdersService;
  let seatState: SeatStateService;
  let spaceRepo: Repository<Space>;
  let seatRepo: Repository<Seat>;
  let seatLogRepo: Repository<SeatStatusLog>;
  let resvRepo: Repository<Reservation>;

  const REQUESTER = 101;
  const APPROVER1 = 201;
  const APPROVER2 = 202;
  const REPORTER = 1;
  const DISPATCHER = 2;
  const ASSIGNEE = 99;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqljs',
          autoSave: false,
          migrationsRun: true,
          entities: [
            User,
            Role,
            Permission,
            Space,
            Seat,
            SeatStatusLog,
            Reservation,
            Violation,
            Notification,
            AuditLog,
            SystemConfig,
            RoomBookingRequest,
            ApprovalRecord,
            WorkOrder,
          ],
          migrations: [InitSchema1780000000000],
        }),
        SharedModule,
        M1SeatsModule,
        M2RoomsModule,
        M3MaintenanceModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    reservations = moduleRef.get(ReservationsService);
    roomRequests = moduleRef.get(RoomRequestsService);
    workOrders = moduleRef.get(WorkOrdersService);
    seatState = moduleRef.get(SeatStateService);
    spaceRepo = moduleRef.get(getRepositoryToken(Space));
    seatRepo = moduleRef.get(getRepositoryToken(Seat));
    seatLogRepo = moduleRef.get(getRepositoryToken(SeatStatusLog));
    resvRepo = moduleRef.get(getRepositoryToken(Reservation));
  });

  beforeEach(async () => {
    await dataSource.synchronize(true);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  let seq = 0;
  async function createSpaceWithSeats(n = 2): Promise<{ space: Space; seats: Seat[] }> {
    seq += 1;
    const space = await spaceRepo.save(
      spaceRepo.create({
        code: `CM-${seq}`,
        name: `跨模块测试教室 ${seq}`,
        type: 'classroom',
        openTime: '08:00',
        closeTime: '22:00',
      }),
    );
    const seats: Seat[] = [];
    for (let i = 1; i <= n; i++) {
      seats.push(await seatRepo.save(seatRepo.create({ spaceId: space.id, seatNo: `S${i}` })));
    }
    return { space, seats };
  }

  const DATE = '2026-11-10';

  it('M2 二级审批通过：座位占用（M2 来源）→ M1 搜索 0、个人预约被拒；撤销后回滚恢复', async () => {
    const { space, seats } = await createSpaceWithSeats();

    // 审批前：M1 可搜到 2 个座位
    expect(await reservations.searchSeats({ date: DATE, startHour: 9, endHour: 11 })).toHaveLength(2);

    const req = await roomRequests.apply(REQUESTER, {
      spaceId: space.id,
      date: DATE,
      startHour: 9,
      endHour: 11,
      purpose: '课程讲座',
    });
    await roomRequests.approve(req.id, APPROVER1, { approverName: '陈审批' });
    const approved = await roomRequests.approve(req.id, APPROVER2, { approverName: '王老师' });
    expect(approved.status).toBe('approved');

    // M2 → M1：座位占用，写入来源 M2
    const occupied = await seatRepo.findBy({ spaceId: space.id });
    for (const s of occupied) {
      expect(s.status).toBe('occupied_by_room');
      expect(s.statusSource).toBe('M2');
    }

    // M1 搜索该室该时段返回 0；个人预约被冲突拦截
    expect(await reservations.searchSeats({ date: DATE, startHour: 9, endHour: 11 })).toHaveLength(0);
    await expect(
      reservations.bookSeat(REQUESTER, { seatId: seats[0].id, date: DATE, startHour: 10, endHour: 12 }),
    ).rejects.toBeInstanceOf(ConflictException);

    // 来源追溯：M2 / room_request / 关联申请单
    const logs = await seatState.history(seats[0].id);
    expect(logs[0]).toMatchObject({
      source: 'M2',
      refType: 'room_request',
      refId: req.id,
      toStatus: 'occupied_by_room',
    });

    // 撤销 → 座位回滚 available，M1 搜索恢复
    await roomRequests.cancel(REQUESTER, req.id);
    const restored = await seatRepo.findBy({ spaceId: space.id });
    for (const s of restored) {
      expect(s.status).toBe('available');
    }
    expect(await reservations.searchSeats({ date: DATE, startHour: 9, endHour: 11 })).toHaveLength(2);

    const latest = await seatState.history(seats[0].id);
    expect(latest[0]).toMatchObject({ source: 'M2', toStatus: 'available', refId: req.id });
  });

  it('M2 驳回：不占用座位，M1 搜索保持可约', async () => {
    const { space } = await createSpaceWithSeats();
    const req = await roomRequests.apply(REQUESTER, {
      spaceId: space.id,
      date: '2026-11-12',
      startHour: 14,
      endHour: 16,
    });

    await roomRequests.reject(req.id, APPROVER1, { comment: '教室另有安排' });

    const seats = await seatRepo.findBy({ spaceId: space.id });
    for (const s of seats) {
      expect(s.status).toBe('available');
      expect(s.statusSource).toBeNull();
    }
    expect(await reservations.searchSeats({ date: '2026-11-12', startHour: 14, endHour: 16 })).toHaveLength(2);
    // 未占用 → 不产生 M2 状态变更日志
    expect(await seatLogRepo.countBy({ spaceId: space.id })).toBe(0);
  });

  it('M2 审批超时自动撤销：座位保持可约，未产生占用日志', async () => {
    const { space } = await createSpaceWithSeats();
    const req = await roomRequests.apply(REQUESTER, {
      spaceId: space.id,
      date: '2026-11-13',
      startHour: 9,
      endHour: 11,
    });
    req.timeoutAt = new Date(Date.now() - 1000);
    await dataSource.getRepository(RoomBookingRequest).save(req);

    expect(await roomRequests.expireOverdue()).toBe(1);
    const expired = await dataSource.getRepository(RoomBookingRequest).findOneBy({ id: req.id });
    expect(expired!.status).toBe('expired');
    expect(await reservations.searchSeats({ date: '2026-11-13', startHour: 9, endHour: 11 })).toHaveLength(2);
    expect(await seatLogRepo.countBy({ spaceId: space.id })).toBe(0);
  });

  it('M3 报修上报：座位下架（M3 来源）→ M1 搜索 0；验收后恢复可约', async () => {
    const { space, seats } = await createSpaceWithSeats();
    expect(await reservations.searchSeats({ date: DATE, startHour: 9, endHour: 11 })).toHaveLength(2);

    const wo = await workOrders.report(REPORTER, {
      title: '灯管损坏',
      targetType: 'space',
      spaceId: space.id,
    });

    const down = await seatRepo.findBy({ spaceId: space.id });
    for (const s of down) {
      expect(s.status).toBe('maintenance');
      expect(s.statusSource).toBe('M3');
    }
    expect(await reservations.searchSeats({ date: DATE, startHour: 9, endHour: 11 })).toHaveLength(0);
    // 维修中座位不可个人预约
    await expect(
      reservations.bookSeat(REQUESTER, { seatId: seats[0].id, date: DATE, startHour: 9, endHour: 11 }),
    ).rejects.toBeInstanceOf(ConflictException);

    await workOrders.dispatch(wo.id, ASSIGNEE, DISPATCHER);
    await workOrders.startWork(wo.id, ASSIGNEE);
    await workOrders.complete(wo.id, ASSIGNEE);
    await workOrders.accept(wo.id, REPORTER, { rating: 5, comment: '已修复' });

    const up = await seatRepo.findBy({ spaceId: space.id });
    for (const s of up) {
      expect(s.status).toBe('available');
      expect(s.statusSource).toBe('M3');
    }
    expect(await reservations.searchSeats({ date: DATE, startHour: 9, endHour: 11 })).toHaveLength(2);

    const logs = await seatState.history(seats[0].id, 10);
    expect(logs.map((l) => l.toStatus)).toEqual(['available', 'maintenance']);
    expect(logs.every((l) => l.source === 'M3' && l.refType === 'work_order' && l.refId === wo.id)).toBe(true);
  });

  it('来源追溯：M2 / M3 写入 seat_status_logs 可区分；M1 个人预约以 Reservation 表达且不改座位状态', async () => {
    const room = await createSpaceWithSeats();
    const studio = await createSpaceWithSeats();

    // M2 占用教室 A
    const req = await roomRequests.apply(REQUESTER, {
      spaceId: room.space.id,
      date: '2026-11-14',
      startHour: 9,
      endHour: 11,
    });
    await roomRequests.approve(req.id, APPROVER1, {});
    await roomRequests.approve(req.id, APPROVER2, {});

    // M3 下架自习室 B
    await workOrders.report(REPORTER, { title: '空调故障', targetType: 'space', spaceId: studio.space.id });

    // M1 在另一空间 C 预约（不改变座位状态）
    const free = await createSpaceWithSeats();
    const beforeStatus = (await seatRepo.findBy({ spaceId: free.space.id })).map((s) => s.status);
    await reservations.bookSeat(REQUESTER, {
      seatId: free.seats[0].id,
      date: '2026-11-15',
      startHour: 9,
      endHour: 11,
    });
    const afterStatus = (await seatRepo.findBy({ spaceId: free.space.id })).map((s) => s.status);
    expect(afterStatus).toEqual(beforeStatus);
    expect(afterStatus.every((s) => s === 'available')).toBe(true);
    expect(await resvRepo.countBy({ spaceId: free.space.id })).toBe(1);
    expect(await seatLogRepo.countBy({ spaceId: free.space.id })).toBe(0);

    // 来源可区分：M2 与 M3 各一套日志
    const sources = await seatLogRepo.find();
    expect(new Set(sources.map((l) => l.source))).toEqual(new Set(['M2', 'M3']));
    expect(await seatLogRepo.countBy({ spaceId: room.space.id, source: 'M2' })).toBe(2);
    expect(await seatLogRepo.countBy({ spaceId: studio.space.id, source: 'M3' })).toBe(2);
  });
});
