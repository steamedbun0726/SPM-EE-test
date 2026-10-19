import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToMany,
  JoinTable,
  CreateDateColumn,
} from 'typeorm';
import { User } from './user.entity';
import { Permission } from './permission.entity';

@Entity('roles')
export class Role {
  @PrimaryGeneratedColumn()
  id: number;

  /** 角色编码，如 student / admin */
  @Column({ unique: true })
  code: string;

  @Column()
  name: string;

  @Column({ default: '' })
  description: string;

  @ManyToMany(() => Permission, (p) => p.roles)
  @JoinTable({ name: 'role_permissions' })
  permissions: Permission[];

  @ManyToMany(() => User, (u) => u.roles)
  users: User[];

  @CreateDateColumn()
  createdAt: Date;
}
