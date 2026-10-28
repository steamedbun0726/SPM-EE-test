import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';

import { SharedModule } from '../src/shared/shared.module';
import { UsersService } from '../src/shared/rbac/users.service';
import { RolesService } from '../src/shared/rbac/roles.service';
import { UsersController, RolesController } from '../src/shared/rbac/rbac.controller';
import { InitSchema1780000000000 } from '../src/database/migrations/1780000000000-init-schema';

import { User } from '../src/database/entities/user.entity';
import { Role } from '../src/database/entities/role.entity';
import { Permission } from '../src/database/entities/permission.entity';
import { Space } from '../src/database/entities/space.entity';
import { Seat } from '../src/database/entities/seat.entity';
import { SeatStatusLog } from '../src/database/entities/seat-status-log.entity';
import { Reservation } from '../src/database/entities/reservation.entity';
import { Notification } from '../src/database/entities/notification.entity';
import { AuditLog } from '../src/database/entities/audit-log.entity';
import { SystemConfig } from '../src/database/entities/system-config.entity';
import { Violation } from '../src/database/entities/violation.entity';
import { RoomBookingRequest } from '../src/database/entities/room-booking-request.entity';

/**
 * D1 身份与权限回归测试。
 *
 * 覆盖两处曾被遗漏、且都在真实使用中立刻暴露的缺陷：
 * 1. `UsersController` / `RolesController` 只被定义、从未注册进任何模块，
 *    导致 `/api/users`、`/api/roles` 全部 404，前端「用户管理」「角色与权限」不可用；
 * 2. `decorate()` 直接展开实体，把 `passwordHash` 原样返回给客户端。
 */
describe('D1 用户与角色', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let usersService: UsersService;
  let rolesService: RolesService;
  let userRepo: Repository<User>;
  let roleRepo: Repository<Role>;
  let permRepo: Repository<Permission>;

  const PASSWORD = 'secret123';

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
            RoomBookingRequest,
            Notification,
            AuditLog,
            SystemConfig,
          ],
          migrations: [InitSchema1780000000000],
        }),
        SharedModule,
      ],
    }).compile();

    dataSource = moduleRef.get(DataSource);
    usersService = moduleRef.get(UsersService);
    rolesService = moduleRef.get(RolesService);
    userRepo = moduleRef.get(getRepositoryToken(User));
    roleRepo = moduleRef.get(getRepositoryToken(Role));
    permRepo = moduleRef.get(getRepositoryToken(Permission));
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  beforeEach(async () => {
    await dataSource.synchronize(true);

    const perm = await permRepo.save(
      permRepo.create({ code: 'workorder.handle', name: '工单处理', description: '接单与完工' }),
    );
    const role = await roleRepo.save(
      roleRepo.create({ code: 'maintenance', name: '物业维修员', description: '处理工单', permissions: [perm] }),
    );
    await userRepo.save(
      userRepo.create({
        username: 'zhang',
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        name: '张师傅',
        department: '后勤保障部',
        roles: [role],
      }),
    );
  });

  it('模块装配：UsersController / RolesController 已被注册（此前未注册会导致 /api/users 404）', () => {
    // 若控制器未出现在任何模块的 controllers 中，Nest 容器里就取不到
    expect(moduleRef.get(UsersController, { strict: false })).toBeInstanceOf(UsersController);
    expect(moduleRef.get(RolesController, { strict: false })).toBeInstanceOf(RolesController);
  });

  it('用户列表不返回密码哈希，但保留角色与权限码', async () => {
    const { items, total } = await usersService.findAll({ page: 1, pageSize: 10 });

    expect(total).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('passwordHash');
    expect(items[0].roleCodes).toEqual(['maintenance']);
    expect(items[0].permissionCodes).toEqual(['workorder.handle']);
  });

  it('用户详情不返回密码哈希', async () => {
    const list = await usersService.findAll({ page: 1, pageSize: 10 });
    const detail = await usersService.findById(list.items[0].id);

    expect(detail).not.toHaveProperty('passwordHash');
    expect(detail.name).toBe('张师傅');
  });

  it('按权限码反查得到的用户同样不含密码哈希（M3 派单使用该接口）', async () => {
    const techs = await usersService.findByPermission('workorder.handle');

    expect(techs).toHaveLength(1);
    expect(techs[0].username).toBe('zhang');
    expect(techs[0]).not.toHaveProperty('passwordHash');
  });

  it('认证入口仍需拿到密码哈希，否则登录无法校验', async () => {
    const user = await usersService.findByUsername('zhang');

    expect(user).not.toBeNull();
    expect(user!.passwordHash).toBeTruthy();
    await expect(usersService.verifyPassword(user!, PASSWORD)).resolves.toBe(true);
    await expect(usersService.verifyPassword(user!, 'wrong-pass')).resolves.toBe(false);
  });

  it('创建用户返回的对象不含密码哈希，且密码已加密入库', async () => {
    const created = await usersService.create({
      username: 'newbie',
      password: PASSWORD,
      name: '新人',
      roleCodes: [],
    });

    expect(created).not.toHaveProperty('passwordHash');
    const row = await userRepo.findOneBy({ username: 'newbie' });
    expect(row!.passwordHash).not.toBe(PASSWORD);
    expect(await bcrypt.compare(PASSWORD, row!.passwordHash)).toBe(true);
  });

  it('角色列表可读，且带出所挂权限', async () => {
    const roles = await rolesService.findAll();

    expect(roles).toHaveLength(1);
    expect(roles[0].code).toBe('maintenance');
    expect(roles[0].permissions.map((p) => p.code)).toEqual(['workorder.handle']);
  });
});
