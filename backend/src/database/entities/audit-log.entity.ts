import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

/** 操作审计日志 */
@Entity('audit_logs')
export class AuditLog {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column({ type: 'int', nullable: true })
  userId: number | null;

  @Column({ default: '' })
  username: string;

  @Column()
  action: string;

  @Column({ default: '' })
  resourceType: string;

  @Column({ default: '' })
  resourceId: string;

  @Column({ type: 'text', default: '' })
  detail: string;

  @Column({ default: '' })
  ip: string;

  @CreateDateColumn()
  createdAt: Date;
}
