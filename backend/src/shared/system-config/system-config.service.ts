import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SystemConfig } from '../../database/entities/system-config.entity';

/** 系统参数服务：业务参数运行时可调（种子数据预置默认值） */
@Injectable()
export class SystemConfigService {
  constructor(
    @InjectRepository(SystemConfig) private readonly repo: Repository<SystemConfig>,
  ) {}

  async get(key: string, defaultValue = ''): Promise<string> {
    const row = await this.repo.findOneBy({ key });
    return row ? row.value : defaultValue;
  }

  async getInt(key: string, defaultValue: number): Promise<number> {
    const raw = await this.get(key);
    if (!raw) return defaultValue;
    const n = Number(raw);
    return Number.isNaN(n) ? defaultValue : n;
  }

  async set(key: string, value: string, description = ''): Promise<SystemConfig> {
    let row = await this.repo.findOneBy({ key });
    if (!row) {
      row = this.repo.create({ key, value, description });
    } else {
      row.value = value;
      if (description) row.description = description;
    }
    return this.repo.save(row);
  }

  async findAll(): Promise<SystemConfig[]> {
    return this.repo.find({ order: { key: 'ASC' } });
  }
}
