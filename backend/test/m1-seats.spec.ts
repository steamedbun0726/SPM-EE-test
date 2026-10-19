import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Reservation } from '../src/database/entities/reservation.entity';
import { Violation } from '../src/database/entities/violation.entity';
import { Seat } from '../src/database/entities/seat.entity';
import { Space } from '../src/database/entities/space.entity';
import { RoomBookingRequest } from '../src/database/entities/room-booking-request.entity';
import { SystemConfig } from '../src/database/entities/system-config.entity';
import { SeatStatusLog } from '../src/database/entities/seat-status-log.entity';
import { InitSchema1780000000000 } from '../src/database/migrations/1780000000000-init-schema';
import { ReservationsService } from '../src/modules/m1-seats/reservations.service';
import { SpacesService } from '../src/shared/spaces/spaces.service';
import { SeatStateService } from '../src/shared/spaces/seat-state.service';
import { SystemConfigService } from '../src/shared/system-config/system-config.service';

const USER1 = 101;
const USER2 = 102;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

describe('M1 自习座位预约（ReservationsService，sqljs 内存库）', () => {
  let service: ReservationsService;
  let resvRepo: Repository<Reservation>;
  let roomReqRepo: Repository<RoomBookingRequest>;
  let seatRepo: Repository<Seat>;
  let spaceRepo: Repository<Space>;
  let configRepo: Repository<SystemConfig>;

  // 测试基础数据（beforeAll 建一次，beforeEach 只清预约/整教室申请）
  let libSpace: Space;
  let csSpace: Space;
  let allDaySpace: Space;
  let libSeats: Seat[];
  let csSeats: Seat[];
  let allDaySeats: Seat[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqljs',
          autoSave: false,
          migrationsRun: true,
          migrations: [InitSchema1780000000000],
          entities: [
            Reservation,
            Violation,
            Seat,
            Space,
            RoomBookingRequest,
            SystemConfig,
            SeatStatusLog,
          ],
        }),
        TypeOrmModule.forFeature([
          Reservation,
          Violation,
          Seat,
          Space,
          RoomBookingRequest,
          SystemConfig,
          SeatStatusLog,
        ]),
      ],
      providers: [ReservationsService, SpacesService, SeatStateService, SystemConfigService],
    }).compile();

    service = moduleRef.get(ReservationsService);
    resvRepo = moduleRef.get(getRepositoryToken(Reservation));
    roomReqRepo = moduleRef.get(getRepositoryToken(RoomBookingRequest));
    seatRepo = moduleRef.get(getRepositoryToken(Seat));
    spaceRepo = moduleRef.get(getRepositoryToken(Space));
    configRepo = moduleRef.get(getRepositoryToken(SystemConfig));

    libSpace = await spaceRepo.save(
      spaceRepo.create({
        code: 'LIB-A-101',
        name: '图书馆自习区 A101',
        type: 'library',
        ownerDept: '',
        openTime: '08:00',
        closeTime: '22:00',
        isActive: true,
      }),
    );
    csSpace = await spaceRepo.save(
      spaceRepo.create({
        code: 'CS-B-201',
        name: '计算机学院自习室 201',
        type: 'study',
        ownerDept: '计算机学院',
        openTime: '09:00',
        closeTime: '21:00',
        isActive: true,
      }),
    );
    allDaySpace = await spaceRepo.save(
      spaceRepo.create({
        code: 'ALL-001',
        name: '全天自习区',
        type: 'study',
        ownerDept: '',
        openTime: '00:00',
        closeTime: '24:00',
        isActive: true,
      }),
    );

    const mkSeats = async (spaceId: number, n: number): Promise<Seat[]> => {
      const rows: Seat[] = [];
      for (let i = 1; i <= n; i++) {
        rows.push(
          await seatRepo.save(
            seatRepo.create({
              spaceId,
              seatNo: `S${String(i).padStart(2, '0')}`,
              hasSocket: i % 2 === 0,
              isActive: true,
              status: 'available',
              statusSource: 'SYSTEM',
            }),
          ),
        );
      }
      return rows;
    };

    libSeats = await mkSeats(libSpace.id, 10);
    csSeats = await mkSeats(csSpace.id, 4);
    allDaySeats = await mkSeats(allDaySpace.id, 2);
  });

  beforeEach(async () => {
    await resvRepo.clear();
    await roomReqRepo.clear();
    await configRepo.clear();
  });

  it('冲突检测：同座位重叠时段拒绝，非重叠时段放行，搜索结果随之减少', async () => {
    const date = tomorrowStr();
    const seat = libSeats[0];

    const first = await service.bookSeat(USER1, { seatId: seat.id, date, startHour: 9, endHour: 11 });
    expect(first.status).toBe('booked');

    // 时段重叠（右重叠 10-12、左重叠 8-10）均拒绝
    await expect(
      service.bookSeat(USER1, { seatId: seat.id, date, startHour: 10, endHour: 12 }),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.bookSeat(USER1, { seatId: seat.id, date, startHour: 8, endHour: 10 }),
    ).rejects.toThrow(ConflictException);

    // 非重叠时段（11-13 紧邻）可预约
    const ok = await service.bookSeat(USER1, { seatId: seat.id, date, startHour: 11, endHour: 13 });
    expect(ok.status).toBe('booked');

    // 搜索 9-11 时该座位被排除（LIB 自习区还剩 9 个；全天空间座位不设开放时间限制，不在断言内）
    const list = await service.searchSeats({ date, startHour: 9, endHour: 11 });
    expect(list.filter((i) => i.spaceId === libSpace.id)).toHaveLength(9);
    expect(list.find((i) => i.seatId === seat.id)).toBeUndefined();
  });

  it('超时预约拒绝：超过 BOOKING_MAX_HOURS（默认 4，可配置）', async () => {
    const date = tomorrowStr();
    const seat = libSeats[1];

    // 5 小时 > 默认 4 小时
    await expect(
      service.bookSeat(USER1, { seatId: seat.id, date, startHour: 9, endHour: 14 }),
    ).rejects.toThrow(BadRequestException);

    // 配置调低为 2 小时：3 小时被拒，2 小时放行
    await configRepo.save(configRepo.create({ key: 'BOOKING_MAX_HOURS', value: '2' }));
    await expect(
      service.bookSeat(USER1, { seatId: seat.id, date, startHour: 9, endHour: 12 }),
    ).rejects.toThrow(BadRequestException);
    const ok = await service.bookSeat(USER1, { seatId: seat.id, date, startHour: 9, endHour: 11 });
    expect(ok.status).toBe('booked');
  });

  it('签到：错误动态码拒绝，正确码置 checked_in；同空间同日同码', async () => {
    const date = tomorrowStr();
    const seat = libSeats[2];
    const r = await service.bookSeat(USER1, { seatId: seat.id, date, startHour: 10, endHour: 12 });

    await expect(service.checkIn(USER1, r.id, 'WRONG-CODE')).rejects.toThrow(BadRequestException);

    const { code } = service.getDynamicCode(r.spaceId, r.date);
    expect(code).toMatch(/^A\d+\d{4}$/);
    const done = await service.checkIn(USER1, r.id, code);
    expect(done.status).toBe('checked_in');
    expect(done.checkInAt).toBeInstanceOf(Date);
    expect(done.checkInCode).toBe(code);

    // 同空间同日：另一座位动态码一致（空间内共享码）
    const r2 = await service.bookSeat(USER1, { seatId: libSeats[3].id, date, startHour: 10, endHour: 12 });
    expect(service.getDynamicCode(r2.spaceId, r2.date).code).toBe(code);
  });

  it('M2 冲突：approved 整教室预约使该空间该时段座位不可约，非重叠时段不受影响', async () => {
    const date = tomorrowStr();
    await roomReqRepo.save(
      roomReqRepo.create({
        requestCode: 'RB-TEST-0001',
        requesterId: 999,
        spaceId: libSpace.id,
        spaceCode: libSpace.code,
        spaceName: libSpace.name,
        date,
        startHour: 9,
        endHour: 12,
        purpose: '考试',
        status: 'approved',
        currentLevel: 1,
        maxLevel: 1,
      }),
    );

    const list = await service.searchSeats({ spaceId: libSpace.id, date, startHour: 9, endHour: 11 });
    expect(list).toHaveLength(0);

    await expect(
      service.bookSeat(USER1, { seatId: libSeats[4].id, date, startHour: 10, endHour: 11 }),
    ).rejects.toThrow(ConflictException);

    // 不重叠时段仍可预约
    const ok = await service.bookSeat(USER1, { seatId: libSeats[4].id, date, startHour: 13, endHour: 14 });
    expect(ok.status).toBe('booked');
  });

  it('院系自习室：仅本系可见/可预约', async () => {
    const date = tomorrowStr();

    const otherDept = await service.searchSeats({ date, startHour: 10, endHour: 12 }, { department: '数学学院' });
    expect(otherDept.filter((i) => i.spaceId === csSpace.id)).toHaveLength(0);

    const ownDept = await service.searchSeats({ date, startHour: 10, endHour: 12 }, { department: '计算机学院' });
    expect(ownDept.filter((i) => i.spaceId === csSpace.id)).toHaveLength(4);

    await expect(
      service.bookSeat(USER1, { seatId: csSeats[0].id, date, startHour: 10, endHour: 12 }, { department: '数学学院' }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('取消：未开始的 booked 可取消，已开始的不可取消', async () => {
    const future = await service.bookSeat(USER1, {
      seatId: libSeats[5].id,
      date: tomorrowStr(),
      startHour: 10,
      endHour: 12,
    });
    const cancelled = await service.cancel(USER1, future.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);

    // 今天 0-1 已过去的时段：book 可建（契约未禁止过去时段），但不可取消
    const started = await service.bookSeat(USER1, {
      seatId: allDaySeats[0].id,
      date: todayStr(),
      startHour: 0,
      endHour: 1,
    });
    await expect(service.cancel(USER1, started.id)).rejects.toThrow(ConflictException);
  });

  it('历史复用 rebook：取消后按原座位/时段重新预约（复用原行，schema 槽位唯一）', async () => {
    const date = tomorrowStr();
    const seat = libSeats[6];
    const r = await service.bookSeat(USER1, { seatId: seat.id, date, startHour: 14, endHour: 15 });
    await service.cancel(USER1, r.id);

    // 取消后进入历史
    const histBefore = await service.history(USER1, { page: 1 });
    expect(histBefore.items.some((i) => i.id === r.id)).toBe(true);

    // rebook：复用同一行重新激活为 booked
    const reb = await service.rebook(USER1, r.id);
    expect(reb.id).toBe(r.id);
    expect(reb.status).toBe('booked');
    expect(reb.seatId).toBe(seat.id);
    expect(reb.startHour).toBe(14);
    expect(reb.endHour).toBe(15);
    expect(reb.cancelledAt).toBeNull();

    // 活跃预约再 rebook → 拒绝
    await expect(service.rebook(USER1, reb.id)).rejects.toThrow(ConflictException);
  });

  it('stats：按空间统计 bookingCount / noShowCount / checkedInCount', async () => {
    const date = tomorrowStr();
    await service.bookSeat(USER1, { seatId: libSeats[0].id, date, startHour: 9, endHour: 10 }); // booked
    const r = await service.bookSeat(USER2, { seatId: libSeats[1].id, date, startHour: 9, endHour: 10 });
    await service.checkIn(USER2, r.id, service.getDynamicCode(r.spaceId, r.date).code); // checked_in
    const r3 = await service.bookSeat(USER1, { seatId: libSeats[2].id, date, startHour: 9, endHour: 10 });
    await resvRepo.update(r3.id, { status: 'no_show', noShowAt: new Date() }); // no_show

    const rows = await service.stats();
    const row = rows.find((s) => s.spaceId === libSpace.id);
    expect(row).toBeDefined();
    expect(row!.bookingCount).toBe(3);
    expect(row!.checkedInCount).toBe(1);
    expect(row!.noShowCount).toBe(1);
  });
});
