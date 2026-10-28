import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
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
 * M3-16 列表筛选、分页与搜索。
 *
 * 断言方式刻意与实现解耦：期望条数一律用服务层之外的另一条查询路径
 * （直接 `woRepo.count` / `find`）算出来再比对。筛选项自己跟自己对答案，
 * 就算把过滤条件写反也照样是绿的。
 */
describe('M3-16 工单列表筛选、分页与搜索', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let service: WorkOrdersService;
  let spaceRepo: Repository<Space>;
  let seatRepo: Repository<Seat>;
  let woRepo: Repository<WorkOrder>;

  const REPORTER = 1;
  const OTHER_REPORTER = 7;
  const WORKER = 99;
  const OTHER_WORKER = 98;
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
  });

  beforeEach(async () => {
    await dataSource.synchronize(true);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  async function createSpaceWithSeats(n = 1): Promise<{ space: Space; seats: Seat[] }> {
    const space = await spaceRepo.save(
      spaceRepo.create({
        code: `T-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        name: '测试自习室',
      }),
    );
    const seats: Seat[] = [];
    for (let i = 1; i <= n; i++) {
      seats.push(await seatRepo.save(seatRepo.create({ spaceId: space.id, seatNo: `S${i}` })));
    }
    return { space, seats };
  }

  /** 三个特征分明的工单：分类/优先级/空间/处理人/上报人各不相同，便于组合筛选 */
  async function seedLedger() {
    const { space: spaceA, seats: seatsA } = await createSpaceWithSeats(2);
    const { space: spaceB } = await createSpaceWithSeats(1);

    // 1. 已上报，电气/高优先级，A 空间某个座位，暂无处理人
    //    注：同一空间放两张工单必须落到不同座位，否则会被防重复上报规则拦住
    const w1 = await service.report(REPORTER, {
      title: '灯管不亮',
      description: '第一行灯管持续闪烁',
      category: 'electrical',
      priority: 'high',
      targetType: 'seat',
      targetId: seatsA[0].id,
      seatIds: [seatsA[0].id],
      spaceId: spaceA.id,
    });
    // 2. 派给 WORKER，水暖/普通，B 空间
    const w2 = await service.report(REPORTER, {
      title: '空调不制冷',
      description: 'B栋 空调压缩机异响',
      category: 'hvac',
      priority: 'medium',
      targetType: 'space',
      spaceId: spaceB.id,
    });
    await service.dispatch(w2.id, WORKER, DISPATCHER);
    // 3. 派给 OTHER_WORKER，网络/紧急，A 空间另一个座位，另一个上报人
    const w3 = await service.report(OTHER_REPORTER, {
      title: '网络不通',
      description: '座位 S2 网口松动',
      category: 'network',
      priority: 'urgent',
      targetType: 'seat',
      targetId: seatsA[1].id,
      seatIds: [seatsA[1].id],
      spaceId: spaceA.id,
    });
    await service.dispatch(w3.id, OTHER_WORKER, DISPATCHER);

    return { spaceA, spaceB, w1, w2, w3 };
  }

  describe('无条件查询与默认分页', () => {
    it('返回全部工单，且 total 与库内实际条数一致', async () => {
      await seedLedger();
      const all = await woRepo.count();

      const res = await service.listAll();

      expect(res.total).toBe(all);
      expect(res.items).toHaveLength(all);
      expect(res.page).toBe(1);
      expect(res.pageSize).toBe(20);
    });

    it('返回体带展示标签与解析后的字段，前端无需再维护字典', async () => {
      await seedLedger();
      const res = await service.listAll({ pageSize: 1 });
      const first = res.items[0];

      expect(first.categoryLabel).toBeTruthy();
      expect(first.priorityLabel).toBeTruthy();
      expect(first.statusLabel).toBeTruthy();
      expect(Array.isArray(first.seatIdList)).toBe(true);
    });
  });

  describe('单条件筛选', () => {
    it('按单个状态筛选：条数与直接查库一致', async () => {
      const { w2, w3 } = await seedLedger();
      expect((await woRepo.countBy({ status: 'dispatched' }))).toBe(2);

      const res = await service.listAll({ status: 'dispatched' });

      expect(res.total).toBe(2);
      expect(res.items.map((i) => i.id).sort()).toEqual([w2.id, w3.id].sort());
    });

    it('状态支持逗号分隔的多值查询', async () => {
      await seedLedger();
      const expected = await woRepo.count();

      const res = await service.listAll({ status: 'reported,dispatched' });

      expect(res.total).toBe(expected);
    });

    it('按空间筛选：只返回该空间的工单', async () => {
      const { spaceA, w1, w3 } = await seedLedger();

      const res = await service.listAll({ spaceId: spaceA.id });

      expect(res.total).toBe(2);
      expect(res.items.map((i) => i.id).sort()).toEqual([w1.id, w3.id].sort());
    });

    it('按维修员与上报人筛选', async () => {
      const { w2 } = await seedLedger();

      const byAssignee = await service.listAll({ assigneeId: WORKER });
      expect(byAssignee.total).toBe(1);
      expect(byAssignee.items[0].id).toBe(w2.id);

      const byReporter = await service.listAll({ reporterId: OTHER_REPORTER });
      expect(byReporter.total).toBe(1);
      expect(byReporter.items[0].title).toBe('网络不通');
    });

    it('按升级标记筛选：未升级时 escalated=true 应为空', async () => {
      await seedLedger();

      expect((await service.listAll({ escalated: true })).total).toBe(0);
      expect((await service.listAll({ escalated: false })).total).toBe(await woRepo.count());
    });
  });

  describe('组合筛选', () => {
    it('空间 + 分类 + 优先级三个条件叠加，结果仍是各条件的交集', async () => {
      const { spaceA, w3 } = await seedLedger();
      const expected = await woRepo.count({ where: { spaceId: spaceA.id, category: 'network', priority: 'urgent' } });

      const res = await service.listAll({
        spaceId: spaceA.id,
        category: 'network',
        priority: 'urgent',
      });

      expect(res.total).toBe(expected);
      expect(expected).toBe(1);
      expect(res.items[0].id).toBe(w3.id);
    });

    it('多个条件互相排斥时返回空列表而不是报错', async () => {
      const { spaceB } = await seedLedger();

      const res = await service.listAll({ spaceId: spaceB.id, category: 'network' });

      expect(res.total).toBe(0);
      expect(res.items).toEqual([]);
    });
  });

  describe('关键字搜索', () => {
    it('工单号、标题、描述都能被命中', async () => {
      const { w1, w2, w3 } = await seedLedger();
      const no1 = (await woRepo.findOneByOrFail({ id: w1.id })).workOrderNo;

      const byNo = await service.listAll({ keyword: no1 });
      expect(byNo.total).toBe(1);
      expect(byNo.items[0].id).toBe(w1.id);

      expect((await service.listAll({ keyword: '空调' })).total).toBe(1);
      expect((await service.listAll({ keyword: '空调' })).items[0].id).toBe(w2.id);
      // 「网口」只在 w3 的描述里，标题没有
      expect((await service.listAll({ keyword: '网口' })).total).toBe(1);
      expect((await service.listAll({ keyword: '网口' })).items[0].id).toBe(w3.id);
    });

    it('LIKE 通配符被转义：搜 % 不该返回全部数据', async () => {
      await seedLedger();
      const all = await woRepo.count();

      const res = await service.listAll({ keyword: '%' });

      // 不转义时 '%' 会退化成「匹配任意串」，返回全量；这是排查问题时的错误结论
      expect(all).toBeGreaterThan(0);
      expect(res.total).toBe(0);
    });

    it('下划线同样被转义', async () => {
      await seedLedger();

      const res = await service.listAll({ keyword: '_' });

      expect(res.total).toBe(0);
    });

    it('关键字两侧空格被修剪后仍能命中', async () => {
      await seedLedger();

      expect((await service.listAll({ keyword: '  空调  ' })).total).toBe(1);
    });
  });

  describe('时间区间', () => {
    it('起止同一天能查到当天数据（闭区间语义）', async () => {
      const { w1 } = await seedLedger();
      const entity = await woRepo.findOneByOrFail({ id: w1.id });
      const day = new Date(entity.createdAt);
      const ymd = `${day.getUTCFullYear()}-${String(day.getUTCMonth() + 1).padStart(2, '0')}-${String(
        day.getUTCDate(),
      ).padStart(2, '0')}`;

      const res = await service.listAll({ from: ymd, to: ymd });

      expect(res.total).toBeGreaterThanOrEqual(1);
      expect(res.items.map((i) => i.id)).toContain(w1.id);
    });

    it('查询未来的时间区间返回空列表', async () => {
      await seedLedger();

      const res = await service.listAll({ from: '2099-01-01', to: '2099-01-02' });

      expect(res.total).toBe(0);
    });

    it('起始时间晚于结束时间返回 400', async () => {
      await seedLedger();

      await expect(service.listAll({ from: '2026-10-02', to: '2026-10-01' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('时间格式非法返回 400 而不是被忽略成不过滤', async () => {
      await seedLedger();

      await expect(service.listAll({ from: '不是日期' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('分页', () => {
    it('pageSize 生效，且两页之和等于总数', async () => {
      await seedLedger();
      const total = (await service.listAll()).total;

      const p1 = await service.listAll({ page: 1, pageSize: 2 });
      const p2 = await service.listAll({ page: 2, pageSize: 2 });

      expect(p1.items).toHaveLength(2);
      expect(p1.total).toBe(total);
      expect(p1.page).toBe(1);
      expect(p1.pageSize).toBe(2);
      expect(p2.items).toHaveLength(total - 2);
      expect(p2.page).toBe(2);
      const ids1 = p1.items.map((i) => i.id);
      const ids2 = p2.items.map((i) => i.id);
      expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    });

    it('页码越界返回空列表而不是 500', async () => {
      await seedLedger();

      const res = await service.listAll({ page: 999, pageSize: 10 });

      expect(res.items).toEqual([]);
      expect(res.total).toBeGreaterThan(0);
      expect(res.page).toBe(999);
    });

    it('单页条数超过上限时被钳到 100', async () => {
      await seedLedger();

      const res = await service.listAll({ pageSize: 9999 });

      expect(res.pageSize).toBe(100);
    });

    it('非法的 page / pageSize 按默认值处理，不报错', async () => {
      await seedLedger();

      const zeroPage = await service.listAll({ page: 0 });
      expect(zeroPage.page).toBe(1);

      const zeroSize = await service.listAll({ pageSize: 0 });
      expect(zeroSize.pageSize).toBe(20);

      const negSize = await service.listAll({ pageSize: -5 });
      expect(negSize.pageSize).toBe(20);
    });
  });

  describe('排序', () => {
    it('默认按创建时间倒序，createdAsc 与之完全相反', async () => {
      const { w1, w2, w3 } = await seedLedger();

      const desc = await service.listAll();
      const asc = await service.listAll({ sort: 'createdAsc' });

      expect(desc.items.map((i) => i.id)).toEqual([w3.id, w2.id, w1.id]);
      expect(asc.items.map((i) => i.id)).toEqual([w1.id, w2.id, w3.id]);
    });

    it('按解决时限升序时，无时限的工单排在最后', async () => {
      const { w1 } = await seedLedger();
      // 模拟已合并单（不承担独立工期）：时限为空
      await woRepo.update(w1.id, { slaDeadline: null });

      const res = await service.listAll({ sort: 'slaAsc' });

      expect(res.total).toBe(3);
      expect(res.items[res.items.length - 1].id).toBe(w1.id);
    });

    it('按优先级排序时紧急工单排在最前', async () => {
      const { w3 } = await seedLedger();

      const res = await service.listAll({ sort: 'priority' });

      expect(res.items[0].id).toBe(w3.id); // urgent
    });
  });

  describe('非法筛选值', () => {
    it('未知状态、分类、优先级一律 400，而不是被静默忽略成全量', async () => {
      await seedLedger();

      await expect(service.listAll({ status: 'not_a_status' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.listAll({ category: 'not_a_category' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.listAll({ priority: 'not_a_priority' as unknown as 'low' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('非法筛选值不会把数据写坏', async () => {
      const { spaceA } = await seedLedger();

      await expect(service.listAll({ category: 'BOGUS' })).rejects.toThrow(BadRequestException);

      const after = await service.listAll({ spaceId: spaceA.id });
      expect(after.total).toBe(2);
    });
  });
});
