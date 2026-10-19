import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Reservation } from '../database/entities/reservation.entity';
import { Violation } from '../database/entities/violation.entity';
import { SchedulerService } from './scheduler.service';
import { M2RoomsModule } from '../modules/m2-rooms/m2-rooms.module';
import { M3MaintenanceModule } from '../modules/m3-maintenance/m3-maintenance.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature([Reservation, Violation]),
    M2RoomsModule,
    M3MaintenanceModule,
  ],
  providers: [SchedulerService],
})
export class SchedulerModule {}
