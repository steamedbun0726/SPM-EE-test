import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { buildDataSourceOptions } from './config/data-source';
import { SharedModule } from './shared/shared.module';
import { M1SeatsModule } from './modules/m1-seats/m1-seats.module';
import { M2RoomsModule } from './modules/m2-rooms/m2-rooms.module';
import { M3MaintenanceModule } from './modules/m3-maintenance/m3-maintenance.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SeedService } from './database/seeds/seed.service';
import { JwtAuthGuard } from './shared/auth/jwt-auth.guard';
import { PermissionsGuard } from './shared/auth/permissions.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        ...buildDataSourceOptions(),
        migrationsRun: true,
      }),
    }),
    SharedModule,
    M1SeatsModule,
    M2RoomsModule,
    M3MaintenanceModule,
    SchedulerModule,
  ],
  controllers: [AppController],
  providers: [
    SeedService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule implements OnApplicationBootstrap {
  constructor(private readonly seedService: SeedService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedService.run();
  }
}
