import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from '../../database/entities/audit-log.entity';

export interface AuditInput {
  userId: number | null;
  username: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detail: string;
  ip: string;
}

/** 操作审计服务 */
@Injectable()
export class AuditService {
  constructor(
    @InjectRepository(AuditLog) private readonly repo: Repository<AuditLog>,
  ) {}

  async record(input: AuditInput): Promise<AuditLog> {
    return this.repo.save(this.repo.create(input));
  }

  async findAll(params: { keyword?: string; page?: number; pageSize?: number }) {
    const qb = this.repo.createQueryBuilder('a');
    if (params.keyword) {
      qb.where('a.username LIKE :k OR a.action LIKE :k OR a.detail LIKE :k', {
        k: `%${params.keyword}%`,
      });
    }
    qb.orderBy('a.id', 'DESC')
      .skip(((params.page || 1) - 1) * (params.pageSize || 20))
      .take(params.pageSize || 20);
    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }
}
