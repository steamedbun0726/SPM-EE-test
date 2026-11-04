App({
  globalData: {
    token: '',
    user: null,
  },

  onLaunch() {
    this.globalData.token = wx.getStorageSync('token') || ''
    this.globalData.user = wx.getStorageSync('user') || null
  },

  /** 保存登录态（与 Web 端复用同一 JWT） */
  setSession(loginResult) {
    this.globalData.token = loginResult.accessToken
    this.globalData.user = loginResult.user
    wx.setStorageSync('token', loginResult.accessToken)
    wx.setStorageSync('user', loginResult.user)
  },

  clearSession() {
    this.globalData.token = ''
    this.globalData.user = null
    wx.removeStorageSync('token')
    wx.removeStorageSync('user')
  },
})
