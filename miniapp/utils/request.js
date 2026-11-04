const { BASE_URL } = require('./config')

/** 从后端错误响应中提取可读提示（ValidationPipe 的 message 可能是数组） */
function extractMessage(body, statusCode) {
  if (!body) return `请求失败（${statusCode}）`
  const message = body.message
  if (Array.isArray(message)) return message.join('；')
  if (typeof message === 'string') return message
  if (typeof body.error === 'string') return body.error
  return `请求失败（${statusCode}）`
}

/**
 * 统一请求封装：自动附带 JWT，401 时清除登录态并回到登录页。
 * @param {string} path 以 / 开头的接口路径，如 /m1/seats/search
 * @param {{method?: string, data?: object, auth?: boolean}} options
 */
function request(path, options = {}) {
  const method = options.method || 'GET'
  const withAuth = options.auth !== false

  return new Promise((resolve, reject) => {
    const header = { 'Content-Type': 'application/json' }
    if (withAuth) {
      const token = wx.getStorageSync('token')
      if (token) header.Authorization = `Bearer ${token}`
    }

    wx.request({
      url: BASE_URL + path,
      method,
      data: options.data,
      header,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(res.data)
          return
        }
        if (res.statusCode === 401) {
          getApp().clearSession()
          wx.reLaunch({ url: '/pages/login/login' })
          reject(new Error('登录已失效，请重新登录'))
          return
        }
        reject(new Error(extractMessage(res.data, res.statusCode)))
      },
      fail(err) {
        reject(new Error(err.errMsg || '网络异常，请稍后重试'))
      },
    })
  })
}

function get(path, data) {
  return request(path, { method: 'GET', data })
}

function post(path, data) {
  return request(path, { method: 'POST', data })
}

module.exports = { request, get, post }
