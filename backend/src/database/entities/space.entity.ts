import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  OneToMany,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Seat } from './seat.entity';

export type SpaceType = 'study' | 'classroom' | 'library' | 'other';

@Entity('spaces')
export class Space {
  @PrimaryGeneratedColumn()
  id: number;

  /** 自习室/教室编码，如 LIB-A-101 */
  @Column({ unique: true })
  code: string;

  @Column()
  name: string;

  /** study=自习室 classroom=普通教室 library=图书馆自习区 other=其他 */
  @Column({ default: 'study' })
  type: SpaceType;

  /** 所属院系；空字符串表示全校开放 */
  @Column({ default: '' })
  ownerDept: string;

  /** 开放时间 HH:mm */
  @Column({ default: '08:00' })
  openTime: string;

  /** 关闭时间 HH:mm */
  @Column({ default: '22:00' })
  closeTime: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: '' })
  description: string;

  @OneToMany(() => Seat, (seat) => seat.space)
  seats: Seat[];

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
