import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { M3MaintenanceModule } from '../src/modules/m3-maintenance/m3-maintenance.module';
import { ReservationsService } from '../src/modules/m1-seats/reservations.service';
import { WorkOrdersService } from '../src/modules/m3-maintenance/work-orders.service';
import { SharedModule } from '../src/shared/shared.module';
import { InitSchema1780000000000 } from '../src/database/migrations/1780000000000-init-schema';
import { M3WorkOrderEnhance1780000001000 } from '../src/database/migrations/1780000001000-m3-work-order-enhance';
import { M3WorkOrderFields1780000002000 } from '../src/database/migrations/1780000002000-m3-work-order-fields';
import { M3HoldMergeStats1780000003000 } from '../src/database/migrations/1780000003000-m3-hold-merge-stats';

import { WorkOrder } from '../src/database/entities/work-order.entity';
import { WorkOrderEvent } from '../src/database/entities/work-order-event.entity';
import { Seat } from '../src/database/entities/seat.entity';
import { Space } from '../src/database/entities/space.entity';
import { SeatStatusLog } from '../src/database/entities/seat-status-log.entity';
import { Notification } from '../src/database/entities/notification.entity';
import { SystemConfig } from '../src/database/entities/system-config.entity';
import { Reservation } from '../src/database/entities/reservation.entity';
import { Violation } from '../src/database/entities/violation.entity';
import { RoomBookingRequest } from '../src/database/entities/room-booking-request.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { User } from '../src/database/entities/user.entity';
import { Role } from '../src/database/entities/role.entity';
import { Permission } from '../src/database/entities/permission.entity';

/**
 * M3 二期能力集成测试（内存 sqljs）。
 *
 * 覆盖 13 条补充需求中的可自动化部分：
 * 部分下架、下架作废预约、留言、ETA、申诉裁决、超时预警、
 * 重复故障、维修员负载、低分回访、照片约束、优先级排序、误报限制、字典。
 * 全部断言真实落库结果与事件时间线，不 mock 被测逻辑。
 */
describe('M3 工单协作与治理（二期）', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: WorkOrdersService;
  let spaceRepo: Repository<Space>;
  let seatRepo: Repository<Seat>;
  let woRepo: Repository<WorkOrder>;
  let eventRepo: Repository<WorkOrderEvent>;
  let resvRepo: Repository<Reservation>;
  let notifRepo: Repository<Notification>;
  let userRepo: Repository<User>;
  let roleRepo: Repository<Role>;
  let permRepo: Repository<Permission>;
  let reservations: ReservationsService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'sqljs',
          autoSave: false,
          migrationsRun: true,
          entities: [
            User, Role, Permission,
            Space, Seat, SeatStatusLog,
            Reservation, Violation, RoomBookingRequest,
            Notification, AuditLog, SystemConfig,
            WorkOrder, WorkOrderEvent,
          ],
          migrations: [
            InitSchema1780000000000,
            M3WorkOrderEnhance1780000001000,
            M3WorkOrderFields1780000002000,
            M3HoldMergeStats1780000003000,
          ],
        }),
        SharedModule,
        M3MaintenanceModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    service = moduleRef.get(WorkOrdersService);
    spaceRepo = moduleRef.get(getRepositoryToken(Space));
    seatRepo = moduleRef.get(getRepositoryToken(Seat));
    woRepo = moduleRef.get(getRepositoryToken(WorkOrder));
    eventRepo = moduleRef.get(getRepositoryToken(WorkOrderEvent));
    resvRepo = moduleRef.get(getRepositoryToken(Reservation));
    notifRepo = moduleRef.get(getRepositoryToken(Notification));
    userRepo = moduleRef.get(getRepositoryToken(User));
    roleRepo = moduleRef.get(getRepositoryToken(Role));
    permRepo = moduleRef.get(getRepositoryToken(Permission));
    reservations = moduleRef.get(ReservationsService);
  });

  beforeEach(async () => {
    await dataSource.synchronize(true);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function createSpaceWithSeats(n = 3): Promise<{ space: Space; seats: Seat[] }> {
    const space = await spaceRepo.save(
      spaceRepo.create({
        code: `T-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        name: '测试自习室',
        openTime: '07:00',
        closeTime: '23:00',
      }),
    );
    const seats: Seat[] = [];
    for (let i = 1; i <= n; i++) {
      seats.push(await seatRepo.save(seatRepo.create({ spaceId: space.id, seatNo: `S${i}` })));
    }
    return { space, seats };
  }

  function ymd(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // ===== M3-19 部分下架 =====

  it('部分下架：只下架指定座位，其余座位保持可预约；验收后只恢复这批座位', async () => {
    const { space, seats } = await createSpaceWithSeats(3);
    const wo = await service.report(1, {
      title: 'S1 S2 桌面插座无电',
      targetType: 'space',
      spaceId: space.id,
      seatIds: [seats[0].id, seats[1].id],
    });

    expect(JSON.parse(wo.seatIds)).toEqual([seats[0].id, seats[1].id]);
    const after = await seatRepo.find({ where: { spaceId: space.id }, order: { id: 'ASC' } });
    expect(after[0].status).toBe('maintenance');
    expect(after[1].status).toBe('maintenance');
    expect(after[2].status).toBe('available'); // 未受影响的座位不动

    await service.dispatch(wo.id, 99, 1);
    await service.startWork(wo.id, 99);
    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
    await service.accept(wo.id, 1, { rating: 5 });

    const restored = await seatRepo.find({ where: { spaceId: space.id } });
    expect(restored.every((s) => s.status === 'available')).toBe(true);
  });

  it('部分下架边界：座位不属于所选空间、座位不存在、已停用座位均被拒绝', async () => {
    const a = await createSpaceWithSeats(2);
    const b = await createSpaceWithSeats(2);

    await expect(
      service.report(1, {
        title: '跨空间',
        targetType: 'space',
        spaceId: a.space.id,
        seatIds: [a.seats[0].id, b.seats[0].id],
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.report(1, { title: '不存在', targetType: 'space', spaceId: a.space.id, seatIds: [999999] }),
    ).rejects.toThrow('座位不存在');

    await seatRepo.update(a.seats[0].id, { isActive: false });
    await expect(
      service.report(1, { title: '停用', targetType: 'space', spaceId: a.space.id, seatIds: [a.seats[0].id] }),
    ).rejects.toThrow('座位已停用');
  });

  // ===== M3-24 下架作废已有预约 =====

  it('下架即作废该座位未来预约并通知本人，且不计违约', async () => {
    const { space, seats } = await createSpaceWithSeats(1);
    const tomorrow = new Date(Date.now() + 86400_000);

    const resv = await resvRepo.save(
      resvRepo.create({
        userId: 7,
        seatId: seats[0].id,
        spaceId: space.id,
        spaceCode: space.code,
        spaceName: space.name,
        seatNo: seats[0].seatNo,
        date: ymd(tomorrow),
        startHour: 9,
        endHour: 11,
        status: 'booked',
      }),
    );

    const wo = await service.report(1, {
      title: '座位下方漏水',
      targetType: 'seat',
      targetId: seats[0].id,
    });

    const after = await resvRepo.findOneBy({ id: resv.id });
    expect(after!.status).toBe('cancelled');
    expect(after!.cancelledAt).toBeTruthy();

    // 不计违约：violations 表必须为空
    const violations = await dataSource.getRepository(Violation).find();
    expect(violations).toHaveLength(0);

    // 本人收到通知
    const notifs = await notifRepo.findBy({ userId: 7 });
    expect(notifs.some((n) => n.title.includes('预约已被取消'))).toBe(true);

    // 时间线留痕
    const events = await service.listEvents(wo.id);
    const released = events.find((e) => e.type === 'seats_released');
    expect(released!.note).toContain('作废预约 1 条');
  });

  it('已开场的预约不取消，标记为待人工协调并通知管理员', async () => {
    const { space, seats } = await createSpaceWithSeats(1);
    const now = new Date();
    // 构造「时段已开始但尚未结束」：起点取当前整点，终点取下一整点（23 点时 roll 到次日 0 点）
    const startHour = now.getHours();
    const endHour = Math.min(24, startHour + 1);

    const resv = await resvRepo.save(
      resvRepo.create({
        userId: 7,
        seatId: seats[0].id,
        spaceId: space.id,
        spaceCode: space.code,
        spaceName: space.name,
        seatNo: seats[0].seatNo,
        date: ymd(now),
        startHour,
        endHour,
        status: 'booked',
      }),
    );

    const wo = await service.report(1, { title: '灯管冒烟', targetType: 'seat', targetId: seats[0].id });

    const after = await resvRepo.findOneBy({ id: resv.id });
    expect(after!.status).toBe('booked'); // 不硬性取消：人可能已经坐下了

    // 用户收到提醒，而不是"您的预约已取消"
    const notifs = await notifRepo.findBy({ userId: 7 });
    expect(notifs.some((n) => n.title === '座位维修提醒')).toBe(true);
    expect(notifs.some((n) => n.title === '预约已被取消（座位维修）')).toBe(false);

    const events = await service.listEvents(wo.id);
    expect(events.find((e) => e.type === 'seats_released')!.note).toContain('在座待协调 1 条');
  });

  it('作废预约后同一座位同时段仍可重新预约（不因唯一索引报错）', async () => {
    const { space, seats } = await createSpaceWithSeats(1);
    const tomorrow = ymd(new Date(Date.now() + 86400_000));

    const first = await reservations.bookSeat(2, {
      seatId: seats[0].id,
      date: tomorrow,
      startHour: 9,
      endHour: 11,
    });
    expect(first.status).toBe('booked');

    // 维修下架 → 预约被作废
    await service.report(1, { title: '座位损坏', targetType: 'seat', targetId: seats[0].id });
    expect((await resvRepo.findOneBy({ id: first.id }))!.status).toBe('cancelled');

    // 座位恢复后可再次预约同一时段（复用历史行，不能抛唯一约束错）
    await service.cancel(
      (await woRepo.findOneBy({ targetId: seats[0].id }))!.id,
      1,
      { reason: '已自行修复' },
    );
    const again = await reservations.bookSeat(2, {
      seatId: seats[0].id,
      date: tomorrow,
      startHour: 9,
      endHour: 12,
    });
    expect(again.id).toBe(first.id); // 复用同一行
    expect(again.status).toBe('booked');
    expect(again.endHour).toBe(12);
  });

  // ===== M3-20 留言 =====

  it('留言进入时间线并通知对方；无关用户被拒绝', async () => {
    const wo = await service.report(1, { title: '桌椅松动', targetType: 'other' }, '张三');
    await service.dispatch(wo.id, 99, 1, '李运营');

    const created = await service.addComment(wo.id, 99, '已到现场，需要更换螺丝', '张师傅');
    expect(created.type).toBe('commented');
    expect(created.note).toBe('已到现场，需要更换螺丝');
    expect(created.operatorName).toBe('张师傅');

    // 上报人收到通知（维修员的留言要送到用户那里）
    const reporterNotifs = await notifRepo.findBy({ userId: 1 });
    expect(reporterNotifs.some((n) => n.title === '工单有新留言')).toBe(true);

    // 无关用户无权留言
    await expect(service.addComment(wo.id, 555, '我是路人', '路人', [])).rejects.toThrow(
      ForbiddenException,
    );
    // 有派单权限的管理者可以留言
    await expect(
      service.addComment(wo.id, 5, '请今天内完成', '李运营', ['workorder.dispatch']),
    ).resolves.toBeTruthy();
    // 空留言被拒
    await expect(service.addComment(wo.id, 1, '   ', '张三')).rejects.toThrow(BadRequestException);
  });

  // ===== M3-21 预计恢复时间 =====

  it('ETA 可更新并通知上报人，写入时间线；过去时间与超远时间被拒', async () => {
    const wo = await service.report(1, { title: '空调不制冷', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);

    const eta = new Date(Date.now() + 3 * 3600_000);
    const updated = await service.updateEta(wo.id, 99, eta.toISOString(), '张师傅');
    expect(new Date(updated.etaAt!).getTime()).toBe(eta.getTime());

    const events = await service.listEvents(wo.id);
    const etaEvent = events.find((e) => e.type === 'eta_updated');
    expect(etaEvent!.note).toContain('预计恢复时间');

    const notifs = await notifRepo.findBy({ userId: 1 });
    expect(notifs.some((n) => n.title === '预计恢复时间已更新')).toBe(true);

    await expect(
      service.updateEta(wo.id, 99, new Date(Date.now() - 3600_000).toISOString()),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.updateEta(wo.id, 99, new Date(Date.now() + 40 * 86400_000).toISOString()),
    ).rejects.toThrow('不能超过');
  });

  // ===== M3-22 申诉与裁决 =====

  it('申诉裁决不成立：维持返工，状态仍为维修中', async () => {
    const wo = await service.report(1, { title: '插座无电', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);
    await service.startWork(wo.id, 99);
    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
    await service.accept(wo.id, 1, { result: 'fail', comment: '还是没电' });

    const appealed = await service.appeal(wo.id, 99, '已测量电压正常，怀疑是设备本身', '张师傅');
    expect(appealed.appealAt).toBeTruthy();
    expect(appealed.appealResult).toBeNull();

    // 重复申诉被拒
    await expect(service.appeal(wo.id, 99, '再次申诉')).rejects.toThrow(ConflictException);

    const resolved = await service.resolveAppeal(wo.id, 5, 'upheld', '李运营', '现场复测无电');
    expect(resolved.appealResult).toBe('upheld');
    expect(resolved.status).toBe('in_progress'); // 仍须返工
    expect(resolved.reopenCount).toBe(1);

    const events = await service.listEvents(wo.id);
    const ev = events.find((e) => e.type === 'appeal_resolved');
    expect(ev!.note).toContain('维持返工');
  });

  it('申诉裁决成立：视同验收通过、抵消返工计数、恢复座位', async () => {
    const { space, seats } = await createSpaceWithSeats(2);
    const wo = await service.report(1, {
      title: '门锁卡顿',
      targetType: 'space',
      spaceId: space.id,
    });
    await service.dispatch(wo.id, 99, 1);
    await service.startWork(wo.id, 99);
    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
    await service.accept(wo.id, 1, { result: 'fail', comment: '还是卡' });
    await service.appeal(wo.id, 99, '已更换锁芯并测试 10 次正常');

    const resolved = await service.resolveAppeal(wo.id, 5, 'overturned', '李运营', '复测正常');
    expect(resolved.status).toBe('accepted');
    expect(resolved.reopenCount).toBe(0);
    expect(resolved.appealResult).toBe('overturned');

    const after = await seatRepo.findBy({ spaceId: space.id });
    expect(after.map((s) => s.status)).toEqual(seats.map(() => 'available'));
  });

  it('申诉受限：未返工不可申诉、非本人不可申诉、裁决不可重复', async () => {
    const wo = await service.report(1, { title: '水龙头滴水', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);
    await service.startWork(wo.id, 99);
    await expect(service.appeal(wo.id, 99, '没修就申诉')).rejects.toThrow(ConflictException);

    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
    await expect(service.appeal(wo.id, 99, '还没验收就申诉')).rejects.toThrow(ConflictException);
    await service.accept(wo.id, 1, { result: 'fail', comment: '还滴' });

    await expect(service.appeal(wo.id, 100, '不是我做的单')).rejects.toThrow(ForbiddenException);
    await service.appeal(wo.id, 99, '已换密封圈');
    await service.resolveAppeal(wo.id, 5, 'upheld');
    await expect(service.resolveAppeal(wo.id, 5, 'upheld')).rejects.toThrow(ConflictException);
  });

  // ===== M3-23 超时预警 =====

  it('剩余时限不足 20% 时发预警且只发一次；派单/维修中才预警', async () => {
    const wo = await service.report(1, { title: '投影仪不亮', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);

    // 人造一个「总时长 100h、剩余 1h」的窗口
    await woRepo.update(wo.id, {
      createdAt: new Date(Date.now() - 100 * 3600_000),
      slaDeadline: new Date(Date.now() + 3600_000),
      slaWarned: false,
    });

    expect(await service.warnSlaApproaching()).toBe(1);
    expect(await service.warnSlaApproaching()).toBe(0); // 不重复轰炸

    const notifs = await notifRepo.findBy({ userId: 99 });
    expect(notifs.some((n) => n.title === '工单即将超时')).toBe(true);

    const events = await service.listEvents(wo.id);
    expect(events.some((e) => e.type === 'warned')).toBe(true);

    // 剩余充裕的工单不预警
    const other = await service.report(1, { title: '椅子腿松', targetType: 'other' });
    await service.dispatch(other.id, 99, 1);
    expect(await service.warnSlaApproaching()).toBe(0);
  });

  it('首响超时也会触发升级，且升级后预警标记被重置', async () => {
    const wo = await service.report(1, { title: '网线脱落', targetType: 'other' });
    // 只让首响时限过期，解决时限仍充裕
    await woRepo.update(wo.id, {
      responseDeadline: new Date(Date.now() - 3600_000),
      slaDeadline: new Date(Date.now() + 20 * 3600_000),
      slaWarned: true,
    });

    expect(await service.escalateOverdue()).toBe(1);
    const after = await woRepo.findOneBy({ id: wo.id });
    expect(after!.escalated).toBe(true);
    expect(after!.slaWarned).toBe(false);

    const events = await service.listEvents(wo.id);
    expect(events.find((e) => e.type === 'escalated')!.note).toContain('首响超时');
  });

  // ===== M3-25 重复故障 =====

  it('同空间同分类 30 天内第 3 次故障标记疑似设备老化', async () => {
    const { space, seats } = await createSpaceWithSeats(3);

    const w1 = await service.report(1, { title: '插座1', category: 'electrical', targetType: 'seat', targetId: seats[0].id });
    const w2 = await service.report(1, { title: '插座2', category: 'electrical', targetType: 'seat', targetId: seats[1].id });
    expect(w1.degradedSuspected).toBe(false);
    expect(w2.degradedSuspected).toBe(false);

    const w3 = await service.report(1, { title: '插座3', category: 'electrical', targetType: 'seat', targetId: seats[2].id });
    expect(w3.degradedSuspected).toBe(true);

    const list = await service.listDegraded();
    expect(list.map((w) => w.id)).toContain(w3.id);
  });

  // ===== M3-26 维修员负载 =====

  it('维修员负载视图输出在手单量、评分、修复时长与技能画像', async () => {
    const perm = await permRepo.save(
      permRepo.create({ code: 'workorder.handle', name: '工单处理', description: '' }),
    );
    const role = await roleRepo.save(
      roleRepo.create({ code: 'maintenance', name: '物业维修员', description: '', permissions: [perm] }),
    );
    const worker = await userRepo.save(
      userRepo.create({ username: 'm1', passwordHash: 'x', name: '张师傅', department: '后勤保障部', roles: [role] }),
    );

    const w1 = await service.report(1, { title: 'A', category: 'plumbing', targetType: 'other' });
    await service.dispatch(w1.id, worker.id, 1);
    await service.startWork(w1.id, worker.id);
    await service.complete(w1.id, worker.id, { resolutionNote: '已更换损坏部件并测试通过' });
    await service.accept(w1.id, 1, { rating: 5 });

    const w2 = await service.report(1, { title: 'B', category: 'plumbing', targetType: 'other' });
    await service.dispatch(w2.id, worker.id, 1);

    const rows = await service.technicianWorkload();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.userId).toBe(worker.id);
    expect(row.name).toBe('张师傅');
    expect(row.activeCount).toBe(1); // w2 在手工单
    expect(row.completedCount).toBe(1);
    expect(row.avgRating).toBe(5);
    expect(row.avgHandleHours).not.toBeNull();
    expect(row.topCategories[0]).toEqual({ category: 'plumbing', name: '给排水', count: 2 });
  });

  // ===== M3-27 低分回访 =====

  it('评分 ≤2 分自动进入回访队列，处理后可关闭', async () => {
    const wo = await service.report(1, { title: '清洁未做', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);
    await service.startWork(wo.id, 99);
    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
    const accepted = await service.accept(wo.id, 1, { rating: 2, comment: '地面还是脏的' });

    expect(accepted.revisitRequired).toBe(true);
    expect(accepted.revisitHandled).toBe(false);
    const queue = await service.listRevisits();
    expect(queue.map((w) => w.id)).toContain(wo.id);

    const handled = await service.handleRevisit(wo.id, 5, '已重新保洁并电话回访用户', '李运营');
    expect(handled.revisitHandled).toBe(true);
    expect(await service.listRevisits()).toHaveLength(0);

    const events = await service.listEvents(wo.id);
    expect(events.some((e) => e.type === 'revisited')).toBe(true);
    await expect(service.handleRevisit(wo.id, 5, '重复处理')).rejects.toThrow(ConflictException);
  });

  it('高分评价不触发回访', async () => {
    const wo = await service.report(1, { title: '换灯管', targetType: 'other' });
    await service.dispatch(wo.id, 99, 1);
    await service.startWork(wo.id, 99);
    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' });
    const accepted = await service.accept(wo.id, 1, { rating: 5 });
    expect(accepted.revisitRequired).toBe(false);
  });

  // ===== M3-28 照片 =====

  it('照片数量与协议校验：超过 3 张或非 http(s)/站内路径均被拒', async () => {
    await expect(
      service.report(1, {
        title: '照片超量',
        targetType: 'other',
        photoUrls: ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg', 'https://a/4.jpg'],
      }),
    ).rejects.toThrow('最多上传 3 张');

    await expect(
      service.report(1, { title: '非法协议', targetType: 'other', photoUrls: ['javascript:alert(1)'] }),
    ).rejects.toThrow('照片地址不合法');

    const wo = await service.report(1, {
      title: '正常照片',
      targetType: 'other',
      photoUrls: ['https://cdn.example.com/1.jpg', '/uploads/2.jpg'],
    });
    expect(JSON.parse(wo.photoUrls)).toHaveLength(2);

    // 补传也走同一套校验
    await expect(service.updatePhotos(wo.id, 1, ['data:text/html,<script>'])).rejects.toThrow(
      '照片地址不合法',
    );
    const updated = await service.updatePhotos(wo.id, 1, ['https://cdn.example.com/3.jpg']);
    expect(JSON.parse(updated.photoUrls)).toEqual(['https://cdn.example.com/3.jpg']);
    // 视图层才做 JSON 解析，控制器负责包装（见 toView）
    expect(service.toView(updated).photoUrlList).toEqual(['https://cdn.example.com/3.jpg']);
  });

  // ===== M3-29 优先级 =====

  it('优先级决定 SLA 时长：同分类下 urgent 时限显著短于 low', async () => {
    const urgent = await service.report(1, { title: 'U', category: 'furniture', priority: 'urgent', targetType: 'other' });
    const low = await service.report(1, { title: 'L', category: 'furniture', priority: 'low', targetType: 'other' });
    const urgentHours = (urgent.slaDeadline!.getTime() - Date.now()) / 3600_000;
    const lowHours = (low.slaDeadline!.getTime() - Date.now()) / 3600_000;
    expect(urgentHours).toBeLessThan(15); // 48 * 0.3 ≈ 14
    expect(lowHours).toBeGreaterThan(70); // 48 * 1.5 = 72
  });

  it('待派单队列按优先级降序排序，同级按解决时限升序', async () => {
    const low = await service.report(1, { title: '低', priority: 'low', targetType: 'other' });
    const urgent = await service.report(1, { title: '急', priority: 'urgent', targetType: 'other' });
    const high = await service.report(1, { title: '高', priority: 'high', targetType: 'other' });

    const queue = await service.listPending();
    expect(queue.map((w) => w.id)).toEqual([urgent.id, high.id, low.id]);
    // 视图字段可直接用于前端展示
    expect(queue[0].priorityLabel).toBe('紧急');
    expect(queue[0].slaUsedRatio).toBeGreaterThanOrEqual(0);
  });

  // ===== M3-30 误报限制 =====

  it('同对象已有处理中工单时拒绝重复上报', async () => {
    const { space, seats } = await createSpaceWithSeats(2);
    await service.report(1, { title: '第一次', targetType: 'seat', targetId: seats[0].id });
    await expect(
      service.report(1, { title: '重复上报', targetType: 'seat', targetId: seats[0].id }),
    ).rejects.toThrow('请勿重复上报');

    // 同空间不同座位不受影响
    await expect(
      service.report(1, { title: '另一个座位', targetType: 'seat', targetId: seats[1].id }),
    ).resolves.toBeTruthy();
    // 整空间报修与座位报修在座位有交集时同样判重
    await expect(
      service.report(1, { title: '整间', targetType: 'space', spaceId: space.id }),
    ).rejects.toThrow('请勿重复上报');
  });

  it('窗口期内取消过多则限制继续上报', async () => {
    for (let i = 0; i < 5; i++) {
      const wo = await service.report(1, { title: `误报${i}`, targetType: 'other' });
      await service.cancel(wo.id, 1, { reason: '报错了' });
    }
    await expect(service.report(1, { title: '还想报', targetType: 'other' })).rejects.toThrow(
      '已暂时限制上报',
    );
    // 其他用户不受影响
    await expect(service.report(2, { title: '别人能报', targetType: 'other' })).resolves.toBeTruthy();
  });

  // ===== M3-31 字典 =====

  it('字典接口返回分类、优先级、状态与限制，供前端选择器使用', () => {
    const meta = service.meta();
    expect(meta.categories.map((c) => c.code)).toContain('plumbing');
    expect(meta.categories.every((c) => c.name.length > 0 && c.defaultSlaHours > 0)).toBe(true);
    expect(meta.priorities.map((p) => p.code)).toEqual(['low', 'medium', 'high', 'urgent']);
    expect(meta.statuses.map((s) => s.code)).toContain('in_progress');
    expect(meta.limits.maxPhotos).toBe(3);
    expect(meta.limits.commentMaxLength).toBe(500);
  });

  it('非法分类与非法优先级在上报时被拒', async () => {
    await expect(
      service.report(1, { title: 'X', category: '瞎写', targetType: 'other' }),
    ).rejects.toThrow('报修分类');
    await expect(
      service.report(1, { title: 'Y', priority: 'super' as never, targetType: 'other' }),
    ).rejects.toThrow('优先级');
  });

  // ===== 时间线完整性（跨二期全部动作） =====

  it('二期动作全部进入同一时间线，且 fromStatus 与 toStatus 首尾相接', async () => {
    const wo = await service.report(1, { title: '综合流程', targetType: 'other' }, '张三');
    await service.dispatch(wo.id, 99, 1, '李运营');
    await service.addComment(wo.id, 99, '今天下午到现场', '张师傅');
    await service.updateEta(wo.id, 99, new Date(Date.now() + 2 * 3600_000).toISOString(), '张师傅');
    await service.startWork(wo.id, 99, '张师傅');
    await service.complete(wo.id, 99, { resolutionNote: '已更换损坏部件并测试通过' }, '张师傅');
    const accepted = await service.accept(wo.id, 1, { rating: 4 }, '张三');
    expect(accepted.status).toBe('accepted');

    const events = await service.listEvents(wo.id);
    expect(events.map((e) => e.type)).toEqual([
      'reported',
      'dispatched',
      'commented',
      'eta_updated',
      'started',
      'completed',
      'accepted',
    ]);
    expect(events[0].fromStatus).toBeNull();
    for (let i = 1; i < events.length; i++) {
      expect(events[i].fromStatus).toBe(events[i - 1].toStatus);
    }
  });
});
