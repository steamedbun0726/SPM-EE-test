import { Injectable, Logger } from '@nestjs/common';
import nodemailer = require('nodemailer');
import { SystemConfigService } from '../../system-config/system-config.service';
import { User } from '../../../database/entities/user.entity';
import { NotificationChannel } from './notification-channel.interface';

/**
 * 邮件推送渠道（SMTP）。
 * 启用条件：PUSH_ENABLED 与 PUSH_EMAIL_ENABLED 均为 true，且配置了 SMTP_HOST。
 */
@Injectable()
export class EmailChannel implements NotificationChannel {
  readonly name = 'email';
  private readonly logger = new Logger(EmailChannel.name);
  private transporter: any = null;

  constructor(private readonly config: SystemConfigService) {}

  async isEnabled(): Promise<boolean> {
    const master = (await this.config.get('PUSH_ENABLED', 'false')) === 'true';
    const on = (await this.config.get('PUSH_EMAIL_ENABLED', 'false')) === 'true';
    const host = (await this.config.get('SMTP_HOST', '')).trim();
    return master && on && host !== '';
  }

  /** 独立成方法便于测试替换，避免连真实 SMTP */
  protected createTransport(opts: any): any {
    return nodemailer.createTransport(opts);
  }

  private async getTransporter(): Promise<any> {
    if (this.transporter) return this.transporter;
    const host = (await this.config.get('SMTP_HOST', '')).trim();
    const port = await this.config.getInt('SMTP_PORT', 587);
    const user = (await this.config.get('SMTP_USER', '')).trim();
    const pass = await this.config.get('SMTP_PASS', '');
    this.transporter = this.createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
    });
    return this.transporter;
  }

  async send(user: User, title: string, content: string): Promise<void> {
    const to = (user.email ?? '').trim();
    if (!to) throw new Error('no email address');
    const transporter = await this.getTransporter();
    const from = (await this.config.get('SMTP_FROM', '')).trim() || 'no-reply@campushub.edu';
    await transporter.sendMail({ from, to, subject: title, text: content });
    this.logger.debug(`email sent to ${to}`);
  }
}
