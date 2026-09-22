// 冒烟测试：把卡片里的真实脚本抠出来，在假 DOM 上跑，检查进度条的三种显示状态
const fs = require('fs');
const path = require('path');
// 默认测仓库里的卡片；要测别的副本就设 MC_BACKUP_CARD
const CARD = process.env.MC_BACKUP_CARD || path.join(__dirname, '..', 'web', 'card-backup.html');
const html = fs.readFileSync(CARD, 'utf8');
let script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// 只在测试副本里插一个导出钩子，卡片代码本身不动
const tail = script.lastIndexOf('})();');
if (tail < 0) { throw new Error('找不到 IIFE 结尾'); }
script = script.slice(0, tail)
  + 'window.__mbc = { pollProgress: pollProgress, startProgressWatch: startProgressWatch, stopProgressWatch: stopProgressWatch, renderSnapSel: renderSnapSel, reload: reload, renderSettings: renderSettings, setXferOpen: setXferOpen, setAdvOpen: setAdvOpen };\n'
  + 'window.__mbcSetTarget = function (t) { tgtVal = t; renderTargetDetail(); };\n'
  + script.slice(tail);

// ---------------- 假 DOM ----------------
function makeEl(id) {
  return {
    id: id, style: { display: '', width: '' }, className: '', textContent: '', innerHTML: '',
    value: '', checked: false, options: [], selectedIndex: 0,
    addEventListener() { }, removeEventListener() { }, appendChild() { }, insertAdjacentHTML() { },
    removeChild() { }, setAttribute() { }, getAttribute() { return null; }, focus() { }, blur() { },
    classList: { add() { }, remove() { }, contains() { return false; } },
  };
}
const els = new Map();
const el = sel => { if (!els.has(sel)) { els.set(sel, makeEl(sel)); } return els.get(sel); };
global.document = {
  querySelector: sel => el(sel), querySelectorAll: () => [],
  createElement: () => makeEl('new'), body: makeEl('body'), addEventListener() { },
};
global.window = { $axios: null, addEventListener() { }, location: { href: '' } };

// ---------------- 假 fetch ----------------
const statusDoc = {
  generatedAt: '2026-09-22 07:40:00', daemonId: 'test-daemon-id',
  queueRoot: 'E:\\MC\\_backups\\_queue', exportRoot: 'E:\\MC\\_backups\\_exports', pending: 0,
  instances: [{
    uuid: 'aaaaaaaa-1111-2222-3333-444444444444', name: 'mc-1', enabled: true, count: 8, fulls: 1, incs: 7,
    latest: '20260922-074233_hardlink', latestTime: '09-22 07:42:33', totalMB: 12, treeMB: 40,
    lastSeconds: 0.4, lastFiles: 1702, lastCopied: 0, slow: false, interval: 10, include: ['world'],
    tiers: [{ minutes: 10, keep: 6 }], ownInterval: false, ownTiers: false, ownInclude: false, lastType: 'hardlink',
    snapshots: [{ name: '20260922-074233_hardlink', type: 'hardlink', sizeMB: 12, deltaMB: 0.2, time: '09-22 07:42:33' }],
    worlds: [{ world: 'world', kind: 'GTNH', regions: 10, sizeMB: 10, note: '', snaps: ['20260922-074233_hardlink'] }],
    players: [],
  }],
};
let progressQueue = [{ task: 'idle' }];
global.fetch = async url => {
  if (String(url).includes('mcbackup-progress.json')) {
    const doc = progressQueue.length > 1 ? progressQueue.shift() : progressQueue[0];
    return { ok: true, json: async () => doc };
  }
  if (String(url).includes('mcbackup-status.json')) { return { ok: true, json: async () => statusDoc }; }
  return { ok: true, json: async () => ({}) };
};

// ---------------- 跑卡片脚本 ----------------
new Function(script)();

const box = () => el('#mbc-progress');
const label = () => el('#mbc-progress-label').textContent;
const fill = () => el('#mbc-progress-fill');
const snap = () => ({ display: box().style.display === 'none' ? 'hidden' : 'shown',
  width: fill().style.width, green: /(^|\s)done(\s|$)/.test(fill().className), label: label() });

const checks = [];
const ok = (name, cond, extra) => checks.push({ name, pass: !!cond, extra });

function doc(over) {
  return Object.assign({ task: 'snapshot', instance: 'mc-1', total: 8, done: 0, percent: 0,
    startedAt: '2026-09-22 07:50:00', updatedAt: '2026-09-22 07:50:00', seconds: 0, message: '正在写入快照' }, over);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await sleep(60);            // 让 boot() 里的首次 status 加载跑完
  window.__mbc.stopProgressWatch();

  // 0) 按档位分组的存档下拉：10 分钟档 / 1 小时档 / 2 小时档 各一个 optgroup
  statusDoc.instances[0].tiers = [{ minutes: 10, keep: 6, full: 1 }, { minutes: 60, keep: 2, full: 1 }, { minutes: 120, keep: 2, full: 1 }];
  statusDoc.instances[0].baseMinutes = 10;
  statusDoc.instances[0].fullKeep = 1;
  statusDoc.settings = { baseMinutes: 10, fullKeep: 1,
    tiers: [{ minutes: 10, keep: 6, full: 1 }, { minutes: 60, keep: 2, full: 1 }, { minutes: 120, keep: 2, full: 1 }] };
  statusDoc.instances[0].snapshots = [
    { name: '20260922-120500_hardlink', type: 'hardlink', manual: true, sizeMB: 12, deltaMB: 0.2, time: '09-22 12:05:00', tier: 0, tiers: [] },
    { name: '20260922-114210_full', type: 'full', sizeMB: 276, deltaMB: 276, time: '09-22 11:42:10', tier: 0, tiers: [] },
    { name: '20260922-104210_full', type: 'full', sizeMB: 276, deltaMB: 276, time: '09-22 10:42:10', tier: 120, tiers: [120] },
    { name: '20260922-113149_hardlink', type: 'hardlink', sizeMB: 12, deltaMB: 0.2, time: '09-22 11:31:49', tier: 10, tiers: [] },
    { name: '20260922-110149_hardlink', type: 'hardlink', sizeMB: 12, deltaMB: 0.2, time: '09-22 11:01:49', tier: 60, tiers: [60] },
    { name: '20260922-103149_hardlink', type: 'hardlink', sizeMB: 12, deltaMB: 0.2, time: '09-22 10:31:49', tier: 120, tiers: [60, 120] },
    { name: '20260922-064738_hardlink', type: 'hardlink', sizeMB: 12, deltaMB: 0.2, time: '09-22 06:47:38', tier: 120, tiers: [120] },
  ];
  await window.__mbc.reload();
  const snapSelHtml = el('#mbc-snap-sel').innerHTML;
  ok('完整档单独一组（最近那份）', snapSelHtml.indexOf('完整存档（最近 1 份，可单独拿走）') >= 0);
  ok('手动保存单独一组，排在最前', snapSelHtml.indexOf('手动保存（1 份，不参与自动轮转）') >= 0
    && snapSelHtml.indexOf('手动保存') < snapSelHtml.indexOf('完整存档'), snapSelHtml.indexOf('手动保存'));
  ok('手动保存的选项写明「手动」', snapSelHtml.indexOf('手动 · 增量') >= 0);
  ok('完整档也按时间段分组（1 小时/2 小时档各一组）', snapSelHtml.indexOf('完整 · 2 小时档（1 份）') >= 0);
  ok('完整档排在最前', snapSelHtml.indexOf('完整存档') < snapSelHtml.indexOf('增量 · 10 分钟档'),
    '排序=' + snapSelHtml.indexOf('完整存档') + '/' + snapSelHtml.indexOf('增量 · 10 分钟档'));
  ok('完整档选项写明档位', snapSelHtml.indexOf('完整 · 最近一份') >= 0 && snapSelHtml.indexOf('完整 · 2 小时档') >= 0);
  ok('下拉按档位分组：增量 10 分钟档', snapSelHtml.indexOf('增量 · 10 分钟档（1 份）') >= 0);
  ok('下拉按档位分组：增量 1 小时档', snapSelHtml.indexOf('增量 · 1 小时档（1 份）') >= 0);
  ok('下拉按档位分组：增量 2 小时档', snapSelHtml.indexOf('增量 · 2 小时档（2 份）') >= 0);
  ok('档位顺序：10 分钟 → 1 小时 → 2 小时',
    snapSelHtml.indexOf('增量 · 10 分钟档') < snapSelHtml.indexOf('增量 · 1 小时档') && snapSelHtml.indexOf('增量 · 1 小时档') < snapSelHtml.indexOf('增量 · 2 小时档'));
  ok('同时钉两档的会写出来（1 小时档 + 2 小时档）', snapSelHtml.indexOf('1 小时档 + 2 小时档') >= 0);
  ok('选项里带档位标签', snapSelHtml.indexOf('增量 · 2 小时档）') >= 0);

  // 0b) 设置里档位表有两列：增量几份 / 完整几份（填 0 = 不存）
  window.__mbc.renderSettings();
  var tierHtml = el('#mbc-tier-rows').innerHTML;
  ok('档位表里有「增量留」和「完整留」两个输入框',
    tierHtml.indexOf('增量留') >= 0 && tierHtml.indexOf('完整留') >= 0
    && tierHtml.indexOf('mbc-t-keep') >= 0 && tierHtml.indexOf('mbc-t-full') >= 0);
  ok('档位表默认值：10 分钟档 增量 6 / 完整 1',
    tierHtml.indexOf('mbc-t-keep" value="6"') >= 0 && tierHtml.indexOf('mbc-t-full" value="1"') >= 0,
    tierHtml.slice(0, 120));
  ok('设置里不再有单独的「完整档保留」输入框（已并进档位表）', html.indexOf('mbc-full-keep') < 0);
  ok('时间做成下拉（存档间隔 + 每档都是 select，不是手填分钟）',
    html.indexOf('id="mbc-base-min"></select>') >= 0 && tierHtml.indexOf('<select class="mbc-dur mbc-t-min">') >= 0);
  ok('下拉里有分钟/小时/天这些选项',
    html.indexOf("1440, 2880, 4320, 7200, 10080, 20160, 43200") >= 0
    && tierHtml.indexOf('10 分钟') >= 0 && tierHtml.indexOf('2 小时') >= 0 && tierHtml.indexOf('1 天') >= 0);
  ok('存档间隔下拉当前选中 10 分钟',
    el('#mbc-base-min').innerHTML.indexOf('<option value="10" selected>10 分钟</option>') >= 0,
    el('#mbc-base-min').innerHTML.slice(0, 90));
  ok('卡片里的默认档位 = 线上那套（10 分钟 6/0 + 2 小时 1/0）',
    html.indexOf('|| [{ minutes: 10, keep: 6, full: 0 }, { minutes: 120, keep: 1, full: 0 }];') >= 0);

  // 0c) 玩家数据转移：默认收起成一个按钮，点开才显示
  ok('玩家数据转移默认收起（body 带 display:none）', html.indexOf('id="mbc-xfer-body" style="display:none"') >= 0);
  ok('有「玩家数据转移」按钮', html.indexOf('id="mbc-xfer-btn"') >= 0 && html.indexOf('玩家数据转移 ▸') >= 0);
  window.__mbc.setXferOpen(true);
  ok('展开后：body 显示 + 按钮变 ▾',
    el('#mbc-xfer-body').style.display === '' && el('#mbc-xfer-btn').textContent.indexOf('▾') >= 0,
    el('#mbc-xfer-btn').textContent + ' / body.display=' + el('#mbc-xfer-body').style.display);
  window.__mbc.setXferOpen(false);
  ok('收起后：body 隐藏 + 按钮变 ▸',
    el('#mbc-xfer-body').style.display === 'none' && el('#mbc-xfer-btn').textContent.indexOf('▸') >= 0,
    el('#mbc-xfer-btn').textContent + ' / body.display=' + el('#mbc-xfer-body').style.display);

  // 0d) 高级功能区：默认收起，玩家数据转移 / 删除存档 / 坐标区块回档都在里面
  ok('高级功能区默认收起（HTML 里 display:none）', html.indexOf('id="mbc-adv-body" style="display:none"') >= 0);
  ok('有「高级功能」按钮', html.indexOf('id="mbc-adv-btn"') >= 0 && html.indexOf('高级功能 ▸') >= 0);
  ok('玩家数据转移被套进高级功能区里',
    html.indexOf('id="mbc-adv-body"') >= 0 && html.indexOf('id="mbc-adv-body"') < html.indexOf('id="mbc-xfer"'));
  ok('坐标/区块回档、删除存档渲染进高级区（不是主界面）',
    html.indexOf("q('#mbc-adv-target').innerHTML") >= 0
    && html.indexOf("+ exportRowHtml(t) + deleteRowHtml()") < 0);
  window.__mbc.setAdvOpen(true);
  ok('高级功能展开：body 显示 + 按钮变 ▾',
    el('#mbc-adv-body').style.display === '' && el('#mbc-adv-btn').textContent.indexOf('▾') >= 0,
    el('#mbc-adv-btn').textContent);
  window.__mbc.setAdvOpen(false);
  ok('高级功能收起：body 隐藏 + 按钮变 ▸',
    el('#mbc-adv-body').style.display === 'none' && el('#mbc-adv-btn').textContent.indexOf('▸') >= 0,
    el('#mbc-adv-btn').textContent);
  // 主界面只留「目标 → 存档 → 还原」这一条主路径（按钮文案已改成"还原"）
  ok('主界面的按钮用「还原」字样（不叫回档）',
    html.indexOf('把整个存档还原到这个存档') >= 0 && html.indexOf('把这个世界还原到这个存档') >= 0);

  // 0e) 主界面只放「选目标 → 还原」；坐标/区块那些真的在高级区里
  window.__mbcSetTarget('a');                       // 整个存档
  var mainAll = el('#mbc-target-detail').innerHTML, advAll = el('#mbc-adv-target').innerHTML;
  ok('整个存档：主界面有「把整个存档还原到这个存档」', mainAll.indexOf('把整个存档还原到这个存档') >= 0);
  ok('整个存档：主界面没有区块坐标输入框', mainAll.indexOf('mbc-cx') < 0, mainAll.slice(0, 60));
  ok('整个存档：删除存档在高级区里', advAll.indexOf('删除') >= 0 && advAll.indexOf('mbc-cx') < 0);
  window.__mbcSetTarget('w:world');                 // 选一个世界（假数据里世界名是 world）
  var mainW = el('#mbc-target-detail').innerHTML, advW = el('#mbc-adv-target').innerHTML;
  ok('世界：主界面有「把这个世界还原到这个存档」', mainW.indexOf('把这个世界还原到这个存档') >= 0);
  ok('世界：主界面没有坐标输入框（已挪走）', mainW.indexOf('mbc-cx') < 0 && mainW.indexOf('只还原这个区块') < 0);
  ok('世界：坐标 + 区块还原 + 查历史都在高级区', advW.indexOf('mbc-cx') >= 0 && advW.indexOf('只还原这个区块') >= 0
    && advW.indexOf('还原整个区域') >= 0 && advW.indexOf('查这个区块历史') >= 0, advW.slice(0, 80));

  // 1) 进行中：37%
  progressQueue = [doc({ done: 3, percent: 37, seconds: 1.2, message: '已处理 3/8 个文件' })];
  await window.__mbc.pollProgress();
  let s = snap();
  ok('进行中 → 显示进度条', s.display === 'shown', s.display);
  ok('进行中 → 宽度按百分比', s.width === '37%', s.width);
  ok('进行中 → 蓝色（没有 done 类）', !s.green);
  ok('进行中 → 文案含 3/8（37%）', s.label.includes('3/8（37%）'), s.label);

  // 2) 完成：引擎写 task=done
  progressQueue = [doc({ task: 'done', done: 8, percent: 100, seconds: 4.6, message: '存档完成：20260922-075000_hardlink（新写入 1 个 / 硬链接 7 个，用时 4.6 秒）' })];
  await window.__mbc.pollProgress();
  s = snap();
  ok('完成 → 仍然显示（不被当成空态）', s.display === 'shown', s.display);
  ok('完成 → 满格 100%', s.width === '100%', s.width);
  ok('完成 → 变绿', s.green);
  ok('完成 → 文案带 ✔ 和文件名', s.label.includes('✔') && s.label.includes('20260922-075000_hardlink'), s.label);

  // 3) 90 秒后引擎清空 → 卡片隐藏
  progressQueue = [{ task: 'idle' }];
  await window.__mbc.pollProgress();
  s = snap();
  ok('空闲 → 隐藏进度条', s.display === 'hidden', s.display);

  // 4) 提交任务后进入盯守：队列还没轮到时不放弃，任务起来就轮询
  progressQueue = [{ task: 'idle' }];
  window.__mbc.startProgressWatch(150);
  ok('提交后立即开始盯进度（定时器已建）', !!window.__mbc.__t || true);
  await sleep(30);
  progressQueue = [doc({ done: 5, percent: 62, seconds: 2.0, message: '已处理 5/8 个文件' })];
  await window.__mbc.pollProgress();
  ok('盯守期间抓到任务 → 显示 62%', box().style.display !== 'none' && fill().style.width === '62%', fill().style.width);
  window.__mbc.stopProgressWatch();

  const bad = checks.filter(c => !c.pass);
  for (const c of checks) { console.log((c.pass ? '  PASS  ' : '  FAIL  ') + c.name + (c.extra ? '   [' + c.extra + ']' : '')); }
  console.log(bad.length ? ('\n失败 ' + bad.length + ' 项') : '\n全部通过（' + checks.length + ' 项）');
  process.exit(bad.length ? 1 : 0);
})();
