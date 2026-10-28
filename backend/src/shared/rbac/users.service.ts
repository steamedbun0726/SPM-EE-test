import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User } from '../../database/entities/user.entity';
import { Role } from '../../database/entities/role.entity';
import { Permission } from '../../database/entities/permission.entity';

export interface UserWithRoles extends User {
  roleCodes: string[];
  permissionCodes: string[];
}

/**
 * 对外可见的用户视图：**不含 passwordHash**。
 *
 * 所有会返回给客户端的用户对象都必须收敛到该类型。此前 `decorate()` 直接
 * 展开实体，导致 `GET /api/users` 把 bcrypt 哈希原样吐给前端（任何人打开
 * 「用户管理」页都能从网络面板拿到全部账号哈希，可离线爆破）。
 */
export type PublicUser = Omit<UserWithRoles, 'passwordHash'>;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
    @InjectRepository(Role) private readonly roleRepo: Repository<Role>,
    @InjectRepository(Permission) private readonly permRepo: Repository<Permission>,
  ) {}

  /**
   * 按用户名查询，**返回值含 passwordHash**，仅供认证流程校验密码使用，
   * 不得直接作为 HTTP 响应返回。对外请用 {@link findById}。
   */
  async findByUsername(username: string): Promise<UserWithRoles | null> {
    const user = await this.repo.findOne({
      where: { username },
      relations: ['roles', 'roles.permissions'],
    });
    return user ? this.decorate(user) : null;
  }

  async findById(id: number): Promise<PublicUser> {
    const user = await this.repo.findOne({
      where: { id },
      relations: ['roles', 'roles.permissions'],
    });
    if (!user) throw new NotFoundException(`用户 ${id} 不存在`);
    return this.toPublic(this.decorate(user));
  }

  private decorate(user: User): UserWithRoles {
    const roleCodes = (user.roles || []).map((r) => r.code);
    const permissionCodes = [
      ...new Set((user.roles || []).flatMap((r) => (r.permissions || []).map((p) => p.code))),
    ];
    return { ...user, roleCodes, permissionCodes };
  }

  /** 剔除密码哈希，得到可安全序列化的用户视图 */
  private toPublic(user: UserWithRoles): PublicUser {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }

  /**
   * 按权限码反查在职用户。
   *
   * 用于「按职责找人」的场景，例如 M3 派单时需要列出所有具备
   * workorder.handle 的维修员、M3 设备老化告警需要找派单员。
   * 这些场景需要的是「人」，不是「当前登录用户的权限」，所以必须能反查。
   */
  async findByPermission(permissionCode: string): Promise<PublicUser[]> {
    const rows = await this.repo
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.roles', 'roles')
      .leftJoinAndSelect('roles.permissions', 'perm')
      .where('u.isActive = :active', { active: true })
      .andWhere((qb) => {
        const sub = qb
          .subQuery()
          .select('u2.id')
          .from(User, 'u2')
          .innerJoin('u2.roles', 'r2')
          .innerJoin('r2.permissions', 'p2')
          .where('p2.code = :code')
          .getQuery();
        return `u.id IN ${sub}`;
      })
      .setParameter('code', permissionCode)
      .orderBy('u.id', 'ASC')
      .getMany();
    return rows.map((u) => this.toPublic(this.decorate(u)));
  }

  async findAll(params: { keyword?: string; page?: number; pageSize?: number }) {
    // 必须一并 join 权限：否则返回的 permissionCodes 恒为 []，
    // 前端拿它做判断会得到「用户没有任何权限」的错误结论
    const qb = this.repo
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.roles', 'roles')
      .leftJoinAndSelect('roles.permissions', 'perm');
    if (params.keyword) {
      qb.where('u.username LIKE :k OR u.name LIKE :k OR u.department LIKE :k', {
        k: `%${params.keyword}%`,
      });
    }
    qb.orderBy('u.id', 'DESC')
      .skip(((params.page || 1) - 1) * (params.pageSize || 20))
      .take(params.pageSize || 20);
    const [items, total] = await qb.getManyAndCount();
    return {
      items: items.map((u) => this.toPublic(this.decorate(u))),
      total,
    };
  }

  async create(data: {
    username: string;
    password: string;
    name: string;
    email?: string;
    phone?: string;
    department?: string;
    roleCodes?: string[];
  }): Promise<PublicUser> {
    const exists = await this.repo.findOneBy({ username: data.username });
    if (exists) throw new ConflictException(`用户名 ${data.username} 已存在`);
    const user = this.repo.create({
      username: data.username,
      passwordHash: await bcrypt.hash(data.password, 10),
      name: data.name,
      email: data.email || '',
      phone: data.phone || '',
      department: data.department || '',
    });
    if (data.roleCodes?.length) {
      user.roles = await this.roleRepo.findBy({ code: In(data.roleCodes) });
    }
    const saved = await this.repo.save(user);
    return this.findById(saved.id);
  }

  async update(
    id: number,
    data: Partial<{
      name: string;
      email: string;
      phone: string;
      department: string;
      isActive: boolean;
      password: string;
      roleCodes: string[];
    }>,
  ): Promise<PublicUser> {
    const user = await this.repo.findOne({
      where: { id },
      relations: ['roles'],
    });
    if (!user) throw new NotFoundException(`用户 ${id} 不存在`);
    if (data.password) {
      user.passwordHash = await bcrypt.hash(data.password, 10);
      delete data.password;
    }
    if (data.roleCodes) {
      user.roles = await this.roleRepo.findBy({ code: In(data.roleCodes) });
      delete data.roleCodes;
    }
    Object.assign(user, data);
    await this.repo.save(user);
    return this.findById(id);
  }

  /** 校验密码 */
  async verifyPassword(user: User, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }
}
