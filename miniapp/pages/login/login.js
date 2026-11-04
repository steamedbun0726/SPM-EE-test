const { request } = require('../../utils/request')

Page({
  data: {
    username: 'student',
    password: 'student123',
    loading: false,
  },

  onLoad() {
    if (wx.getStorageSync('token')) {
      wx.switchTab({ url: '/pages/seats/seats' })
    }
  },

  onUsername(e) {
    this.setData({ username: e.detail.value })
  },

  onPassword(e) {
    this.setData({ password: e.detail.value })
  },

  async submit() {
    const { username, password, loading } = this.data
    if (loading) return
    if (!username.trim() || !password.trim()) {
      wx.showToast({ title: '请填写用户名和密码', icon: 'none' })
      return
    }

    this.setData({ loading: true })
    try {
      const result = await request('/auth/login', {
        method: 'POST',
        auth: false,
        data: { username: username.trim(), password },
      })
      getApp().setSession(result)
      wx.showToast({ title: '登录成功', icon: 'success' })
      setTimeout(() => wx.switchTab({ url: '/pages/seats/seats' }), 800)
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },
})
