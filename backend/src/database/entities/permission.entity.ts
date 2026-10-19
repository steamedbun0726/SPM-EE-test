import { Entity, PrimaryGeneratedColumn, Column, ManyToMany, CreateDateColumn } from 'typeorm';
import { Role } from './role.entity';

@Entity('permissions')
export class Permission {
  @PrimaryGeneratedColumn()
  id: number;

  /** 权限编码，如 seat.book / room.approve */
  @Column({ unique: true })
  code: string;

  @Column()
  name: string;

  @Column({ default: '' })
  description: string;

  @ManyToMany(() => Role, (r) => r.permissions)
  roles: Role[];

  @CreateDateColumn()
  createdAt: Date;
}
