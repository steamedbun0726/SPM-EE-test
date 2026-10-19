import http from './http'
import type { JwtUser, LoginResult } from './types'

/** 登录入参（LoginDto） */
export interface LoginParams {
  username: string
  password: string
}

/** 注册入参（RegisterDto，password 最少 6 位） */
export interface RegisterParams {
  username: string
  password: string
  name: string
  email?: string
  department?: string
}

/** 登录：POST /auth/login → { accessToken, user } */
export function login(data: LoginParams): Promise<LoginResult> {
  return http.post('/auth/login', data).then((r) => r.data)
}

/** 注册：POST /auth/register → { accessToken, user }（注册成功即已登录） */
export function register(data: RegisterParams): Promise<LoginResult> {
  return http.post('/auth/register', data).then((r) => r.data)
}

/** 当前用户信息：GET /auth/me → JwtUser */
export function me(): Promise<JwtUser> {
  return http.get('/auth/me').then((r) => r.data)
}
