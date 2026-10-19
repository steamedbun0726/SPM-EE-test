import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../rbac/users.service';
import { JwtUser } from '../../common/decorators/current-user.decorator';

export interface LoginResult {
  accessToken: string;
  user: JwtUser;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async login(username: string, password: string): Promise<LoginResult> {
    const user = await this.usersService.findByUsername(username);
    if (!user) throw new UnauthorizedException('用户名或密码错误');
    if (!user.isActive) throw new UnauthorizedException('账号已被禁用');
    const ok = await this.usersService.verifyPassword(user, password);
    if (!ok) throw new UnauthorizedException('用户名或密码错误');

    const payload: JwtUser = {
      userId: user.id,
      username: user.username,
      name: user.name,
      roles: user.roleCodes,
      permissions: user.permissionCodes,
      department: user.department,
    };
    return {
      accessToken: this.jwtService.sign(payload),
      user: payload,
    };
  }

  /** 学生自助注册 */
  async register(data: {
    username: string;
    password: string;
    name: string;
    email?: string;
    department?: string;
  }): Promise<LoginResult> {
    const user = await this.usersService.create({
      username: data.username,
      password: data.password,
      name: data.name,
      email: data.email,
      department: data.department,
      roleCodes: ['student'],
    });
    const payload: JwtUser = {
      userId: user.id,
      username: user.username,
      name: user.name,
      roles: user.roleCodes,
      permissions: user.permissionCodes,
      department: user.department,
    };
    return {
      accessToken: this.jwtService.sign(payload),
      user: payload,
    };
  }
}
