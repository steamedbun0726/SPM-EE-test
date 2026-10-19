import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

export type NotificationType = 'reminder' | 'no_show' | 'approval' | 'workorder' | 'system';

/** 通知（通知服务：雏形以站内通知实现，预留邮件/微信推送抽象） */
@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  userId: number;

  @Column({ default: 'system' })
  type: NotificationType;

  @Column()
  title: string;

  @Column({ type: 'text', default: '' })
  content: string;

  @Column({ default: false })
  isRead: boolean;

  @CreateDateColumn()
  createdAt: Date;
}
