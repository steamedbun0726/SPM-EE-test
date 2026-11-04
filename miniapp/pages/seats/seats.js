const { get, post } = require('../../utils/request')
const { dateStr, hourLabel } = require('../../utils/date')

const START_OPTIONS = []
for (let i = 0; i <= 22; i++) START_OPTIONS.push(hourLabel(i))
const END_OPTIONS = []
for (let i = 1; i <= 23; i++) END_OPTIONS.push(hourLabel(i))

Page({
  data: {
    today: '',
    maxDate: '',
    date: '',
    startOptions: START_OPTIONS,
    endOptions: END_OPTIONS,
    startHour: 9,
    endHour: 11,
    endHourIndex: 10,
    startLabel: '09:00',
    endLabel: '11:00',
    onlySocket: false,
    loading: false,
    searched: false,
    total: 0,
    groups: [],
    selectedSeatId: null,
    selectedSeatNo: '',
    selectedSpaceName: '',
  },

  onLoad() {
    const today = dateStr(0)
    this.setData({ today, maxDate: dateStr(6), date: today })
  },

  onShow() {
    if (!wx.getStorageSync('token')) {
      wx.reLaunch({ url: '/pages/login/login' })
    }
  },

  onDateChange(e) {
    this.setData({
      date: e.detail.value,
      searched: false,
      groups: [],
      total: 0,
      selectedSeatId: null,
      selectedSeatNo: '',
      selectedSpaceName: '',
    })
  },

  onStartChange(e) {
    const startHour = Number(e.detail.value)
    let endHour = this.data.endHour
    let endHourIndex = this.data.endHourIndex
    if (endHour <= startHour) {
      endHour = Math.min(23, startHour + 1)
      endHourIndex = endHour - 1
    }
    this.setData({
      startHour,
      startLabel: hourLabel(startHour),
      endHour,
      endHourIndex,
      endLabel: hourLabel(endHour),
    })
  },

  onEndChange(e) {
    const endHourIndex = Number(e.detail.value)
    const endHour = endHourIndex + 1
    this.setData({ endHour, endHourIndex, endLabel: hourLabel(endHour) })
  },

  onSocketChange(e) {
    this.setData({ onlySocket: e.detail.value })
  },

  async search() {
    const { date, startHour, endHour, onlySocket, loading } = this.data
    if (loading) return
    if (startHour >= endHour) {
      wx.showToast({ title: '结束时间需晚于开始时间', icon: 'none' })
      return
    }

    this.setData({ loading: true })
    try {
      const query = { date, startHour, endHour }
      if (onlySocket) query.hasSocket = 'true'
      const items = await get('/m1/seats/search', query)

      // 按空间分组，便于学生按自习室选座
      const groups = []
      const map = {}
      for (const item of items) {
        if (!map[item.spaceId]) {
          map[item.spaceId] = {
            spaceId: item.spaceId,
            spaceCode: item.spaceCode,
            spaceName: item.spaceName,
            openTime: item.openTime,
            closeTime: item.closeTime,
            seats: [],
          }
          groups.push(map[item.spaceId])
        }
        map[item.spaceId].seats.push(item)
      }

      this.setData({
        groups,
        total: items.length,
        searched: true,
        selectedSeatId: null,
        selectedSeatNo: '',
        selectedSpaceName: '',
      })
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  selectSeat(e) {
    const seatId = Number(e.currentTarget.dataset.seatId)
    const picked = this.data.selectedSeatId !== seatId
    this.setData({
      selectedSeatId: picked ? seatId : null,
      selectedSeatNo: picked ? e.currentTarget.dataset.seatNo : '',
      selectedSpaceName: picked ? e.currentTarget.dataset.spaceName : '',
    })
  },

  async book() {
    const { selectedSeatId, date, startHour, endHour } = this.data
    if (!selectedSeatId) return

    try {
      wx.showLoading({ title: '预约中', mask: true })
      await post('/m1/reservations', { seatId: selectedSeatId, date, startHour, endHour })
      wx.hideLoading()
      wx.showToast({ title: '预约成功', icon: 'success' })
      this.setData({ selectedSeatId: null, selectedSeatNo: '', selectedSpaceName: '' })
      setTimeout(() => wx.switchTab({ url: '/pages/my/my' }), 1000)
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message, icon: 'none' })
    }
  },
})
