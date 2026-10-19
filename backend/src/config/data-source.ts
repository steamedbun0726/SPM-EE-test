import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export function buildDataSourceOptions(): DataSourceOptions {
  const dbType = (process.env.DB_TYPE || 'sqlite').toLowerCase();
  const common = {
    entities: [path.join(__dirname, '..', 'database', 'entities', '*.entity.{ts,js}')],
    migrations: [path.join(__dirname, '..', 'database', 'migrations', '*.{ts,js}')],
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
    logging: false,
  };

  if (dbType === 'postgres') {
    return {
      ...common,
      type: 'postgres',
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'campushub',
      password: process.env.DB_PASSWORD || 'campushub',
      database: process.env.DB_NAME || 'campushub',
    };
  }
  // 默认 SQLite（开发零配置；使用 sql.js 纯 WASM 引擎，无原生编译依赖）
  const dataDir = path.resolve(process.cwd(), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    ...common,
    type: 'sqljs',
    location: path.join(dataDir, 'campushub.sqlite'),
    autoSave: true,
  };
}

export const AppDataSource = new DataSource(buildDataSourceOptions());
