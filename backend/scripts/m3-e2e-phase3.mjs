/**
 * M3 三期能力端到端验证脚本（真实 HTTP，不打桩）。
 *
 * 覆盖：挂起两级确认（申请/确认/恢复）、重复上报 409 带主线 id、
 * 合并上报、完工必填维修说明、统计看板与口径字段、新端点的权限边界。
 *
 * 为什么要单独跑这一遍：单元测试用 TestingModule 直接调 Service，
 * 绕过了路由注册、DTO 校验与 @Permissions 装饰器 —— 这三处恰恰是最容易
 * 「代码写了但线上没生效」的地方（历史上 D1 就出过控制器未注册、全部 404 的事故）。
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

async function main() {
  console.log('== 登录 ==');
  const admin = await login('admin', 'admin123');
  const ops = await login('ops', 'ops123');
  const worker = await login('maintenance', 'maint123');
  const student = await login('student', 'student123');
  console.log('  四个账号登录成功');

  // 找一个当前没有未完结工单的座位（老库里有演示数据，可能撞 409）
  console.log('\n== 选一个干净座位 ==');
  const spaces = (await api('GET', '/spaces', admin)).body;
  let seat = null;
  let first = null;
  outer: for (const sp of spaces) {
    const seats = (await api('GET', `/spaces/${sp.id}/seats`, admin)).body;
    for (const s of Array.isArray(seats) ? seats : []) {
      const r = await api('POST', '/m3/work-orders', student, {
        title: '三期端到端：灯具闪烁',
        description: '用于验证挂起与合并流程',
        category: 'electrical',
        priority: 'high',
        targetType: 'seat',
        targetId: s.id,
        spaceId: sp.id,
      });
      if (r.status < 300) {
        seat = s;
        first = r.body;
        break outer;
      }
      if (r.status !== 409) throw new Error(`上报异常 ${r.status}: ${JSON.stringify(r.body)}`);
    }
  }
  check('找到空闲座位并成功上报首张工单', !!first, seat ? '' : '全部座位都有未完结工单');
  if (!first) return;

  check('首张工单进入 reported', first.status === 'reported', first.status);
  check('上报即写入原始解决时限', !!first.originalSlaDeadline);
  const slaH = (new Date(first.originalSlaDeadline) - new Date(first.createdAt)) / 3600_000;
  check('SLA = 分类基线 24h × 高优先级 0.6 ≈ 14h', Math.abs(slaH - 14) < 1, `实测 ${slaH.toFixed(1)}h`);
  check('座位已下架', first.seatIdList.includes(seat.id), JSON.stringify(first.seatIdList));

  // ===== 重复上报 409 =====
  console.log('\n== 重复上报判重 ==');
  const dup = await api('POST', '/m3/work-orders', student, {
    title: '三期端到端：灯具闪烁（重复报）',
    category: 'electrical',
    priority: 'high',
    targetType: 'seat',
    targetId: seat.id,
    spaceId: seat.spaceId,
  });
  check('同座位再报返回 409', dup.status === 409, String(dup.status));
  check('409 携带 existingWorkOrderId', dup.body?.existingWorkOrderId === first.id, JSON.stringify(dup.body));
  check('409 携带主线工单号', dup.body?.existingWorkOrderNo === first.workOrderNo);

  // ===== 合并上报 =====
  console.log('\n== 合并上报 ==');
  const merged = await api('POST', '/m3/work-orders', student, {
    title: '三期端到端：灯具闪烁（合并）',
    category: 'electrical',
    priority: 'high',
    targetType: 'seat',
    targetId: seat.id,
    spaceId: seat.spaceId,
    mergeIntoId: first.id,
  });
  check('带 mergeIntoId 提交成功', merged.status < 300, `${merged.status} ${JSON.stringify(merged.body?.message ?? '')}`);
  check('落为 merged', merged.body?.status === 'merged', merged.body?.status);
  check('指向主线', merged.body?.mergedIntoId === first.id);
  check('合并单无独立时限', merged.body?.slaDeadline === null);

  const detailMain = await api('GET', `/m3/work-orders/${first.id}`, ops);
  check('主线记录吸收数 +1', detailMain.body?.mergedCount === 1, String(detailMain.body?.mergedCount));
  const mainEvents = (await api('GET', `/m3/work-orders/${first.id}/events`, ops)).body;
  check(
    '主线时间线出现 merge_absorbed',
    mainEvents.some((e) => e.type === 'merge_absorbed'),
  );
  const mergedEvents = (await api('GET', `/m3/work-orders/${merged.body.id}/events`, student)).body;
  check('合并单时间线出现 merged', mergedEvents.some((e) => e.type === 'merged'));

  // ===== 派单 → 开工 =====
  console.log('\n== 派单与开工 ==');
  const workerId = (await api('GET', '/users?page=1&pageSize=50', admin)).body.items.find(
    (u) => u.username === 'maintenance',
  ).id;
  const d = await api('POST', `/m3/work-orders/${first.id}/dispatch`, ops, { assigneeId: workerId });
  check('派单成功', d.status < 300 && d.body.status === 'dispatched', `${d.status} ${d.body?.status}`);
  const st = await api('POST', `/m3/work-orders/${first.id}/start`, worker);
  check('开工成功', st.status < 300 && st.body.status === 'in_progress', st.body?.status);
  check('首响时刻已记录', !!st.body.firstRespondedAt);

  // ===== 挂起：申请阶段不停表 =====
  console.log('\n== 挂起两级确认 ==');
  const deadlineBefore = st.body.slaDeadline;
  const req = await api('POST', `/m3/work-orders/${first.id}/hold`, worker, { reason: '等厂家配件' });
  check('维修员可申请挂起', req.status < 300, `${req.status} ${JSON.stringify(req.body?.message ?? '')}`);
  check('申请阶段状态不变（仍 in_progress）', req.body?.status === 'in_progress', req.body?.status);
  check('申请阶段解决时限不变', req.body?.slaDeadline === deadlineBefore);
  check('申请标记已置位', req.body?.holdRequested === true);

  const holdsBefore = (await api('GET', '/m3/work-orders/holds', ops)).body;
  check(
    '派单员可在待确认列表看到该工单',
    holdsBefore.requests.some((w) => w.id === first.id),
    JSON.stringify(holdsBefore.requests.map((w) => w.id)),
  );

  // 派单员确认前，SLA 仍在计时：把时限调不了，改为验证状态未变已足够
  const conf = await api('POST', `/m3/work-orders/${first.id}/hold/confirm`, ops, { approve: true });
  check('派单员确认成功', conf.status < 300, `${conf.status} ${JSON.stringify(conf.body?.message ?? '')}`);
  check('状态置 on_hold', conf.body?.status === 'on_hold', conf.body?.status);
  check('记录挂起起始时刻', !!conf.body?.onHoldSince);
  check('记录挂起前状态', conf.body?.preHoldStatus === 'in_progress', conf.body?.preHoldStatus);

  const seatsNow = (await api('GET', `/spaces/${seat.spaceId}/seats`, admin)).body;
  const thisSeat = seatsNow.find((s) => s.id === seat.id);
  check('挂起期间座位仍为 maintenance', thisSeat?.status === 'maintenance', thisSeat?.status);
  check('挂起期间座位来源仍为 M3', thisSeat?.statusSource === 'M3', String(thisSeat?.statusSource));

  // ===== 恢复：时限顺延 =====
  console.log('\n== 恢复维修 ==');
  const resume = await api('POST', `/m3/work-orders/${first.id}/resume`, worker);
  check('恢复成功', resume.status < 300, `${resume.status} ${JSON.stringify(resume.body?.message ?? '')}`);
  check('回到挂起前状态', resume.body?.status === 'in_progress', resume.body?.status);
  check('挂起起始时刻已清空', resume.body?.onHoldSince === null);
  check(
    '解决时限不早于原时限（顺延或持平）',
    new Date(resume.body.slaDeadline) >= new Date(deadlineBefore),
    `${deadlineBefore} → ${resume.body.slaDeadline}`,
  );
  check(
    '原始时限同步平移',
    new Date(resume.body.originalSlaDeadline) >= new Date(first.originalSlaDeadline),
  );

  // ===== 完工必填维修说明 =====
  console.log('\n== 完工维修说明 ==');
  const noNote = await api('POST', `/m3/work-orders/${first.id}/complete`, worker, {});
  check('缺维修说明返回 400', noNote.status === 400, String(noNote.status));
  const blank = await api('POST', `/m3/work-orders/${first.id}/complete`, worker, { resolutionNote: '   ' });
  check('空白维修说明返回 400', blank.status === 400, String(blank.status));

  const done = await api('POST', `/m3/work-orders/${first.id}/complete`, worker, {
    resolutionNote: '更换灯管 1 支，检查线路接头，通电 30 分钟无闪烁',
    photoUrls: ['https://img.example.com/e2e-after.jpg'],
  });
  check('带说明完工成功', done.status < 300, `${done.status} ${JSON.stringify(done.body?.message ?? '')}`);
  check('状态进入 completed', done.body?.status === 'completed', done.body?.status);
  check('维修说明已入档', (done.body?.resolutionNote ?? '').includes('更换灯管'));
  check('完工照片已追加', (done.body?.photoUrlList ?? []).length >= 1);

  const reporterView = await api('GET', `/m3/work-orders/${first.id}`, student);
  check('上报人详情可见维修说明', (reporterView.body?.resolutionNote ?? '').includes('更换灯管'));

  // ===== 统计看板 =====
  console.log('\n== 统计看板 ==');
  const stats = await api('GET', '/m3/work-orders/stats', admin);
  check('统计接口可用', stats.status === 200, String(stats.status));
  check('返回工单总量', typeof stats.body?.totals?.total === 'number' && stats.body.totals.total > 0, String(stats.body?.totals?.total));
  check('返回完工率', typeof stats.body?.kpi?.completionRate === 'number');
  check('返回 SLA 达标率', typeof stats.body?.kpi?.slaComplianceRate === 'number');
  check('返回平均首响', typeof stats.body?.kpi?.avgResponseHours === 'number');
  check('返回平均解决时长', typeof stats.body?.kpi?.avgResolveHours === 'number');
  check('返回返工率', typeof stats.body?.kpi?.reworkRate === 'number');
  check('返回空间排行', Array.isArray(stats.body?.topSpaces));
  check('返回口径说明 definitions', !!stats.body?.definitions?.slaComplianceRate);
  check(
    '口径说明写明了挂起扣除',
    String(stats.body?.definitions?.avgResolveHours ?? '').includes('挂起'),
  );
  check('统计含本次验证的工单所在空间', stats.body.topSpaces.some((s) => s.spaceId === seat.spaceId));

  const scoped = await api('GET', `/m3/work-orders/stats?spaceId=${seat.spaceId}`, admin);
  check('按空间过滤生效', scoped.body.totals.total <= stats.body.totals.total && scoped.body.totals.total > 0);
  const badRange = await api(
    'GET',
    `/m3/work-orders/stats?from=${new Date().toISOString()}&to=${new Date(Date.now() - 86400000).toISOString()}`,
    admin,
  );
  check('非法时间区间返回 400', badRange.status === 400, String(badRange.status));

  // ===== 权限边界 =====
  console.log('\n== 权限边界 ==');
  const sStats = await api('GET', '/m3/work-orders/stats', student);
  check('学生访问统计返回 403', sStats.status === 403, String(sStats.status));
  const wHolds = await api('GET', '/m3/work-orders/holds', worker);
  check('维修员访问挂起总览返回 403', wHolds.status === 403, String(wHolds.status));
  const sConfirm = await api('POST', `/m3/work-orders/${first.id}/hold/confirm`, student, { approve: true });
  check('学生确认挂起返回 403', sConfirm.status === 403, String(sConfirm.status));

  console.log('\n====================');
  console.log(failed === 0 ? '全部通过 ✅' : `${failed} 项失败 ❌`);
  console.log('验证工单：', first.workOrderNo, '| 合并单：', merged.body?.workOrderNo, '| 座位：', seat.id);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
