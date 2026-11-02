import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Space } from '../database/entities/space.entity';
import { Seat } from '../database/entities/seat.entity';
import { SeatStatusLog } from '../database/entities/seat-status-log.entity';
import { Reservation } from '../database/entities/reservation.entity';
import { Notification } from '../database/entities/notification.entity';
import { AuditLog } from '../database/entities/audit-log.entity';
import { SystemConfig } from '../database/entities/system-config.entity';
import { User } from '../database/entities/user.entity';
import { SpacesService } from './spaces/spaces.service';
import { SpacesController } from './spaces/spaces.controller';
import { SeatStateService } from './spaces/seat-state.service';
import { NotificationsService } from './notifications/notifications.service';
import { PushService } from './notifications/push.service';
import { EmailChannel } from './notifications/channels/email.channel';
import { WechatChannel } from './notifications/channels/wechat.channel';
import { NotificationsController } from './notifications/notifications.controller';
import { AuditService } from './audit/audit.service';
import { AuditController } from './audit/audit.controller';
import { AuditInterceptor } from './audit/audit.interceptor';
import { SystemConfigService } from './system-config/system-config.service';
import { SystemConfigController } from './system-config/system-config.controller';
import { AuthModule } from './auth/auth.module';

@Global()
@Module({
  imports: [
    AuthModule,
    TypeOrmModule.forFeature([
      Space,
      Seat,
      SeatStatusLog,
      Reservation,
      Notification,
      AuditLog,
      SystemConfig,
      User,
    ]),
  ],
  providers: [
    SpacesService,
    SeatStateService,
    NotificationsService,
    EmailChannel,
    WechatChannel,
    PushService,
    AuditService,
    SystemConfigService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  controllers: [SpacesController, NotificationsController, AuditController, SystemConfigController],
  exports: [
    SpacesService,
    SeatStateService,
    NotificationsService,
    PushService,
    AuditService,
    SystemConfigService,
  ],
})
export class SharedModule {}
