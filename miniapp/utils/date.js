function pad(n) {
  return String(n).padStart(2, '0')
}

/** 本地时区的 YYYY-MM-DD，offset 为相对今天的天数 */
function dateStr(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 整点小时 -> HH:00 */
function hourLabel(hour) {
  return `${pad(hour)}:00`
}

module.exports = { dateStr, hourLabel }
