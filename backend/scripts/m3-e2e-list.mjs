/**
 * M3-16 工单台账端到端验证（真实 HTTP，不打桩）。
 *
 * 覆盖：路由是否真的注册、@Permissions 权限边界、筛选/分页/关键字的实际行为、
 * 非法参数是否 400 而不是 500、以及前端依赖的分页字段是否齐全。
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
  const ops = await login('ops', 'ops123');
  const student = await login('student', 'student123');
  const maintenance = await login('maintenance', 'maint123');
  console.log('  三个角色登录成功');

  console.log('\n== 路由注册与权限边界 ==');
  const all = await api('GET', '/m3/work-orders?pageSize=100', ops);
  check('派单员可访问台账 GET /m3/work-orders', all.status === 200, `实际 ${all.status}`);
  check('返回分页结构 { items, total, page, pageSize }',
    Array.isArray(all.body?.items) &&
      typeof all.body?.total === 'number' &&
      typeof all.body?.page === 'number' &&
      typeof all.body?.pageSize === 'number');

  const studentTry = await api('GET', '/m3/work-orders', student);
  check('学生无权限访问台账（403）', studentTry.status === 403, `实际 ${studentTry.status}`);

  const maintTry = await api('GET', '/m3/work-orders', maintenance);
  check('维修员不能看全部台账（403，只能看 /assignments）', maintTry.status === 403,
    `实际 ${maintTry.status}`);

  const noAuth = await api('GET', '/m3/work-orders');
  check('未认证访问返回 401/403', noAuth.status === 401 || noAuth.status === 403,
    `实际 ${noAuth.status}`);

  // 准备数据：确保库里有可筛选的记录
  console.log('\n== 准备数据 ==');
  const spaces = await api('GET', '/spaces', ops);
  const spaceList = Array.isArray(spaces.body) ? spaces.body : spaces.body?.items ?? [];
  const targetSpace = spaceList[spaceList.length - 1];
  if (!targetSpace) throw new Error('库里没有空间，无法验证');

  // 用 targetType='other' 造数据：挂到空间上会被防重复上报规则（同空间已有未完结工单）拦成 409，
  // 而关键字检索的验证只关心标题/编号能不能命中，不依赖空间归属。
  const seedTitle = `M3-16 验证-${Date.now()}`;
  const created = await api('POST', '/m3/work-orders', student, {
    title: seedTitle,
    description: '用于验证组合筛选与关键字检索',
    category: 'electrical',
    priority: 'high',
    targetType: 'other',
  });
  check('用于验证的工单已创建', created.status === 201 || created.status === 200,
    `实际 ${created.status}`);
  const seedId = created.body?.id;
  const seedNo = created.body?.workOrderNo;

  console.log('\n== 筛选 ==');
  const byStatus = await api('GET', `/m3/work-orders?status=reported`, ops);
  const sameByCount = await api('GET', `/m3/work-orders?status=reported&pageSize=100`, ops);
  check('按状态筛选返回结构与 total 一致',
    sameByCount.body.total === byStatus.body.total &&
      sameByCount.body.items.every((i) => i.status === 'reported'));

  const multi = await api('GET', '/m3/work-orders?status=reported,dispatched&pageSize=100', ops);
  check('逗号分隔多状态筛选：结果只含这两种状态',
    multi.body.items.every((i) => ['reported', 'dispatched'].includes(i.status)) &&
      multi.body.total >= sameByCount.body.total);

  const combo = await api(
    'GET',
    `/m3/work-orders?spaceId=${targetSpace.id}&category=electrical&priority=high&pageSize=100`,
    ops,
  );
  check('空间 + 分类 + 优先级组合筛选命中且全为高优先级',
    combo.body.total >= 1 &&
      combo.body.items.every(
        (i) => i.spaceId === targetSpace.id && i.category === 'electrical' && i.priority === 'high',
      ));

  console.log('\n== 关键字 ==');
  const kw = await api('GET', `/m3/work-orders?keyword=${encodeURIComponent(seedTitle)}`, ops);
  check('按标题关键字能搜到目标工单',
    kw.body.total === 1 && kw.body.items[0]?.id === seedId, `实际 total=${kw.body.total}`);

  const kwNo = await api('GET', `/m3/work-orders?keyword=${encodeURIComponent(seedNo)}`, ops);
  check('按工单号也能搜到', kwNo.body.total >= 1);

  const kwWildcard = await api('GET', '/m3/work-orders?keyword=%25', ops);
  check('搜索 % 不返回全量（LIKE 通配符已转义）',
    kwWildcard.status === 200 && kwWildcard.body.total === 0,
    `实际 total=${kwWildcard.body.total}`);

  console.log('\n== 分页 ==');
  const p1 = await api('GET', '/m3/work-orders?page=1&pageSize=2', ops);
  const p2 = await api('GET', '/m3/work-orders?page=2&pageSize=2', ops);
  check('首页返回 2 条且 page/pageSize 回显正确',
    p1.body.items.length === 2 && p1.body.page === 1 && p1.body.pageSize === 2);
  check('第二页与首页不重叠',
    p2.body.items.length > 0 &&
      !p1.body.items.some((a) => p2.body.items.some((b) => b.id === a.id)));

  const bigPage = await api('GET', '/m3/work-orders?page=99999&pageSize=10', ops);
  check('越界页码返回空列表而不是 500',
    bigPage.status === 200 && bigPage.body.items.length === 0 && bigPage.body.total > 0,
    `实际 ${bigPage.status}`);

  const tooBig = await api('GET', '/m3/work-orders?pageSize=9999', ops);
  check('pageSize 超上限被钳到 100', tooBig.body.pageSize === 100,
    `实际 ${tooBig.body.pageSize}`);

  console.log('\n== 非法参数：一律 400，不能 500 ==');
  for (const [label, qs] of [
    ['未知状态', 'status=not_a_status'],
    ['未知分类', 'category=BOGUS'],
    ['未知优先级', 'priority=SUPER'],
    ['非法时间', 'from=昨天'],
    ['起始晚于结束', 'from=2026-10-02&to=2026-10-01'],
    ['page 非整数', 'page=abc'],
    ['pageSize 非整数', 'pageSize=abc'],
    ['spaceId 非整数', 'spaceId=x'],
  ]) {
    const r = await api('GET', `/m3/work-orders?${qs}`, ops);
    check(`${label} → 400（不是 500）`, r.status === 400, `实际 ${r.status}`);
  }

  console.log('\n== 排序 ==');
  const asc = await api('GET', '/m3/work-orders?sort=createdAsc&pageSize=100', ops);
  const desc = await api('GET', '/m3/work-orders?sort=createdDesc&pageSize=100', ops);
  const firstAscId = asc.body.items[0]?.id;
  const lastDescId = desc.body.items[desc.body.items.length - 1]?.id;
  check('createdAsc 与 createdDesc 顺序相反', firstAscId === lastDescId,
    `asc首=${firstAscId} desc末=${lastDescId}`);

  const sla = await api('GET', '/m3/work-orders?sort=slaAsc&pageSize=100', ops);
  const nullFirst = sla.body.items.length > 0 && sla.body.items[0].slaDeadline == null;
  check('slaAsc 下无时限的工单不占据首位', !nullFirst);

  console.log(`\n${failed === 0 ? '✅ 全部通过' : `❌ ${failed} 项失败`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('脚本异常：', e.message);
  process.exit(1);
});
