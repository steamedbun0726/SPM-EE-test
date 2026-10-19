import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Reservation } from '../database/entities/reservation.entity';
import { Violation } from '../database/entities/violation.entity';
import { NotificationsService } from '../shared/notifications/notifications.service';
import { SystemConfigService } from '../shared/system-config/system-config.service';
import { RoomRequestsService } from '../modules/m2-rooms/room-requests.service';
import { WorkOrdersService } from '../modules/m3-maintenance/work-orders.service';

/**
 * 定时任务（每分钟）：
 * - M1：预约前提醒 / 预约后未签到再提醒 / 超时未签到自动取消并记违约
 * - M2：整教室审批超时自动撤销
 * - M3：维修工单 SLA 超时升级
 * 生产环境建议独立调度实例（见 docs/ci.md）。
 */
@Injectable()
export class SchedulerService {
  private readonly logger = new Logger(SchedulerService.name);

  constructor(
    @InjectRepository(Reservation) private readonly resvRepo: Repository<Reservation>,
    @InjectRepository(Violation) private readonly violRepo: Repository<Violation>,
    private readonly notificationsService: NotificationsService,
    private readonly configService: SystemConfigService,
    private readonly roomRequestsService: RoomRequestsService,
    private readonly workOrdersService: WorkOrdersService,
  ) {}

  @Cron('* * * * *')
  async tick(): Promise<void> {
    await Promise.allSettled([
      this.processReservationLifecycle().catch((e) => this.logger.error('M1 lifecycle error', e)),
      this.roomRequestsService.expireOverdue().catch((e) => this.logger.error('M2 expire error', e)),
      this.workOrdersService.escalateOverdue().catch((e) => this.logger.error('M3 escalate error', e)),
    ]);
  }

  private today(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** M1 预约生命周期：提醒 → 再提醒 → 违约取消 */
  private async processReservationLifecycle(): Promise<void> {
    const now = new Date();
    const date = this.today();
    const beforeMin = await this.configService.getInt('REMINDER_BEFORE_MINUTES', 15);
    const afterMin = await this.configService.getInt('REMINDER_AFTER_MINUTES', 10);
    const graceMin = await this.configService.getInt('NO_SHOW_GRACE_MINUTES', 15);

    const bookings = await this.resvRepo.findBy({
      date,
      status: 'booked',
    });

    for (const r of bookings) {
      const start = new Date(new Date(`${date}T00:00:00`).getTime() + r.startHour * 3600_000);

      // 预约前 15 分钟提醒（一次）
      if (!r.remindBeforeSent && now.getTime() >= start.getTime() - beforeMin * 60_000 && now < start) {
        await this.notificationsService.send(
          r.userId,
          'reminder',
          '自习座位预约提醒',
          `您预约的 ${r.spaceName} ${r.seatNo} 座位将于 ${r.startHour}:00 开始，请按时到场签到。`,
        );
        r.remindBeforeSent = true;
        await this.resvRepo.save(r);
        continue;
      }

      // 预约开始后 10 分钟仍未签到：再次提醒
      if (!r.remindAfterSent && now.getTime() >= start.getTime() + afterMin * 60_000) {
        await this.notificationsService.send(
          r.userId,
          'reminder',
          '请尽快签到',
          `您预约的 ${r.spaceName} ${r.seatNo} 座位已开始 ${r.startHour}:00，请尽快签到，否则将被取消并记录违约。`,
        );
        r.remindAfterSent = true;
        await this.resvRepo.save(r);
        continue;
      }

      // 预约开始后 15 分钟仍未签到：自动取消 + 违约 + 提醒
      if (now.getTime() >= start.getTime() + graceMin * 60_000) {
        r.status = 'no_show';
        r.noShowAt = now;
        await this.resvRepo.save(r);
        await this.violRepo.save(
          this.violRepo.create({
            userId: r.userId,
            reservationId: r.id,
            type: 'no_show',
            reason: `未在预约开始后 ${graceMin} 分钟内签到`,
          }),
        );
        await this.notificationsService.send(
          r.userId,
          'no_show',
          '预约已取消并记录违约',
          `您预约的 ${r.spaceName} ${r.seatNo}（${r.date} ${r.startHour}:00-${r.endHour}:00）因未按时签到已被自动取消，记录一次违约。`,
        );
      }
    }
  }
}
