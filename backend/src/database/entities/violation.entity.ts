import { Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn } from 'typeorm';

export type ViolationType = 'no_show';

/** 违约记录 */
@Entity('violations')
export class Violation {
  @PrimaryGeneratedColumn()
  id: number;

  @Index()
  @Column()
  userId: number;

  @Column({ type: 'int', nullable: true })
  reservationId: number | null;

  @Column({ default: 'no_show' })
  type: ViolationType;

  @Column({ default: '' })
  reason: string;

  @CreateDateColumn()
  createdAt: Date;
}
