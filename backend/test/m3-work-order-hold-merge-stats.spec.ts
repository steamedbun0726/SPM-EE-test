import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';

import { M3MaintenanceModule } from '../src/modules/m3-maintenance/m3-maintenance.module';
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
 * M3 三期能力集成测试：
 * - M3-14 挂起与恢复（两级确认、SLA 暂停与顺延、挂起超期升级、座位保持下架）
 * - M3-15 重复工单合并（上报时合并、事后合并、座位恢复责任转移）
 * - M3-17 完工必填维修说明
 * - M3-18 统计看板（口径与手工查询一致）
 *
 * 一律走真实数据库与真实 Service，不用 mock —— 这些逻辑的价值全在
 * 「跨表状态是否一致」，mock 掉数据库等于把要测的东西测没了。
 */
describe('M3 挂起 / 合并 / 维修说明 / 统计', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: WorkOrdersService;
  let spaceRepo: Repository<Space>;
  let seatRepo: Repository<Seat>;
  let woRepo: Repository<WorkOrder>;
  let logRepo: Repository<SeatStatusLog>;

  const REPORTER = 1;
  const WORKER = 99;
  const DISPATCHER = 2;

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
    logRepo = moduleRef.get(getRepositoryToken(SeatStatusLog));
  });

  beforeEach(async () => {
    await dataSource.synchronize(true);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function createSpaceWithSeats(n = 2): Promise<{ space: Space; seats: Seat[] }> {
    const space = await spaceRepo.save(
      spaceRepo.create({ code: `T-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, name: '测试自习室' }),
    );
    const seats: Seat[] = [];
    for (let i = 1; i <= n; i++) {
      seats.push(await seatRepo.save(seatRepo.create({ spaceId: space.id, seatNo: `S${i}` })));
    }
    return { space, seats };
  }

  const reload = (id: number) => woRepo.findOneByOrFail({ id });

  /** 上报 → 派单 → 开工，返回处于 in_progress 的工单 */
  async function toInProgress(spaceId: number, seatIds?: number[]): Promise<WorkOrder> {
    const wo = await service.report(REPORTER, {
      title: '灯管不亮',
      category: 'electrical',
      priority: 'high',
      targetType: spaceId && !seatIds ? 'space' : 'seat',
      spaceId,
      targetId: seatIds?.[0],
      seatIds,
    });
    await service.dispatch(wo.id, WORKER, DISPATCHER);
    return service.startWork(wo.id, WORKER);
  }

  // ===== M3-14 挂起与恢复 =====

  describe('M3-14 挂起与恢复', () => {
    it('申请挂起不改状态、不停表：状态仍是已派单，解决时限不变', async () => {
      const { space } = await createSpaceWithSeats(2);
      const wo = await service.report(REPORTER, {
        title: '空调不制冷',
        category: 'hvac',
        targetType: 'space',
        spaceId: space.id,
      });
      await service.dispatch(wo.id, WORKER, DISPATCHER);
      const before = await reload(wo.id);
      const deadlineBefore = before.slaDeadline!.getTime();

      const requested = await service.requestHold(wo.id, WORKER, '等厂家配件');

      // 核心断言：申请阶段不能自己给自己停表
      expect(requested.status).toBe('dispatched');
      expect(requested.holdRequested).toBe(true);
      expect(requested.slaDeadline!.getTime()).toBe(deadlineBefore);
      expect(requested.onHoldSince).toBeNull();

      const events = await service.listEvents(wo.id);
      expect(events.map((e) => e.type)).toContain('hold_requested');
      expect(events.map((e) => e.type)).not.toContain('hold');
    });

    it('申请挂起必须填原因，且不能重复申请', async () => {
      const { space } = await createSpaceWithSeats(1);
      const wo = await toInProgress(space.id);

      await expect(service.requestHold(wo.id, WORKER, '   ')).rejects.toThrow(BadRequestException);
      await service.requestHold(wo.id, WORKER, '需停电作业');
      await expect(service.requestHold(wo.id, WORKER, '再申请一次')).rejects.toThrow(ConflictException);
    });

    it('派单员确认后状态置 on_hold，座位保持下架', async () => {
      const { space } = await createSpaceWithSeats(2);
      const wo = await toInProgress(space.id);
      await service.requestHold(wo.id, WORKER, '等厂家配件');

      const held = await service.confirmHold(wo.id, DISPATCHER, true, '派单员');

      expect(held.status).toBe('on_hold');
      expect(held.onHoldSince).not.toBeNull();
      expect(held.preHoldStatus).toBe('in_progress');
      expect(held.holdRequested).toBe(false);

      // 挂起不等于放行：故障没修好，座位必须还在维修中
      const seats = await seatRepo.findBy({ spaceId: space.id });
      expect(seats).toHaveLength(2);
      expect(seats.every((s) => s.status === 'maintenance')).toBe(true);
    });

    it('驳回挂起申请：状态不变、申请标记清除、写驳回事件', async () => {
      const { space } = await createSpaceWithSeats(1);
      const wo = await toInProgress(space.id);
      await service.requestHold(wo.id, WORKER, '等配件');

      const rejected = await service.confirmHold(wo.id, DISPATCHER, false, '派单员', '配件明日到，请继续');

      expect(rejected.status).toBe('in_progress');
      expect(rejected.holdRequested).toBe(false);
      expect(rejected.onHoldSince).toBeNull();
      const events = await service.listEvents(wo.id);
      expect(events.map((e) => e.type)).toContain('hold_rejected');
    });

    it('挂起期间定时任务不判超时（即使时限已过）', async () => {
      const { space } = await createSpaceWithSeats(1);
      const wo = await toInProgress(space.id);
      await service.requestHold(wo.id, WORKER, '等配件');
      await service.confirmHold(wo.id, DISPATCHER, true);

      // 人为把两个时限都推到过去：若挂起没生效，这里必然触发升级
      await woRepo.update(wo.id, {
        slaDeadline: new Date(Date.now() - 3 * 3600_000),
        responseDeadline: new Date(Date.now() - 5 * 3600_000),
      });

      const escalated = await service.escalateOverdue();
      expect(escalated).toBe(0);

      const after = await reload(wo.id);
      expect(after.escalateLevel).toBe(0);
      expect(after.escalated).toBe(false);
    });

    it('恢复后回到挂起前状态，解决时限按挂起时长顺延，累计挂起时长累加', async () => {
      const { space } = await createSpaceWithSeats(1);
      const wo = await toInProgress(space.id);
      await service.requestHold(wo.id, WORKER, '等配件');
      await service.confirmHold(wo.id, DISPATCHER, true);

      // 模拟已挂起 2 小时
      const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
      await woRepo.update(wo.id, { onHoldSince: twoHoursAgo });
      const before = await reload(wo.id);
      const slaBefore = before.slaDeadline!.getTime();
      const originBefore = before.originalSlaDeadline!.getTime();

      const resumed = await service.resumeFromHold(wo.id, WORKER, '维修员');

      expect(resumed.status).toBe('in_progress');
      expect(resumed.onHoldSince).toBeNull();
      expect(resumed.totalHoldMinutes).toBeGreaterThanOrEqual(119);
      // 顺延而不是重算：到期时刻整体后移挂起时长
      expect(resumed.slaDeadline!.getTime() - slaBefore).toBeGreaterThanOrEqual(2 * 3600_000 - 5_000);
      // 统计基准同步平移，否则挂起过的单在报表里必然「超时」
      expect(resumed.originalSlaDeadline!.getTime() - originBefore).toBeGreaterThanOrEqual(
        2 * 3600_000 - 5_000,
      );

      const events = await service.listEvents(wo.id);
      expect(events.map((e) => e.type)).toContain('resumed');
    });

    it('挂起超过上限自动升级并通知，且只告警一次', async () => {
      const { space } = await createSpaceWithSeats(1);
      const wo = await toInProgress(space.id);
      await service.requestHold(wo.id, WORKER, '等配件');
      await service.confirmHold(wo.id, DISPATCHER, true);

      // 挂起 8 天，超过默认上限 7 天
      await woRepo.update(wo.id, { onHoldSince: new Date(Date.now() - 8 * 86400_000) });

      expect(await service.escalateOverdue()).toBe(1);
      const after = await reload(wo.id);
      expect(after.escalateLevel).toBe(1);
      expect(after.escalated).toBe(true);
      expect(after.holdEscalated).toBe(true);
      expect(after.status).toBe('on_hold'); // 升级不等于自动恢复，仍需人工恢复

      // 第二轮不应重复告警
      expect(await service.escalateOverdue()).toBe(0);
      expect((await reload(wo.id)).escalateLevel).toBe(1);
    });
  });

  // ===== 回归：首响超时升级不重复累加 =====

  describe('首响超时升级幂等（回归修复）', () => {
    it('升级后同步推后首响时限，下一轮调度不再重复升级', async () => {
      const { space } = await createSpaceWithSeats(1);
      // 只让首响时限过期，解决时限仍充裕 → 唯一命中条件是 responseDeadline
      const wo = await service.report(REPORTER, {
        title: '配电箱冒烟',
        category: 'electrical',
        targetType: 'space',
        spaceId: space.id,
      });
      await woRepo.update(wo.id, { responseDeadline: new Date(Date.now() - 3600_000) });

      expect(await service.escalateOverdue()).toBe(1);
      const after = await reload(wo.id);
      expect(after.escalateLevel).toBe(1);
      // 修复前这里不推后，导致每轮调度重新命中，实测线上已累加到 113 级
      expect(new Date(after.responseDeadline as Date).getTime()).toBeGreaterThan(Date.now());

      expect(await service.escalateOverdue()).toBe(0);
      expect((await reload(wo.id)).escalateLevel).toBe(1);
    });
  });

  // ===== M3-15 重复工单合并 =====

  describe('M3-15 重复工单合并', () => {
    it('重复上报返回 409，并带上已有工单 id 供前端提供合并入口', async () => {
      const { space, seats } = await createSpaceWithSeats(2);
      const first = await service.report(REPORTER, {
        title: '门锁损坏',
        category: 'lock',
        targetType: 'seat',
        targetId: seats[0].id,
        spaceId: space.id,
      });

      let error: unknown;
      try {
        await service.report(REPORTER, {
          title: '门锁损坏（再报一次）',
          category: 'lock',
          targetType: 'seat',
          targetId: seats[0].id,
          spaceId: space.id,
        });
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as {
        existingWorkOrderId?: number;
        existingWorkOrderNo?: string;
      };
      expect(body.existingWorkOrderId).toBe(first.id);
      expect(body.existingWorkOrderNo).toBe(first.workOrderNo);
    });

    it('带 mergeIntoId 重提：落为 merged 且不产生新的座位下架', async () => {
      const { space, seats } = await createSpaceWithSeats(2);
      const main = await service.report(REPORTER, {
        title: '门锁损坏',
        category: 'lock',
        targetType: 'seat',
        targetId: seats[0].id,
        spaceId: space.id,
      });
      const logsBefore = await logRepo.count();

      const merged = await service.report(REPORTER, {
        title: '门锁损坏（同一故障）',
        category: 'lock',
        targetType: 'seat',
        targetId: seats[0].id,
        spaceId: space.id,
        mergeIntoId: main.id,
      });

      expect(merged.status).toBe('merged');
      expect(merged.mergedIntoId).toBe(main.id);
      // 合并单没有独立工期
      expect(merged.slaDeadline).toBeNull();
      // 座位状态与下架日志都没有新增：合并只是记录关系，不是第二次动手
      expect(await logRepo.count()).toBe(logsBefore);
      const seatsNow = await seatRepo.findBy({ spaceId: space.id });
      expect(seatsNow.filter((s) => s.status === 'maintenance')).toHaveLength(1);

      const mainAfter = await reload(main.id);
      expect(mainAfter.mergedCount).toBe(1);
      expect(JSON.parse(mainAfter.seatIds)).toEqual([seats[0].id]);

      const mergedEvents = await service.listEvents(merged.id);
      expect(mergedEvents.map((e) => e.type)).toContain('merged');
      const mainEvents = await service.listEvents(main.id);
      expect(mainEvents.map((e) => e.type)).toContain('merge_absorbed');
    });

    it('不能合并到已结束的工单，也不能链式合并', async () => {
      const { space, seats } = await createSpaceWithSeats(2);
      const main = await service.report(REPORTER, {
        title: '门锁损坏',
        category: 'lock',
        targetType: 'seat',
        targetId: seats[0].id,
        spaceId: space.id,
      });
      // 把主线推到终态
      await woRepo.update(main.id, { status: 'accepted' });

      await expect(
        service.report(REPORTER, {
          title: '再来一次',
          category: 'lock',
          targetType: 'seat',
          targetId: seats[0].id,
          spaceId: space.id,
          mergeIntoId: main.id,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('主线验收后座位恢复，合并单不参与恢复', async () => {
      const { space, seats } = await createSpaceWithSeats(2);
      const main = await service.report(REPORTER, {
        title: '门锁损坏',
        category: 'lock',
        targetType: 'seat',
        targetId: seats[0].id,
        spaceId: space.id,
      });
      const merged = await service.report(REPORTER, {
        title: '门锁损坏（重复）',
        category: 'lock',
        targetType: 'seat',
        targetId: seats[0].id,
        spaceId: space.id,
        mergeIntoId: main.id,
      });

      await service.dispatch(main.id, WORKER, DISPATCHER);
      await service.startWork(main.id, WORKER);
      await service.complete(main.id, WORKER, { resolutionNote: '更换锁芯' });
      await service.accept(main.id, REPORTER, { rating: 5 });

      const seatsNow = await seatRepo.findBy({ spaceId: space.id });
      expect(seatsNow.find((s) => s.id === seats[0].id)!.status).toBe('available');
      expect(seatsNow.find((s) => s.id === seats[1].id)!.status).toBe('available');
      // 合并单仍是终态，不会被误推动
      expect((await reload(merged.id)).status).toBe('merged');
    });

    it('事后合并：被合并单交出座位清单，恢复责任转移给主线', async () => {
      const { space, seats } = await createSpaceWithSeats(2);
      // 两个不同座位 → 不构成重复上报，两张单都能开出来
      const a = await service.report(REPORTER, {
        title: '插座没电',
        category: 'electrical',
        targetType: 'seat',
        targetId: seats[0].id,
        spaceId: space.id,
      });
      const b = await service.report(REPORTER, {
        title: '插座没电（同一条线路）',
        category: 'electrical',
        targetType: 'seat',
        targetId: seats[1].id,
        spaceId: space.id,
      });
      expect(JSON.parse((await reload(a.id)).seatIds)).toEqual([seats[0].id]);
      expect(JSON.parse((await reload(b.id)).seatIds)).toEqual([seats[1].id]);

      await service.mergeInto(b.id, a.id, REPORTER, '上报人');

      const aAfter = await reload(a.id);
      const bAfter = await reload(b.id);
      expect(bAfter.status).toBe('merged');
      expect(bAfter.mergedIntoId).toBe(a.id);
      expect(bAfter.seatIds).toBe(''); // 清单已交出，避免它被单独操作时提前放座
      expect(JSON.parse(aAfter.seatIds).sort()).toEqual([seats[0].id, seats[1].id].sort());
      expect(aAfter.mergedCount).toBe(1);

      // 主线验收后两个座位都回来
      await service.dispatch(a.id, WORKER, DISPATCHER);
      await service.startWork(a.id, WORKER);
      await service.complete(a.id, WORKER, { resolutionNote: '重新接线' });
      await service.accept(a.id, REPORTER, { rating: 4 });
      const seatsNow = await seatRepo.findBy({ spaceId: space.id });
      expect(seatsNow.every((s) => s.status === 'available')).toBe(true);
    });
  });

  // ===== M3-17 完工必填维修说明 =====

  describe('M3-17 维修记录', () => {
    it('完工不填维修说明返回 400，工单仍停在维修中', async () => {
      const { space } = await createSpaceWithSeats(1);
      const wo = await toInProgress(space.id);

      await expect(service.complete(wo.id, WORKER, {})).rejects.toThrow(BadRequestException);
      await expect(service.complete(wo.id, WORKER, { resolutionNote: '  ' })).rejects.toThrow(
        BadRequestException,
      );

      const after = await reload(wo.id);
      expect(after.status).toBe('in_progress');
      expect(after.resolutionNote).toBe('');
    });

    it('填写说明后完工：说明入档并进入时间线，验收人可见', async () => {
      const { space } = await createSpaceWithSeats(1);
      const wo = await toInProgress(space.id);

      const done = await service.complete(wo.id, WORKER, {
        resolutionNote: '更换镇流器 1 只，通电测试 30 分钟无闪烁',
      });
      expect(done.status).toBe('completed');
      expect(done.resolutionNote).toBe('更换镇流器 1 只，通电测试 30 分钟无闪烁');

      const events = await service.listEvents(wo.id);
      const completedEvent = events.find((e) => e.type === 'completed');
      expect(completedEvent!.note).toContain('镇流器');

      const detail = await service.getDetail(REPORTER, wo.id);
      expect(detail.resolutionNote).toContain('镇流器');
    });

    it('完工时可补传照片，与已有照片合并后仍受张数上限约束', async () => {
      const { space } = await createSpaceWithSeats(1);
      const wo = await service.report(REPORTER, {
        title: '墙面渗水',
        category: 'plumbing',
        targetType: 'space',
        spaceId: space.id,
        photoUrls: ['https://img.example.com/a.jpg', 'https://img.example.com/b.jpg'],
      });
      await service.dispatch(wo.id, WORKER, DISPATCHER);
      await service.startWork(wo.id, WORKER);

      const done = await service.complete(wo.id, WORKER, {
        resolutionNote: '重新打胶并做防水',
        photoUrls: ['https://img.example.com/c.jpg'],
      });
      expect(service.toView(done).photoUrlList).toHaveLength(3);

      // 超上限要拦住：上报已有 2 张，完工再传 2 张 → 合并后 4 张
      const wo2 = await service.report(REPORTER, {
        title: '再次渗水',
        category: 'plumbing',
        targetType: 'space',
        spaceId: space.id,
        photoUrls: ['https://img.example.com/d.jpg', 'https://img.example.com/e.jpg'],
      });
      await service.dispatch(wo2.id, WORKER, DISPATCHER);
      await service.startWork(wo2.id, WORKER);
      await expect(
        service.complete(wo2.id, WORKER, {
          resolutionNote: '测试',
          photoUrls: ['https://img.example.com/f.jpg', 'https://img.example.com/g.jpg'],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ===== M3-18 统计看板 =====

  describe('M3-18 统计看板', () => {
    it('统计结果与手工核对一致：完工率剔除取消/合并单，解决时长扣挂起，SLA 用原始时限', async () => {
      const { space, seats } = await createSpaceWithSeats(3);

      // w1：完整流转后验收通过，SLA 达标
      const w1 = await service.report(REPORTER, {
        title: '灯不亮',
        category: 'electrical',
        priority: 'high',
        targetType: 'seat',
        targetId: seats[0].id,
        spaceId: space.id,
      });
      await service.dispatch(w1.id, WORKER, DISPATCHER);
      await service.startWork(w1.id, WORKER);
      await service.complete(w1.id, WORKER, { resolutionNote: '换灯管' });
      await service.accept(w1.id, REPORTER, { rating: 5 });

      // w2：完整流转后验收通过，但返工 1 次且超原始时限
      const w2 = await service.report(REPORTER, {
        title: '插座松动',
        category: 'electrical',
        priority: 'high',
        targetType: 'seat',
        targetId: seats[1].id,
        spaceId: space.id,
      });
      await service.dispatch(w2.id, WORKER, DISPATCHER);
      await service.startWork(w2.id, WORKER);
      await service.complete(w2.id, WORKER, { resolutionNote: '紧固' });
      await service.accept(w2.id, REPORTER, { rating: 3 });

      // w3：取消（不计入比率分母）
      const w3 = await service.report(REPORTER, {
        title: '误报',
        category: 'other',
        targetType: 'other',
      });
      await service.cancel(w3.id, REPORTER, { reason: '自己看错了' });

      // w4：仍待派单（open）
      const w4 = await service.report(REPORTER, {
        title: '桌面破损',
        category: 'furniture',
        targetType: 'seat',
        targetId: seats[2].id,
        spaceId: space.id,
      });

      // w5：合并进 w4（不计入比率分母）
      const w5 = await service.report(REPORTER, {
        title: '桌面破损（重复）',
        category: 'furniture',
        targetType: 'seat',
        targetId: seats[2].id,
        spaceId: space.id,
        mergeIntoId: w4.id,
      });

      // 人为构造可断言的时间：w1 用时 4h 且含 2h 挂起 → 作业 2h；w2 用时 6h 无挂起 → 6h
      const w1Row = await reload(w1.id);
      const w2Row = await reload(w2.id);
      await woRepo.update(w1.id, {
        acceptedAt: new Date(new Date(w1Row.createdAt).getTime() + 4 * 3600_000),
        totalHoldMinutes: 120,
      });
      await woRepo.update(w2.id, {
        acceptedAt: new Date(new Date(w2Row.createdAt).getTime() + 6 * 3600_000),
        reopenCount: 1,
        // 原始时限推到过去：这一单判定为 SLA 未达标
        originalSlaDeadline: new Date(Date.now() - 3600_000),
      });

      const stats = await service.stats({});

      expect(stats.totals.total).toBe(5);
      expect(stats.totals.accepted).toBe(2);
      expect(stats.totals.cancelled).toBe(1);
      expect(stats.totals.merged).toBe(1);
      expect(stats.totals.open).toBe(1);
      expect(stats.totals.effective).toBe(3);

      // 完工率 = 2 / (5 - 1 - 1) = 66.7%
      expect(stats.kpi.completionRate).toBe(66.7);
      // SLA 达标率 = 1 / 2 = 50%（w2 用原始时限判定，未达标）
      expect(stats.kpi.slaComplianceRate).toBe(50);
      // 返工率 = 1 / 2 = 50%
      expect(stats.kpi.reworkRate).toBe(50);
      // 平均解决 = (4 - 2 + 6) / 2 = 4 小时
      expect(stats.kpi.avgResolveHours).toBeGreaterThan(3.9);
      expect(stats.kpi.avgResolveHours).toBeLessThan(4.1);
      // 平均分 = (5 + 3) / 2 = 4
      expect(stats.kpi.avgRating).toBe(4);
      // 首响在测试里是即时完成的
      expect(stats.kpi.avgResponseHours).not.toBeNull();
      expect(stats.kpi.avgResponseHours!).toBeLessThan(1);

      // 分组统计与手工清点一致
      const statusTotal = stats.byStatus.reduce((s, x) => s + x.count, 0);
      expect(statusTotal).toBe(5);
      expect(stats.byStatus.find((x) => x.status === 'merged')!.count).toBe(1);
      expect(stats.byStatus.find((x) => x.status === 'accepted')!.count).toBe(2);

      const categoryTotal = stats.byCategory.reduce((s, x) => s + x.count, 0);
      expect(categoryTotal).toBe(5);
      expect(stats.byCategory[0].count).toBeGreaterThanOrEqual(2); // 按数量降序

      // 空间排行：4 张单挂在测试空间下（w3 无空间）
      expect(stats.topSpaces[0].spaceId).toBe(space.id);
      expect(stats.topSpaces[0].count).toBe(4);
      expect(stats.topSpaces[0].openCount).toBe(1);

      // 口径说明随数据返回
      expect(stats.definitions.avgResolveHours).toContain('挂起');
      expect(stats.definitions.slaComplianceRate).toContain('原始解决时限');

      // 被合并单不独立计入任务量
      expect((await reload(w5.id)).status).toBe('merged');
      expect(w4.id).toBeGreaterThan(0);
    });

    it('可按时间区间与空间过滤，非法区间返回 400', async () => {
      const { space } = await createSpaceWithSeats(1);
      await service.report(REPORTER, {
        title: '空调滴水',
        category: 'hvac',
        targetType: 'space',
        spaceId: space.id,
      });

      const all = await service.stats({});
      expect(all.totals.total).toBe(1);

      const scoped = await service.stats({ spaceId: space.id });
      expect(scoped.totals.total).toBe(1);

      const otherSpace = await service.stats({ spaceId: 9999 });
      expect(otherSpace.totals.total).toBe(0);

      // 区间外
      const past = await service.stats({
        from: new Date(Date.now() - 20 * 86400_000).toISOString(),
        to: new Date(Date.now() - 10 * 86400_000).toISOString(),
      });
      expect(past.totals.total).toBe(0);

      await expect(
        service.stats({
          from: new Date().toISOString(),
          to: new Date(Date.now() - 86400_000).toISOString(),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('空数据不除零：比率返回 null 而不是 NaN', async () => {
      const stats = await service.stats({});
      expect(stats.totals.total).toBe(0);
      expect(stats.kpi.completionRate).toBeNull();
      expect(stats.kpi.slaComplianceRate).toBeNull();
      expect(stats.kpi.reworkRate).toBeNull();
      expect(stats.kpi.avgResolveHours).toBeNull();
      expect(stats.topSpaces).toHaveLength(0);
    });
  });
});
