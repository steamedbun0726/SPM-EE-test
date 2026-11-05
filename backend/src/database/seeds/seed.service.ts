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

    // 1. 权限（幂等，按 code 增量补齐：新增权限码在已有库中也能生效）
    for (const p of PERMISSIONS) {
      const exists = await permRepo.findOneBy({ code: p.code });
      if (!exists) {
        await permRepo.save(permRepo.create(p));
        this.logger.log(`seeded permission ${p.code}`);
      }
    }

    // 2. 角色 + 权限（幂等，增量补权限，不删除已有绑定）
    for (const r of ROLES) {
      const perms = await permRepo.findBy({ code: In(r.permissions) });
      const exists = await roleRepo.findOne({
        where: { code: r.code },
        relations: ['permissions'],
      });
      if (!exists) {
        await roleRepo.save(
          roleRepo.create({ code: r.code, name: r.name, description: r.description, permissions: perms }),
        );
        this.logger.log(`seeded role ${r.code}`);
        continue;
      }
      const have = new Set((exists.permissions || []).map((p) => p.code));
      const missing = perms.filter((p) => !have.has(p.code));
      if (missing.length) {
        exists.permissions = [...(exists.permissions || []), ...missing];
        await roleRepo.save(exists);
        this.logger.log(`updated role ${r.code} (+${missing.length} permissions)`);
      }
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
