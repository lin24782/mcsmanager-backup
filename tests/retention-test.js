// 分档保留对比：现在的「按间隔回填」 vs 改后的「按自然时间段钉住」
const fs = require('fs');
const path = require('path');
const os = require('os');
const ENGINE = process.env.MC_BACKUP_ENGINE || path.join(__dirname, '..', 'src', 'mc-backup.js');
const TMP = process.env.MC_BACKUP_TMP || os.tmpdir();
// 引擎在加载时会读配置；这里现造一份最小配置，测试不依赖任何本机现有安装
const CFG = path.join(TMP, 'mbc-retention-cfg.json');
fs.writeFileSync(CFG, JSON.stringify({
  panelUrl: 'http://127.0.0.1:9',
  backupRoot: path.join(TMP, 'mbc-retention-backups'),
  statusFile: path.join(TMP, 'mbc-retention-status.json'),
  exportRoot: path.join(TMP, 'mbc-retention-exports'),
  instances: []
}, null, 2));

// ---- 现在线上的算法（从 mc-backup.js 原样抄出来，便于对比）----
function planOld(desc, tiers, base) {
  const tol = Math.max(1, Math.ceil(base / 2));
  const keep = new Set([desc[0].name]);
  for (const t of tiers.slice().sort((a, b) => b.minutes - a.minutes)) {
    let picked = 0, last = null;
    const needGap = t.minutes > base;
    for (const s of desc) {
      if (picked >= t.keep) break;
      const gapOk = !needGap || !last || (new Date(last) - new Date(s.createdAt)) / 60000 >= (t.minutes - tol);
      if (gapOk) { keep.add(s.name); picked++; last = s.createdAt; }
    }
  }
  return keep;
}

// ---- 从引擎源码里抠出改后的 planRetention（不跑入口那段）----
function loadNew() {
  let src = fs.readFileSync(ENGINE, 'utf8');
  if (src.startsWith('#!')) { src = src.slice(src.indexOf('\n') + 1); }   // 去掉 shebang，new Function 不认
  const cut = src.lastIndexOf('(async () => {');
  const body = src.slice(0, cut)
    + '\nreturn { planRetention: planRetention, timeBlock: timeBlock, retentionPlanAll: retentionPlanAll, instFullKeep: instFullKeep, cfg: cfg };\n';
  const argvBak = process.argv.slice();
  process.argv = ['node', 'mc-backup.js', 'status', '--config', CFG];
  const fn = new Function('require', 'process', '__dirname', 'module', 'exports', body);
  const out = fn(require, process, path.dirname(ENGINE), { exports: {} }, {});
  process.argv = argvBak;
  return out;
}

// 造一条 24 小时的时间线：每 10 分钟一份快照
function timeline(hours, stepMin, startLocal) {
  const out = [];
  const start = new Date(startLocal).getTime();
  for (let m = 0; m <= hours * 60; m += stepMin) {
    const d = new Date(start + m * 60000);
    const pad = n => String(n).padStart(2, '0');
    out.push({
      name: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_hardlink`,
      createdAt: d.toISOString(),
      when: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      type: 'hardlink',
    });
  }
  return out.reverse();   // 新 → 旧
}

const tiers = [{ minutes: 10, keep: 6 }, { minutes: 60, keep: 2 }, { minutes: 120, keep: 2 }];
const desc = timeline(24, 10, '2026-09-21T09:02:00');   // 从昨天 09:02 开始，一整天
const api = loadNew();

const byName = new Map(desc.map(s => [s.name, s]));
const show = set => [...set].map(n => byName.get(n).when).sort().join(' ');

const oldKeep = planOld(desc, tiers, 10);
const plan = api.planRetention(desc, tiers, 10);

console.log('时间线：24 小时，每 10 分钟一份，共 ' + desc.length + ' 份');
console.log('分档：10 分钟 6 份 + 1 小时 2 份 + 2 小时 2 份\n');
console.log('【现在的算法】留下 ' + oldKeep.size + ' 份：');
console.log('  ' + show(oldKeep));
console.log('【改后的算法】留下 ' + plan.keep.size + ' 份：');
console.log('  ' + show(plan.keep));
console.log('  档位标记：');
for (const [name, min] of [...plan.tierOf].sort((a, b) => byName.get(a[0]).when.localeCompare(byName.get(b[0]).when))) {
  console.log('    ' + byName.get(name).when + ' → ' + min + ' 分钟档');
}

// 关键对比：只加 1 份新快照（10 分钟后那一份），看各自会把谁顶掉
function addOne(list, atLocal) {
  const d = new Date(atLocal);
  const pad = n => String(n).padStart(2, '0');
  const s = {
    name: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_hardlink`,
    createdAt: d.toISOString(), when: `${pad(d.getHours())}:${pad(d.getMinutes())}`, type: 'hardlink',
  };
  byName.set(s.name, s);
  return [s, ...list];
}
const desc2 = addOne(desc, '2026-09-22T09:12:00');
const old2 = planOld(desc2, tiers, 10);
const plan2 = api.planRetention(desc2, tiers, 10);
const drop = (before, after) => [...(before.keep || before)].filter(n => !(after.keep || after).has(n)).map(n => byName.get(n).when);
console.log('\n只加一份新快照（09:12）后会顶掉哪些：');
console.log('  现在的算法顶掉：' + (drop(oldKeep, old2).join(' ') || '无'));
console.log('  改后的算法顶掉：' + (drop(plan, plan2).join(' ') || '无'));
console.log('  改后的算法里，小时/2 小时档锚点是否都还在：'
  + [...plan.tierOf.keys()].every(n => plan2.keep.has(n)));

// 长跑测试：3 天时间线，看保留份数是否收敛在预期范围
const longDesc = timeline(72, 10, '2026-09-19T09:02:00');
const longPlan = api.planRetention(longDesc, tiers, 10);
const cnt = m => [...longPlan.tierOf.values()].filter(v => v === m).length;
console.log('\n跑满 3 天后：共留 ' + longPlan.keep.size + ' 份（10 分钟档 6 + 1 小时档 '
  + cnt(60) + ' + 2 小时档 ' + cnt(120) + '）');

// ---- 完整档 / 增量档 分开：完整档只留 1 份，且不占增量的时间段 ----
function withFulls(list, fullAtLocal) {
  const out = list.map(s => Object.assign({}, s, { format: s.type === 'full' ? 'full' : 'hardlink' }));
  for (const t of fullAtLocal) {
    const d = new Date(t);
    const pad = n => String(n).padStart(2, '0');
    const name = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_full`;
    out.push({ name: name, createdAt: d.toISOString(), when: `${pad(d.getHours())}:${pad(d.getMinutes())}`, type: 'full', format: 'full' });
  }
  return out.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
const mixed = withFulls(timeline(6, 10, '2026-09-22T09:02:00'),
  ['2026-09-22T09:30:00', '2026-09-22T11:20:00', '2026-09-22T14:50:00']);
const byName2 = new Map(mixed.map(s => [s.name, s]));
// 这组专门验「完整档也按时间段分」，所以显式给一份每个档位完整留 1 的档位表（不依赖配置文件里的默认值）
const mixedPlan = api.retentionPlanAll({
  tiers: [{ minutes: 10, keep: 6, full: 1 }, { minutes: 60, keep: 2, full: 1 }, { minutes: 120, keep: 2, full: 1 }]
}, mixed);
const keptFulls = mixed.filter(s => s.type === 'full' && mixedPlan.keep.has(s.name));
const keptIncs = mixed.filter(s => s.type !== 'full' && mixedPlan.keep.has(s.name));
console.log('\n完整档 / 增量档 分开（3 份完整 + 37 份增量，档位表里完整都填 1 份）：');
console.log('  保留的完整档：' + keptFulls.map(s => s.when).join(' ') + '（最近 1 份 + 1 小时档 + 2 小时档，三段不同时间）');
console.log('  完整档分档：' + [...mixedPlan.fullTierOf].map(([n, m]) => byName2.get(n).when + '→' + (m || '最近') + '分钟档').join(' '));
console.log('  保留的增量档：' + keptIncs.length + ' 份 → ' + keptIncs.map(s => s.when).join(' '));
const incAnchors = [...mixedPlan.tierOf.keys()].filter(n => byName2.get(n).type !== 'full');
console.log('  增量锚点是否都在：' + incAnchors.every(n => mixedPlan.keep.has(n)));
console.log('  完整档按档位表保留（1~3 份且时间不同）：' + (keptFulls.length >= 1 && keptFulls.length <= 3));
