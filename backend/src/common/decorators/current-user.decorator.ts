import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface JwtUser {
  userId: number;
  username: string;
  name: string;
  roles: string[];
  permissions: string[];
  department: string;
}

export const CurrentUser = createParamDecorator(
  (data: keyof JwtUser | undefined, ctx: ExecutionContext): JwtUser => {
    const request = ctx.switchToHttp().getRequest();
    return data ? request.user?.[data] : request.user;
  },
);
