import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { ElMessage } from 'element-plus'

/** 后端统一错误响应体（NestJS 默认结构） */
interface ApiErrorBody {
  message?: string | string[]
  error?: string
  statusCode?: number
}

const http: AxiosInstance = axios.create({
  baseURL: '/api', // 全局前缀，dev 由 vite proxy 转发到 http://localhost:3000
  timeout: 15000,
})

// 请求拦截器：注入 JWT（localStorage 'token'）
http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截器：401 清登录态跳登录页；业务错误统一 ElMessage 提示并 reject
http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiErrorBody>) => {
    const status = error.response?.status
    if (status === 401) {
      // 登录失效：清 token 并跳转登录页（动态引入 router 避免循环依赖）
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      if (!location.pathname.startsWith('/login')) {
        location.href = '/login'
      }
    } else {
      // 提取后端业务错误 message（兼容字符串与数组）
      const body = error.response?.data
      const msg = Array.isArray(body?.message)
        ? body!.message![0]
        : body?.message || error.message || '请求失败'
      ElMessage.error(msg)
    }
    return Promise.reject(error)
  },
)

export default http
