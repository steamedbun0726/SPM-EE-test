/**
 * M3 二期能力端到端验证脚本（真实 HTTP，不打桩）。
 * 覆盖：字典、部分下架、下架作废预约、留言、ETA、申诉裁决、回访、负载视图。
 */

const BASE = 'http://localhost:3000/api';

let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

async function api(method, path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

async function login(username, password) {
  const r = await api('POST', '/auth/login', null, { username, password });
  if (r.status >= 300) throw new Error(`登录失败 ${username}: ${JSON.stringify(r.body)}`);
  return r.body.accessToken || r.body.access_token || r.body.token;
}

function ymd(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

(async () => {
  console.log('== 登录 ==');
  const student = await login('student', 'student123');
  const student2 = await login('student2', 'student123');
  const ops = await login('ops', 'ops123');
  const maint = await login('maintenance', 'maint123');
  console.log('  ✅ 四个角色登录成功');

  console.log('== M3-31 字典接口 ==');
  const meta = await api('GET', '/m3/work-orders/meta', student);
  check('meta 返回 8 个分类', meta.body?.categories?.length === 8);
  check('meta 含限制项', meta.body?.limits?.maxPhotos === 3);

  console.log('== 准备数据：找空间与座位 ==');
  const spaces = await api('GET', '/spaces', student);
  const space = spaces.body.find((s) => s.code === 'CLASS-301') || spaces.body[3];
  const seatsResp = await api('GET', `/spaces/${space.id}/seats`, student);
  const seats = seatsResp.body;
  console.log(`  空间 ${space.code}(${space.id}) 座位数 ${seats.length}`);

  console.log('== M3-24 先用学生2 预约两个座位 ==');
  const s1 = seats[0];
  const s2 = seats[1];
  const book1 = await api('POST', '/m1/reservations', student2, {
    seatId: s1.id,
    date: ymd(1),
    startHour: 10,
    endHour: 12,
  });
  const book2 = await api('POST', '/m1/reservations', student2, {
    seatId: s2.id,
    date: ymd(2),
    startHour: 14,
    endHour: 16,
  });
  check('预约 1 成功', book1.status < 300, JSON.stringify(book1.body));
  check('预约 2 成功', book2.status < 300, JSON.stringify(book2.body));

  console.log('== M3-19 部分下架（只下架 2 个座位）==');
  const report = await api('POST', '/m3/work-orders', student, {
    title: 'A 区两个座位桌面插座无电',
    description: '左侧两个座位插排都没反应',
    category: 'electrical',
    priority: 'high',
    targetType: 'space',
    spaceId: space.id,
    seatIds: [s1.id, s2.id],
    photoUrls: ['https://cdn.example.com/a.jpg'],
  });
  check('上报成功', report.status < 300, JSON.stringify(report.body));
  const woId = report.body.id;
  console.log(`  工单 ${report.body.workOrderNo}  分类=${report.body.categoryLabel} 优先级=${report.body.priorityLabel}`);
  check('视图含座位清单', Array.isArray(report.body.seatIdList) && report.body.seatIdList.length === 2);
  check('视图含 SLA 进度', typeof report.body.slaUsedRatio === 'number');

  const seatsAfter = await api('GET', `/spaces/${space.id}/seats`, student);
  const st = new Map(seatsAfter.body.map((x) => [x.id, x.status]));
  check('指定座位已下架', st.get(s1.id) === 'maintenance' && st.get(s2.id) === 'maintenance');
  check('未指定座位仍可约', seatsAfter.body.filter((x) => x.status === 'maintenance').length === 2);

  console.log('== M3-24 受影响预约应被作废并不计违约 ==');
  const myResv = await api('GET', '/m1/reservations/mine', student2);
  const r1 = myResv.body.find((r) => r.id === book1.body.id);
  const r2 = myResv.body.find((r) => r.id === book2.body.id);
  check('预约 1 已取消', r1?.status === 'cancelled', r1?.status);
  check('预约 2 已取消', r2?.status === 'cancelled', r2?.status);
  const notif2 = await api('GET', '/notifications', student2);
  check(
    '预约人收到取消通知',
    (notif2.body.items || notif2.body).some((n) => String(n.title).includes('预约已被取消')),
  );

  const events1 = await api('GET', `/m3/work-orders/${woId}/events`, student);
  check(
    '时间线记录座位释放',
    events1.body.some((e) => e.type === 'seats_released' && e.note.includes('作废预约 2 条')),
    JSON.stringify(events1.body.map((e) => [e.type, e.note])),
  );

  console.log('== M3-30 重复上报应被拒 ==');
  const dup = await api('POST', '/m3/work-orders', student, {
    title: '再报一次',
    targetType: 'seat',
    targetId: s1.id,
  });
  check('重复上报被拒', dup.status === 409, `${dup.status} ${JSON.stringify(dup.body)}`);

  console.log('== 派单 / 留言 / ETA ==');
  const dispatchers = await api('GET', '/m3/work-orders/technicians', ops);
  check('M3-26 负载视图可用', Array.isArray(dispatchers.body));
  const maintUser = dispatchers.body.find((t) => t.name === '张师傅');
  console.log(`  维修员负载：${JSON.stringify(maintUser)}`);
  const maintId = maintUser?.userId;
  check('负载视图含技能画像', Array.isArray(maintUser?.topCategories));

  const dispatched = await api('POST', `/m3/work-orders/${woId}/dispatch`, ops, { assigneeId: maintId });
  check('派单成功', dispatched.status < 300, JSON.stringify(dispatched.body));

  const comment = await api('POST', `/m3/work-orders/${woId}/comments`, maint, {
    content: '已到现场，需要更换两位插排模块',
  });
  check('维修员留言成功', comment.status < 300, JSON.stringify(comment.body));

  const eta = await api('PATCH', `/m3/work-orders/${woId}/eta`, maint, {
    etaAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
  });
  check('ETA 更新成功', eta.status < 300 && eta.body.etaAt != null);

  const notifStudent = await api('GET', '/notifications', student);
  check(
    '上报人收到留言与 ETA 通知',
    (notifStudent.body.items || notifStudent.body).some((n) => n.title === '工单有新留言') &&
      (notifStudent.body.items || notifStudent.body).some((n) => n.title === '预计恢复时间已更新'),
  );

  console.log('== 开工 / 完工 / 验收不通过 / 申诉 / 裁决 ==');
  const started = await api('POST', `/m3/work-orders/${woId}/start`, maint);
  check('开工成功', started.status < 300 && started.body.status === 'in_progress');
  const completed = await api('POST', `/m3/work-orders/${woId}/complete`, maint);
  check('完工成功', completed.status < 300 && completed.body.status === 'completed');
  const rejected = await api('POST', `/m3/work-orders/${woId}/accept`, student, {
    result: 'fail',
    comment: '左侧座位还是没电',
  });
  check('验收不通过回到维修中', rejected.body.status === 'in_progress' && rejected.body.reopenCount === 1);

  const seatsRejected = await api('GET', `/spaces/${space.id}/seats`, student);
  const stR = new Map(seatsRejected.body.map((x) => [x.id, x.status]));
  check('返工期间座位保持下架', stR.get(s1.id) === 'maintenance' && stR.get(s2.id) === 'maintenance');

  const appeal = await api('POST', `/m3/work-orders/${woId}/appeal`, maint, {
    reason: '已更换插排模块并实测通电，怀疑是设备本身故障',
  });
  check('申诉提交成功', appeal.status < 300, JSON.stringify(appeal.body));

  const resolved = await api('POST', `/m3/work-orders/${woId}/appeal/resolve`, ops, {
    result: 'overturned',
    note: '现场复测电压正常，判定维修合格',
  });
  check(
    '申诉推翻后视同验收通过',
    resolved.body.status === 'accepted' && resolved.body.appealResult === 'overturned',
    JSON.stringify({ s: resolved.body.status, a: resolved.body.appealResult }),
  );
  const seatsFinal = await api('GET', `/spaces/${space.id}/seats`, student);
  const stF = new Map(seatsFinal.body.map((x) => [x.id, x.status]));
  check('座位已恢复可约', stF.get(s1.id) === 'available' && stF.get(s2.id) === 'available');

  console.log('== M3-29 优先级排序 ==');
  const lowWo = await api('POST', '/m3/work-orders', student, {
    title: '低优先：桌椅轻微晃动',
    category: 'furniture',
    priority: 'low',
    targetType: 'other',
  });
  const urgentWo = await api('POST', '/m3/work-orders', student, {
    title: '紧急：配电箱冒烟',
    category: 'electrical',
    priority: 'urgent',
    targetType: 'other',
  });
  const pending = await api('GET', '/m3/work-orders/pending', ops);
  const idxUrgent = pending.body.findIndex((w) => w.id === urgentWo.body.id);
  const idxLow = pending.body.findIndex((w) => w.id === lowWo.body.id);
  check('紧急工单排在低优先之前', idxUrgent >= 0 && idxLow >= 0 && idxUrgent < idxLow, `${idxUrgent} vs ${idxLow}`);
  const urgentHours = (new Date(urgentWo.body.slaDeadline).getTime() - Date.now()) / 3600_000;
  const lowHours = (new Date(lowWo.body.slaDeadline).getTime() - Date.now()) / 3600_000;
  check('优先级影响 SLA 时长', urgentHours < 10 && lowHours > 60, `urgent=${urgentHours.toFixed(1)}h low=${lowHours.toFixed(1)}h`);

  console.log('== M3-27 低分回访 ==');
  const w3 = await api('POST', '/m3/work-orders', student, {
    title: '清洁类：地面未打扫',
    category: 'cleaning',
    targetType: 'other',
  });
  await api('POST', `/m3/work-orders/${w3.body.id}/dispatch`, ops, { assigneeId: maintId });
  await api('POST', `/m3/work-orders/${w3.body.id}/start`, maint);
  await api('POST', `/m3/work-orders/${w3.body.id}/complete`, maint);
  const lowRate = await api('POST', `/m3/work-orders/${w3.body.id}/accept`, student, {
    rating: 2,
    comment: '地还是脏的',
  });
  check('低分触发回访标记', lowRate.body.revisitRequired === true);
  const revisits = await api('GET', '/m3/work-orders/revisits', ops);
  check('回访队列含该工单', revisits.body.some((w) => w.id === w3.body.id));
  const handled = await api('POST', `/m3/work-orders/${w3.body.id}/revisit`, ops, {
    note: '已重新保洁并电话回访',
  });
  check('回访处理成功', handled.body.revisitHandled === true);

  console.log('== M3-28 照片约束 ==');
  const badPhoto = await api('POST', '/m3/work-orders', student, {
    title: '非法照片',
    targetType: 'other',
    photoUrls: ['javascript:alert(1)'],
  });
  check('非法照片地址被拒', badPhoto.status === 400, String(badPhoto.status));
  const tooMany = await api('POST', '/m3/work-orders', student, {
    title: '照片超量',
    targetType: 'other',
    photoUrls: ['https://a/1.jpg', 'https://a/2.jpg', 'https://a/3.jpg', 'https://a/4.jpg'],
  });
  check('超过 3 张被拒', tooMany.status === 400, String(tooMany.status));

  console.log('== 时间线完整性 ==');
  const finalEvents = await api('GET', `/m3/work-orders/${woId}/events`, student);
  const types = finalEvents.body.map((e) => e.type);
  console.log('  事件序列:', types.join(' → '));
  let chained = true;
  for (let i = 1; i < finalEvents.body.length; i++) {
    if (finalEvents.body[i].fromStatus !== finalEvents.body[i - 1].toStatus) chained = false;
  }
  check('时间线首尾相接', chained);

  console.log(`\n结果：${failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`}`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(2);
});
