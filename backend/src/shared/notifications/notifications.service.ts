import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from '../../database/entities/notification.entity';

/**
 * 通知服务。任务书要求邮件/微信服务号等推送；
 * 雏形以站内通知实现，保留推送渠道抽象（后续可扩展 email/wechat provider）。
 */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectRepository(Notification) private readonly repo: Repository<Notification>,
  ) {}

  async send(userId: number, type: NotificationType, title: string, content: string) {
    return this.repo.save(this.repo.create({ userId, type, title, content }));
  }

  async sendBatch(
    userIds: number[],
    type: NotificationType,
    title: string,
    content: string,
  ): Promise<number> {
    const items = userIds.map((uid) => this.repo.create({ userId: uid, type, title, content }));
    await this.repo.save(items);
    return items.length;
  }

  async listForUser(userId: number, unreadOnly = false) {
    return this.repo.find({
      where: unreadOnly ? { userId, isRead: false } : { userId },
      order: { id: 'DESC' },
      take: 100,
    });
  }

  async markRead(id: number, userId: number) {
    await this.repo.update({ id, userId }, { isRead: true });
    return { ok: true };
  }

  async markAllRead(userId: number) {
    await this.repo.update({ userId }, { isRead: true });
    return { ok: true };
  }

  async unreadCount(userId: number): Promise<number> {
    return this.repo.countBy({ userId, isRead: false });
  }
}
