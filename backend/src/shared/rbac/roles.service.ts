import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Role } from '../../database/entities/role.entity';
import { Permission } from '../../database/entities/permission.entity';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(Role) private readonly repo: Repository<Role>,
    @InjectRepository(Permission)
    private readonly permRepo: Repository<Permission>,
  ) {}

  findAll(): Promise<Role[]> {
    return this.repo.find({ relations: ['permissions'] });
  }

  async findByCode(code: string): Promise<Role | null> {
    return this.repo.findOne({
      where: { code },
      relations: ['permissions'],
    });
  }

  async findById(id: number): Promise<Role> {
    const role = await this.repo.findOne({
      where: { id },
      relations: ['permissions'],
    });
    if (!role) throw new NotFoundException(`角色 ${id} 不存在`);
    return role;
  }

  async create(data: { code: string; name: string; description?: string }): Promise<Role> {
    const exists = await this.repo.findOneBy({ code: data.code });
    if (exists) throw new ConflictException(`角色编码 ${data.code} 已存在`);
    const role = this.repo.create(data);
    return this.repo.save(role);
  }

  async update(id: number, data: Partial<{ name: string; description: string }>): Promise<Role> {
    const role = await this.findById(id);
    Object.assign(role, data);
    return this.repo.save(role);
  }

  /** 设置角色权限（幂等：传入完整权限码集合） */
  async setPermissions(id: number, permissionCodes: string[]): Promise<Role> {
    const role = await this.findById(id);
    if (permissionCodes.length === 0) {
      role.permissions = [];
    } else {
      const perms = await this.permRepo.findBy({ code: In(permissionCodes) });
      role.permissions = perms;
    }
    return this.repo.save(role);
  }

  async remove(id: number): Promise<void> {
    const role = await this.findById(id);
    await this.repo.remove(role);
  }

  /** 权限目录（供管理员配置角色） */
  listPermissions(): Promise<Permission[]> {
    return this.permRepo.find();
  }
}
