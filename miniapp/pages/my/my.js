const { get, post } = require('../../utils/request')
const { hourLabel } = require('../../utils/date')

const STATUS_TEXT = {
  booked: '已预约',
  checked_in: '已签到',
  cancelled: '已取消',
  no_show: '违约',
  completed: '已完成',
}

const STATUS_CLASS = {
  booked: 's-booked',
  checked_in: 's-checked',
  cancelled: 's-muted',
  no_show: 's-warn',
  completed: 's-muted',
}

Page({
  data: {
    name: '',
    nameFirstChar: '同',
    loading: false,
    items: [],
  },

  onShow() {
    if (!wx.getStorageSync('token')) {
      wx.reLaunch({ url: '/pages/login/login' })
      return
    }
    const user = wx.getStorageSync('user') || {}
    const name = user.name || ''
    this.setData({
      name,
      nameFirstChar: (name || '同学').slice(0, 1),
    })
    this.load()
  },

  async load() {
    this.setData({ loading: true })
    try {
      const list = await get('/m1/reservations/mine')
      const items = list.map((r) => ({
        ...r,
        statusText: STATUS_TEXT[r.status] || r.status,
        statusClass: STATUS_CLASS[r.status] || 's-muted',
        timeText: `${hourLabel(r.startHour)} - ${hourLabel(r.endHour)}`,
      }))
      this.setData({ items })
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  goBooking() {
    wx.switchTab({ url: '/pages/seats/seats' })
  },

  cancel(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({
      title: '取消预约',
      content: '确定取消这条预约吗？',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await post(`/m1/reservations/${id}/cancel`)
          wx.showToast({ title: '已取消', icon: 'success' })
          this.load()
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' })
        }
      },
    })
  },

  /** 扫描教室屏幕二维码，二维码内容即当日动态码，直接提交签到 */
  scanCheckIn(e) {
    const id = e.currentTarget.dataset.id
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['qrCode'],
      success: async (res) => {
        try {
          await post(`/m1/reservations/${id}/check-in`, { code: (res.result || '').trim() })
          wx.showToast({ title: '签到成功', icon: 'success' })
          this.load()
        } catch (err) {
          wx.showToast({ title: err.message, icon: 'none' })
        }
      },
      fail: (err) => {
        if (!err.errMsg || !err.errMsg.includes('cancel')) {
          wx.showToast({ title: '未完成扫码', icon: 'none' })
        }
      },
    })
  },
})
