// 手动 / 自动 两条链分开：手动增量基于上一份「手动档」增量，自动的只在自动档之间增量
const fs = require('fs');
const path = require('path');
const os = require('os');
const ENGINE = process.env.MC_BACKUP_ENGINE || path.join(__dirname, '..', 'src', 'mc-backup.js');
const TMP = process.env.MC_BACKUP_TMP || os.tmpdir();
const root = path.join(TMP, 'mbc-chain-' + Date.now().toString().slice(-6));
const instDir = path.join(root, 'server');
const CFG = path.join(root, 'c.json');
const uuid = 'bbbbbbb1-2222-4333-8444-555566667777';

function mk(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

for (const f of ['World/level.dat', 'World/region/r.0.0.mca', 'config/a.json', 'server.properties']) {
  mk(path.join(instDir, f), 'DATA-' + f);
}
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({
  panelUrl: 'http://127.0.0.1:9', backupRoot: path.join(root, 'b'), statusFile: path.join(root, 's.json'),
  exportRoot: path.join(root, 'e'), baseMinutes: 10, manualKeep: 20,
  include: ['World', 'config', 'server.properties'],     // 不写的话引擎按空清单处理，快照里啥都没有
  tiers: [{ minutes: 10, keep: 6, full: 0 }, { minutes: 120, keep: 1, full: 0 }],
  instances: [{ uuid, name: 'chain', dir: instDir, enabled: true, notes: {} }]
}, null, 2));

// 把引擎抠出来（不进入口那段），直接调 newSnapshot / snapshotList / prune
let src = fs.readFileSync(ENGINE, 'utf8').replace(/^#!.*\n/, '');
const cut = src.lastIndexOf('(async () => {');
const argvBak = process.argv.slice();
process.argv = ['node', 'x', 'status', '--config', CFG];
const api = new Function('require', 'process', '__dirname', 'module', 'exports',
  src.slice(0, cut) + '\nreturn { newSnapshot: newSnapshot, snapshotList: snapshotList, prune: prune, cfg: cfg };\n')
  (require, process, path.dirname(ENGINE), { exports: {} }, {});
process.argv = argvBak;

const inst = api.cfg.instances[0];
const snaps = () => api.snapshotList(inst);
const byName = n => path.join(root, 'b', 'chain', n, 'meta.json');
const results = [];
const ok = (name, cond, extra) => results.push({ name, pass: !!cond, extra: extra === undefined ? '' : String(extra) });

// ① 自动档
api.newSnapshot(inst, false, false);
let list = snaps();
ok('① 第一份自动档 = 完整复制', list[0].type === 'full', list[0].type + ' / base=' + list[0].baseName);
const auto1 = list[0].name;

// ② 手动档（前面没有手动档 → 接着最新的自动档做增量，**不要**另起一份完整复制）
fs.writeFileSync(path.join(instDir, 'World', 'level.dat'), 'CHANGED-BY-MANUAL');
api.newSnapshot(inst, false, true);
list = snaps();
const manual1 = list.find(s => s.manual);
ok('② 第一份手动档 = 增量（接着最新的自动档，不另起完整复制）',
  manual1 && manual1.type === 'hardlink' && manual1.baseName === auto1, manual1 && (manual1.type + ' / base=' + (manual1.baseName || '（无）')));

// ③ 再来一份自动档：基准必须是自动档（不能跑到手动档上）
fs.writeFileSync(path.join(instDir, 'config', 'a.json'), 'CHANGED-BY-AUTO');
api.newSnapshot(inst, false, false);
list = snaps();
const auto2 = list.filter(s => !s.manual).slice(-1)[0];
ok('③ 自动增量基于上一份自动档', auto2.baseName === auto1, 'base=' + auto2.baseName + '，期望=' + auto1);
ok('③ 自动档不会把手动档当基准', auto2.baseName !== manual1.name, auto2.baseName);

// ④ 再点一次「增量保存」= 刷新这份手动档本身，**不能**多出一份
fs.writeFileSync(path.join(instDir, 'server.properties'), 'CHANGED-BY-MANUAL-2');
const refreshed = api.newSnapshot(inst, false, true);
list = snaps();
const manualsNow = list.filter(s => s.manual);
ok('④ 增量保存不再多出一份（手动档还是 1 份）', manualsNow.length === 1, '手动档 ' + manualsNow.length + ' 份：' + manualsNow.map(s => s.name).join(' '));
ok('④ 刷新的就是原来那份手动档', manualsNow[0] && manualsNow[0].name === manual1.name, manualsNow[0] && manualsNow[0].name);
ok('④ meta 里记了刷新时间/次数', refreshed && refreshed.refreshCount === 1 && !!refreshed.refreshedAt,
  refreshed && ('refreshCount=' + refreshed.refreshCount + ' refreshedAt=' + refreshed.refreshedAt));
const manDir = path.join(root, 'b', 'chain', manual1.name);
ok('④ 变了的文件已经写进这份手动档', fs.readFileSync(path.join(manDir, 'server.properties'), 'utf8') === 'CHANGED-BY-MANUAL-2');
ok('④ 没变的文件还保持原样（世界数据没被重写）', fs.readFileSync(path.join(manDir, 'World', 'level.dat'), 'utf8') === 'CHANGED-BY-MANUAL');

// ④a 源里删掉的文件，刷新后要从手动档里消失
fs.rmSync(path.join(instDir, 'config', 'a.json'), { force: true });
api.newSnapshot(inst, false, true);
ok('④a 源里删掉的文件也从手动档里删掉了', !fs.existsSync(path.join(manDir, 'config', 'a.json')));
ok('④a 刷新后再看还是 1 份手动档', snaps().filter(s => s.manual).length === 1);

// ④b 「全部保存」才是另起一份：强制完整复制，之后的手动增量刷新它
api.newSnapshot(inst, true, true);
list = snaps();
const manualFull = list.filter(s => s.manual).slice(-1)[0];
ok('④b 全部保存 = 另起一份完整复制', manualFull.type === 'full', manualFull.type + ' / base=' + (manualFull.baseName || '（无）'));
ok('④b 现在有 2 份手动档（一份旧的增量 + 这份新的完整）', list.filter(s => s.manual).length === 2, list.filter(s => s.manual).map(s => s.name).join(' '));
fs.writeFileSync(path.join(instDir, 'config', 'a.json'), 'CHANGED-BY-MANUAL-3');
const refreshed2 = api.newSnapshot(inst, false, true);
list = snaps();
ok('④b 之后的手动增量刷新的是这份新的完整档', refreshed2 && refreshed2.name === manualFull.name && refreshed2.refreshCount === 1,
  refreshed2 && (refreshed2.name + ' / refreshCount=' + refreshed2.refreshCount));
ok('④b 手动档总数仍是 2 份（没多出来）', list.filter(s => s.manual).length === 2, list.filter(s => s.manual).map(s => s.name).join(' '));

// ⑤ 保留策略：自动的时间段轮转不会清手动档
api.prune(inst);
list = snaps();
ok('⑤ 手动档都在（自动轮转没删它们）', list.filter(s => s.manual).length === 2, list.filter(s => s.manual).map(s => s.name).join(' '));
// 当前设置里「完整留 0」：自动的完整档（第一份自动快照）按策略会被清，但**最新那份自动档一定留着**（兜底）
ok('⑤ 自动档里最新那份一定留着', list.filter(s => !s.manual).length >= 1
  && list.filter(s => !s.manual).slice(-1)[0].name === auto2.name,
  list.filter(s => !s.manual).map(s => s.name).join(' '));
ok('⑤ 兜底生效：实例不会一份不剩', list.length >= 2, list.length + ' 份');

// ⑥ 手动档份数上限（manualKeep=20）：造 22 份假的，只留最新 20
const bdir = path.join(root, 'b', 'chain');
const pad = n => String(n).padStart(2, '0');
for (let i = 0; i < 22; i++) {
  const name = `20260101-${pad(i)}0000_hardlink`;
  fs.mkdirSync(path.join(bdir, name, 'World'), { recursive: true });
  fs.writeFileSync(path.join(bdir, name, 'World', 'level.dat'), 'x');
  fs.writeFileSync(path.join(bdir, name, 'meta.json'), JSON.stringify({
    name, type: 'hardlink', format: 'hardlink', createdAt: new Date(2026, 0, 1, i).toISOString(),
    manual: true, files: 1, fileCount: 1, treeMB: 1, sizeMB: 1, deltaMB: 1, linked: 0, copied: 1, seconds: 0.1
  }));
}
api.prune(inst);
list = snaps();
const fakeLeft = list.filter(s => s.manual && s.name.startsWith('20260101-')).length;
ok('⑥ 手动档总数 = manualKeep（20）：2 份真的 + 18 份假的', list.filter(s => s.manual).length === 20 && fakeLeft === 18,
  '手动共 ' + list.filter(s => s.manual).length + ' 份（假档剩 ' + fakeLeft + '）');
ok('⑥ 留下的都是最新的（最老的假档被清）',
  !fs.existsSync(path.join(bdir, '20260101-000000_hardlink')) && !fs.existsSync(path.join(bdir, '20260101-030000_hardlink')),
  '000000 存在=' + fs.existsSync(path.join(bdir, '20260101-000000_hardlink')));

const bad = results.filter(r => !r.pass);
for (const r of results) { console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '   [' + r.extra + ']' : '')); }
console.log('\n沙盒目录: ' + root);
console.log(bad.length ? ('失败 ' + bad.length + ' / ' + results.length + ' 项') : ('全部通过（' + results.length + ' 项）'));
process.exit(bad.length ? 1 : 0);
