import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from '../../database/entities/notification.entity';
import { User } from '../../database/entities/user.entity';
import { SystemConfigService } from '../system-config/system-config.service';
import { NotificationsService } from './notifications.service';
import { NotificationChannel, PushOutcome } from './channels/notification-channel.interface';
import { EmailChannel } from './channels/email.channel';
import { WechatChannel } from './channels/wechat.channel';

export interface PushResult {
  /** 站内通知（保底必达，先行落库） */
  inApp: Notification;
  /** 外部推送汇总；enabled=false 表示总开关关闭，未尝试任何外部渠道 */
  external: { enabled: boolean; outcomes: PushOutcome[] };
}

/**
 * 统一推送入口（D 公共层）。
 *
 * 顺序约定：**先落站内通知，再尝试外部渠道（邮件 / 微信）**。
 * 外部渠道任一失败只记录日志并标记 ok=false，绝不回滚站内通知、也不抛出异常，
 * 从而保证业务主流程不被第三方服务可用性影响（失败降级）。
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly channels: NotificationChannel[];

  constructor(
    @InjectRepository(User) private readonly userRepo: Repository<User>,
    private readonly notifications: NotificationsService,
    private readonly config: SystemConfigService,
    email: EmailChannel,
    wechat: WechatChannel,
  ) {
    this.channels = [email, wechat];
  }

  async notify(
    userId: number,
    type: NotificationType,
    title: string,
    content: string,
  ): Promise<PushResult> {
    // 1) 站内通知：保底必达
    const inApp = await this.notifications.send(userId, type, title, content);

    // 2) 外部推送：总开关关闭则完全跳过
    const enabled = (await this.config.get('PUSH_ENABLED', 'false')) === 'true';
    if (!enabled) {
      return { inApp, external: { enabled: false, outcomes: [] } };
    }

    const user = await this.userRepo.findOneBy({ id: userId });
    const outcomes: PushOutcome[] = [];
    for (const ch of this.channels) {
      try {
        if (!(await ch.isEnabled())) {
          outcomes.push({ channel: ch.name, ok: false, reason: 'disabled' });
          continue;
        }
        if (!user) {
          outcomes.push({ channel: ch.name, ok: false, reason: 'user not found' });
          continue;
        }
        await ch.send(user, title, content);
        outcomes.push({ channel: ch.name, ok: true });
      } catch (e) {
        const reason = (e as Error)?.message ?? 'unknown error';
        this.logger.warn(`push channel ${ch.name} failed: ${reason}`);
        outcomes.push({ channel: ch.name, ok: false, reason });
      }
    }

    return { inApp, external: { enabled: true, outcomes } };
  }
}
