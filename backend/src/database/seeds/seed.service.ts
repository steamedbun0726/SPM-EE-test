import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { Permission } from '../entities/permission.entity';
import { Role } from '../entities/role.entity';
import { User } from '../entities/user.entity';
import { Space } from '../entities/space.entity';
import { Seat } from '../entities/seat.entity';
import { SystemConfig } from '../entities/system-config.entity';
import { PERMISSIONS, ROLES, USERS, SPACES, SYSTEM_CONFIGS } from './seed-data';

/**
 * 种子数据：脚本化、幂等、与业务数据分离。
 * 已存在则跳过，可重复执行。
 */
@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async run(): Promise<void> {
    const permRepo = this.dataSource.getRepository(Permission);
    const roleRepo = this.dataSource.getRepository(Role);
    const userRepo = this.dataSource.getRepository(User);
    const spaceRepo = this.dataSource.getRepository(Space);
    const seatRepo = this.dataSource.getRepository(Seat);
    const cfgRepo = this.dataSource.getRepository(SystemConfig);

    // 1. 权限（幂等）
    const permCount = await permRepo.count();
    if (permCount === 0) {
      await permRepo.save(PERMISSIONS.map((p) => permRepo.create(p)));
      this.logger.log(`seeded ${PERMISSIONS.length} permissions`);
    }

    // 2. 角色 + 权限（幂等）
    for (const r of ROLES) {
      const exists = await roleRepo.findOneBy({ code: r.code });
      if (exists) continue;
      const perms = await permRepo.findBy({ code: In(r.permissions) });
      await roleRepo.save(roleRepo.create({ code: r.code, name: r.name, description: r.description, permissions: perms }));
      this.logger.log(`seeded role ${r.code}`);
    }

    // 3. 用户（幂等）
    for (const u of USERS) {
      const exists = await userRepo.findOneBy({ username: u.username });
      if (exists) continue;
      const roles = await roleRepo.findBy({ code: In(u.roles) });
      await userRepo.save(
        userRepo.create({
          username: u.username,
          passwordHash: await bcrypt.hash(u.password, 10),
          name: u.name,
          department: u.department,
          roles,
        }),
      );
      this.logger.log(`seeded user ${u.username}`);
    }

    // 4. 空间与座位（幂等）
    for (const s of SPACES) {
      const exists = await spaceRepo.findOneBy({ code: s.code });
      if (exists) continue;
      const space = await spaceRepo.save(
        spaceRepo.create({
          code: s.code,
          name: s.name,
          type: s.type,
          ownerDept: s.ownerDept,
          openTime: s.openTime,
          closeTime: s.closeTime,
          description: s.description,
        }),
      );
      await seatRepo.save(
        s.seats.map((seat) =>
          seatRepo.create({
            spaceId: space.id,
            seatNo: seat.seatNo,
            hasSocket: seat.hasSocket,
            status: 'available',
            statusSource: 'SYSTEM',
          }),
        ),
      );
      this.logger.log(`seeded space ${s.code} with ${s.seats.length} seats`);
    }

    // 5. 系统参数（幂等）
    for (const c of SYSTEM_CONFIGS) {
      const exists = await cfgRepo.findOneBy({ key: c.key });
      if (!exists) {
        await cfgRepo.save(cfgRepo.create(c));
      }
    }

    this.logger.log('seed complete');
  }
}
