import { defineStore } from 'pinia'
import { login as apiLogin, register as apiRegister, me as apiMe, type RegisterParams } from '@/api/auth'
import type { JwtUser } from '@/api/types'

/** localStorage 键名统一管理 */
const TOKEN_KEY = 'token'
const USER_KEY = 'user'

/**
 * 认证 Store：维护 token 与用户信息（JWT + RBAC）
 * token/user 持久化到 localStorage，刷新后自动恢复
 */
export const useAuthStore = defineStore('auth', {
  state: () => ({
    token: localStorage.getItem(TOKEN_KEY) || '',
    user: JSON.parse(localStorage.getItem(USER_KEY) || 'null') as JwtUser | null,
  }),

  getters: {
    /** 是否已登录（存在 token 即视为登录） */
    isLoggedIn: (s) => !!s.token,
    /** 用户角色编码列表 */
    roles: (s) => s.user?.roles ?? [],
    /** 用户权限码列表 */
    permissions: (s) => s.user?.permissions ?? [],
    /** 判断是否拥有某权限码 */
    hasPerm: (s) => (code: string) => (s.user?.permissions ?? []).includes(code),
  },

  actions: {
    /** 保存登录结果（token + user）到 state 与 localStorage */
    setAuth(token: string, user: JwtUser) {
      this.token = token
      this.user = user
      localStorage.setItem(TOKEN_KEY, token)
      localStorage.setItem(USER_KEY, JSON.stringify(user))
    },

    /** 登录 */
    async login(username: string, password: string) {
      const res = await apiLogin({ username, password })
      this.setAuth(res.accessToken, res.user)
    },

    /** 注册（后端注册成功即返回登录态） */
    async register(data: RegisterParams) {
      const res = await apiRegister(data)
      this.setAuth(res.accessToken, res.user)
    },

    /** 退出登录：清空本地登录态 */
    logout() {
      this.token = ''
      this.user = null
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
    },

    /** 拉取最新用户信息（刷新权限/角色） */
    async fetchMe() {
      const user = await apiMe()
      this.user = user
      localStorage.setItem(USER_KEY, JSON.stringify(user))
    },
  },
})
