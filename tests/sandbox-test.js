// 备份插件全功能沙盒测试：用真实引擎 + 假 GTNH 服务端跑一遍所有面板请求
// 全部在临时目录里做，不碰线上实例
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// 默认用仓库里的引擎；要测别的副本就设 MC_BACKUP_ENGINE
const ENGINE = process.env.MC_BACKUP_ENGINE || path.join(__dirname, '..', 'src', 'mc-backup.js');
const TMP = process.env.MC_BACKUP_TMP || os.tmpdir();
// 用真实的 UUID 形状（8-4-4-4-12）：引擎按形状判断是 playerdata 还是 GTNH 的 players/名字.dat
const uuid = 'aaaaaaa1-1111-4444-8888-2222cccc3333';
const uuid2 = 'ddddddd5-5555-4444-8888-6666ffff7777';
const root = path.join(TMP, 'mbc-sandbox-' + Date.now().toString().slice(-6));
const instDir = path.join(root, 'server');
const CFG = path.join(root, 'mc-backup-config.json');
const BACKUP = path.join(root, 'backups');
const STATUS = path.join(root, 'status.json');
const EXPORT = path.join(root, 'exports');

const results = [];
function ok(name, cond, extra) { results.push({ name, pass: !!cond, extra: extra === undefined ? '' : String(extra) }); }
function eq(name, a, b) { ok(name, a === b, a === b ? '' : `实际=${a} 期望=${b}`); }
function dump(code) {
  const bad = results.filter(r => !r.pass);
  for (const r of results) { console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.extra ? '   [' + r.extra + ']' : '')); }
  console.log('\n沙盒目录: ' + root);
  console.log(bad.length ? ('失败 ' + bad.length + ' / ' + results.length + ' 项') : ('全部通过（' + results.length + ' 项）'));
  try { fs.writeFileSync(path.join(TMP, 'mbc-sandbox-result.json'), JSON.stringify({ root, results, total: results.length, failed: bad.length }, null, 2)); } catch { }
  process.exit(code);
}
process.on('uncaughtException', e => { results.push({ name: '测试中断：' + (e && e.message), pass: false, extra: '' }); dump(1); });

// ---------- 小工具 ----------
function mk(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function b64u(s) { return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function rm(p) { fs.rmSync(p, { recursive: true, force: true }); }
// 造一个 .mca 区域文件：chunkList = [{x,z,data:Buffer}]
function mca(chunkList) {
  const loc = Buffer.alloc(4096);
  const parts = [];
  let sector = 2;
  for (const c of chunkList) {
    const payload = Buffer.alloc(4 + c.data.length);
    payload.writeInt32BE(c.data.length, 0);
    c.data.copy(payload, 4);
    const sectors = Math.ceil(payload.length / 4096);
    const padded = Buffer.alloc(sectors * 4096);
    payload.copy(padded, 0);
    const idx = (c.x & 31) + (c.z & 31) * 32;
    loc.writeUInt8((sector >> 16) & 0xff, idx * 4);
    loc.writeUInt8((sector >> 8) & 0xff, idx * 4 + 1);
    loc.writeUInt8(sector & 0xff, idx * 4 + 2);
    loc.writeUInt8(sectors, idx * 4 + 3);
    parts.push(padded);
    sector += sectors;
  }
  return Buffer.concat([loc, Buffer.alloc(4096), ...parts]);
}
function chunkData(tag) { return Buffer.from('CHUNK-' + tag + '-'.repeat(20)); }
// 用引擎自己的读法读出某个区块（校验回档结果）
function readChunkViaEngine(file, cx, cz) {
  const src = fs.readFileSync(ENGINE, 'utf8').replace(/^#!.*\n/, '');
  const cut = src.lastIndexOf('(async () => {');
  const argvBak = process.argv.slice();
  process.argv = ['node', 'x', 'status', '--config', CFG];
  const fn = new Function('require', 'process', '__dirname', 'module', 'exports',
    src.slice(0, cut) + '\nreturn { mcaReadChunk: mcaReadChunk, chunkCoords: chunkCoords };\n');
  const api = fn(require, process, path.dirname(ENGINE), { exports: {} }, {});
  process.argv = argvBak;
  return api.mcaReadChunk(file, cx, cz);
}
function engine(args) {
  return execFileSync('node', [ENGINE].concat(args, ['--config', CFG]), { encoding: 'utf8', timeout: 120000 });
}
function req(name) {
  const dir = path.join(BACKUP, '_queue', uuid);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name + '.req'), '1');
  const out = engine(['queue']);
  const doneDir = path.join(dir, 'done');
  const files = exists(doneDir) ? fs.readdirSync(doneDir) : [];
  const hit = files.filter(f => f.includes('-' + name.replace(/[^\w-]/g, '')) || f.includes(name)).sort().pop();
  return { out, done: files, hit, fail: hit ? hit.endsWith('.fail.done') : false };
}
function snaps() {
  const dir = path.join(BACKUP, 'sandbox');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter(n => /^\d{8}-\d{6}_(full|inc|hardlink)$/.test(n)).sort();
}
function snapMeta(name) { return readJson(path.join(BACKUP, 'sandbox', name, 'meta.json')); }
function snapPath(name) { return path.join(BACKUP, 'sandbox', name); }

// ---------- 1. 搭假 GTNH 服务端 ----------
rm(root);
mkdirSafe();
function mkdirSafe() { fs.mkdirSync(instDir, { recursive: true }); }

const ch00 = chunkData('A0'), ch10 = chunkData('A1');
const worldRegion = path.join(instDir, 'World', 'region', 'r.0.0.mca');
mk(worldRegion, mca([{ x: 0, z: 0, data: ch00 }, { x: 1, z: 0, data: ch10 }]));
mk(path.join(instDir, 'World', 'level.dat'), 'LEVEL-DATA');
mk(path.join(instDir, 'World', 'session.lock'), 'LOCK');            // 不该被备份
mk(path.join(instDir, 'World', 'playerdata', uuid + '.dat'), 'PLAYER-DATA-A');
mk(path.join(instDir, 'World', 'players', 'Alice.dat'), 'PLAYER-DATA-ALICE');   // GTNH 风格
mk(path.join(instDir, 'World', 'stats', uuid + '.json'), '{"stat":1}');
mk(path.join(instDir, 'World', 'advancements', uuid + '.json'), '{"adv":1}');
mk(path.join(instDir, 'World', 'DIM-1', 'level.dat'), 'NETHER');
mk(path.join(instDir, 'World', 'DIM-1', 'region', 'r.0.0.mca'), mca([{ x: 0, z: 0, data: chunkData('N0') }]));
mk(path.join(instDir, 'World', 'DIM-100', 'level.dat'), 'PERSONAL-DIM');
mk(path.join(instDir, 'world_flat', 'level.dat'), 'FLAT-WORLD');    // 超平坦（高版本常见，没有 region）
mk(path.join(instDir, 'config', 'x.json'), '{"c":1}');
mk(path.join(instDir, 'serverutilities', 'x.json'), '{"s":1}');
mk(path.join(instDir, 'kubejs', 'x.js'), '// kubejs');
mk(path.join(instDir, 'mods', 'somemod.jar'), 'JAR');               // 不该被备份
mk(path.join(instDir, 'logs', 'latest.log'), 'LOG');                // 不该被备份
mk(path.join(instDir, 'crash-reports', 'crash.txt'), 'CRASH');
mk(path.join(instDir, 'server.properties'), 'level-name=World');
mk(path.join(instDir, 'ops.json'), '["op"]');
mk(path.join(instDir, 'java9args.txt'), '-Xmx8G');
mk(path.join(instDir, 'startserver-java9.bat'), 'java @java9args.txt');

fs.writeFileSync(CFG, JSON.stringify({
  panelUrl: 'http://127.0.0.1:9', panelDir: root, panelUser: 'x', panelPass: 'y', daemonId: 'sandbox-daemon',
  backupRoot: BACKUP, statusFile: STATUS, exportRoot: EXPORT,
  include: ['World', 'world_flat', 'config', 'serverutilities', 'kubejs', 'server.properties', 'ops.json',
    'java9args.txt', 'startserver-java9.bat'],
  excludeFileNames: ['session.lock'], fullKeep: 1, hardlinkDeltas: true, saveAllBeforeSnapshot: false,
  baseMinutes: 10,
  tiers: [{ minutes: 10, keep: 6, full: 1 }, { minutes: 60, keep: 2, full: 1 }, { minutes: 120, keep: 2, full: 1 }],
  instances: [{ uuid, name: 'sandbox', dir: instDir, enabled: true, notes: {} }]
}, null, 2));

ok('沙盒：假 GTNH 服务端建好（World/个人维度/超平坦/玩家 data+players）', exists(worldRegion) && exists(path.join(instDir, 'world_flat', 'level.dat')));

// ---------- 2. 快照 ----------
req('snapshot');
let list = snaps();
eq('① 第一次保存：生成 1 份快照', list.length, 1);
const s1 = list[0];
ok('① 第一次是完整复制（type=full）', snapMeta(s1).type === 'full', snapMeta(s1).type);
const s1p = snapPath(s1);
ok('① 备份含 World/level.dat', exists(path.join(s1p, 'World', 'level.dat')));
ok('① 备份含 config / serverutilities / kubejs', exists(path.join(s1p, 'config')) && exists(path.join(s1p, 'serverutilities')) && exists(path.join(s1p, 'kubejs')));
ok('① 备份含 GTNH 专属文件 java9args.txt / startserver-java9.bat', exists(path.join(s1p, 'java9args.txt')) && exists(path.join(s1p, 'startserver-java9.bat')));
ok('① 备份含超平坦世界 world_flat', exists(path.join(s1p, 'world_flat', 'level.dat')));
ok('① 排除了 session.lock', !exists(path.join(s1p, 'World', 'session.lock')));
ok('① 不含 mods（不在备份内容里）', !exists(path.join(s1p, 'mods')));
ok('① 不含 logs / crash-reports', !exists(path.join(s1p, 'logs')) && !exists(path.join(s1p, 'crash-reports')));

req('snapshot');
list = snaps();
// 面板上的「增量保存」= 刷新最近那份手动档（不是再建一份）
eq('② 第二次「增量保存」：还是 1 份（写进原来那份）', list.length, 1);
const m2 = snapMeta(list[0]);
ok('② meta 记了刷新次数与时间', m2.refreshCount === 1 && !!m2.refreshedAt, 'refreshCount=' + m2.refreshCount);
ok('② 没变的文件保持不动（linked 记的是保持数）', m2.linked > 0, 'linked=' + m2.linked + ' copied=' + m2.copied);
// 改一个文件再刷一次，验证"变化的写进去、其余保持"
fs.writeFileSync(path.join(instDir, 'server.properties'), 'level-name=World\nmotd=changed');
req('snapshot');
list = snaps();
eq('② 再刷一次：仍然 1 份', list.length, 1);
const m2b = snapMeta(list[0]);
ok('② 变化文件写进了这份手动档', fs.readFileSync(path.join(snapPath(list[0]), 'server.properties'), 'utf8').includes('motd=changed'));
ok('② 刷新计数累加', m2b.refreshCount === 2, 'refreshCount=' + m2b.refreshCount);
ok('② 这次有文件被覆盖（copied>0）', m2b.copied > 0, 'copied=' + m2b.copied);

// ---------- 3. 完整档 / 增量档 分开 ----------
req('snapshot-full');
list = snaps();
const fulls = list.filter(n => n.endsWith('_full'));
// 「全部保存」才是另起一份：现在一共 2 份手动档（那份可刷新的 + 这份新的完整复制）
eq('③ 全部保存 = 另起一份（手动档 2 份，其中完整 2 份）', fulls.length, 2);
req('snapshot-full');
list = snaps();
const fulls2 = list.filter(n => n.endsWith('_full'));
eq('③ 再点一次全部保存：手动档 3 份（都在，不参与时间段轮转）', list.length, 3);
ok('③ 手动档都不参与时间段轮转', fulls2.length >= 2, fulls2.length + ' 份完整');
// 注意：第一份快照本身就是「完整档」（前面没有可增量的快照），按「完整档只留 1 份」会被后存的完整档顶掉。
// 所以后面统一拿「当前最新快照」当参照物，不能一直用第一份。
const refSnap = snaps().pop();
const refFile = path.join(snapPath(refSnap), 'World', 'region', 'r.0.0.mca');
ok('③ 参照物（最新快照）里有区域文件', exists(refFile), refSnap);

// ---------- 4. 状态文件字段 ----------
engine(['status']);
let st = readJson(STATUS).instances[0];
ok('④ 状态含快照列表 + 完整/增量计数', Array.isArray(st.snapshots) && typeof st.fulls === 'number', `fulls=${st.fulls} incs=${st.incs}`);
ok('④ 状态含分档 tiers 与完整档 fullKeep', Array.isArray(st.tiers) && st.fullKeep === 1, JSON.stringify(st.tiers) + ' fullKeep=' + st.fullKeep);
ok('④ 每份快照带档位字段 tier/tiers', st.snapshots.every(s => typeof s.tier === 'number' && Array.isArray(s.tiers)));

// ---------- 5. 世界 / 玩家识别 ----------
const worlds = st.worlds.map(w => w.world + '[' + w.kind + ']');
ok('⑤ 识别主世界', worlds.some(w => w.startsWith('World[') && w.includes('主世界')), worlds.join(' '));
ok('⑤ 识别个人维度 DIM-100（GTNH 一人一岛）', worlds.some(w => w.includes('DIM-100') && w.includes('个人维度')), worlds.join(' '));
ok('⑤ 识别超平坦世界 world_flat', worlds.some(w => w.includes('world_flat') && w.includes('平坦')), worlds.join(' '));
const players = st.players.map(p => p.key + (p.legacy ? '(players)' : '(playerdata)'));
ok('⑤ 识别玩家存档：playerdata 的 uuid', st.players.some(p => p.uuid === uuid && !p.legacy), players.join(' '));
ok('⑤ 识别 GTNH 的 players/名字.dat', st.players.some(p => p.legacy && p.key === 'Alice'), players.join(' '));

// ---------- 6. 世界备注 ----------
req('note-' + b64u('World') + '~' + b64u('玩家A的主世界'));
engine(['status']);
st = readJson(STATUS).instances[0];
const wWorld = st.worlds.filter(w => w.world === 'World')[0];
eq('⑥ 世界备注已保存并在状态里带出来', wWorld.note, '玩家A的主世界');

// ---------- 7. 区块历史 + 区块回档 + 区域回档 ----------
req('findchunk-' + b64u('World') + '~0~0');
const histFile = path.join(root, 'mcchunk-history-' + uuid + '.json');
const hist = readJson(histFile);
ok('⑦ 区块历史文件生成（卡片读的那个）', !!hist);
eq('⑦ 方块(0,0) → 区块(0,0)', hist.chunkX + ',' + hist.chunkZ, '0,0');
eq('⑦ 区域文件路径正确', hist.regionFile, 'World/region/r.0.0.mca');
ok('⑦ 历史行带变化点（时间/是否存在/大小/md5 前 8 位）', hist.rows.length > 0 && hist.rows.every(r => r.time && typeof r.exists === 'boolean' && ('size' in r) && ('hash' in r)), JSON.stringify(hist.rows[0]));

// 改掉世界里的区块，再用快照回档它
const before = readChunkViaEngine(worldRegion, 0, 0);
fs.writeFileSync(worldRegion, mca([{ x: 0, z: 0, data: chunkData('CHANGED') }, { x: 1, z: 0, data: chunkData('A1') }]));
const changed = readChunkViaEngine(worldRegion, 0, 0);
ok('⑦ 造出一份「被改坏」的区块用于对比', !before.equals(changed));
const r1 = req('restorechunk-' + b64u('World') + '~0~0~latest');
ok('⑦ 区块回档请求执行成功（不是失败）', !r1.fail, r1.hit);
ok('⑦ 区块回档后内容与快照一致', readChunkViaEngine(worldRegion, 0, 0).equals(before));
ok('⑦ 同区域的另一个区块没被动（只回档一个区块）', readChunkViaEngine(worldRegion, 1, 0).equals(readChunkViaEngine(refFile, 1, 0)));
ok('⑦ 回档前自动留了原文件备份（_manual）', exists(path.join(BACKUP, '_manual')));

fs.writeFileSync(worldRegion, mca([{ x: 0, z: 0, data: chunkData('BAD2') }]));
const r2 = req('restoreregion-' + b64u('World') + '~0~0~latest');
ok('⑦ 整个区域回档请求执行成功', !r2.fail, r2.hit);
eq('⑦ 区域回档后文件与快照完全一致（字节级）',
  crypto.createHash('md5').update(fs.readFileSync(worldRegion)).digest('hex'),
  crypto.createHash('md5').update(fs.readFileSync(refFile)).digest('hex'));

// ---------- 8. 世界回档 / 玩家回档 / 玩家转移 ----------
fs.writeFileSync(path.join(instDir, 'World', 'level.dat'), 'BROKEN');
const r3 = req('restoreworld-' + b64u('World') + '~latest');
ok('⑧ 世界回档请求执行成功', !r3.fail, r3.hit);
eq('⑧ 世界回档后 level.dat 还原', fs.readFileSync(path.join(instDir, 'World', 'level.dat'), 'utf8'), 'LEVEL-DATA');

fs.writeFileSync(path.join(instDir, 'World', 'playerdata', uuid + '.dat'), 'BROKEN-PLAYER');
const r4 = req('restoreplayer-' + b64u('World') + '~' + b64u(uuid) + '~latest');
ok('⑧ 玩家回档请求执行成功', !r4.fail, r4.hit);
eq('⑧ 玩家存档已还原', fs.readFileSync(path.join(instDir, 'World', 'playerdata', uuid + '.dat'), 'utf8'), 'PLAYER-DATA-A');

const r5 = req('xferplayer-' + b64u('World') + '~' + b64u(uuid) + '~' + b64u(uuid2) + '~live');
ok('⑧ 玩家数据转移请求执行成功', !r5.fail, r5.hit);
eq('⑧ 目标玩家拿到来源玩家的数据', fs.readFileSync(path.join(instDir, 'World', 'playerdata', uuid2 + '.dat'), 'utf8'), 'PLAYER-DATA-A');
ok('⑧ 目标玩家 stats/advancements 也一起给了', exists(path.join(instDir, 'World', 'stats', uuid2 + '.json')) && exists(path.join(instDir, 'World', 'advancements', uuid2 + '.json')));

// ---------- 9. 整包回档 ----------
fs.writeFileSync(path.join(instDir, 'server.properties'), 'BROKEN');
const r6 = req('restore-latest');
ok('⑨ 整包回档请求执行成功', !r6.fail, r6.hit);
// ② 里改过这个文件，所以快照里存的是改后的内容（回档就是把它还原成快照里的样子）
eq('⑨ 整包回档后 server.properties 还原成快照里的内容',
  fs.readFileSync(path.join(instDir, 'server.properties'), 'utf8').includes('motd=changed'), true);

// ---------- 10. 导出 ----------
const latest = snaps().pop();          // 最新那份（现在可能正好是完整档）
const e1 = req('exportsave-' + latest + '~all~');
ok('⑩ 导出整份存档（带全部玩家数据）成功', !e1.fail, e1.hit);
const e2 = req('exportsave-' + latest + '~none~');
ok('⑩ 导出整份存档（不带玩家数据）成功', !e2.fail, e2.hit);
const e3 = req('exportworld-' + b64u('World') + '~' + latest + '~all');
ok('⑩ 导出单个世界成功', !e3.fail, e3.hit);
const e4 = req('exportplayer-' + b64u('World') + '~' + b64u(uuid) + '~' + latest);
ok('⑩ 导出单个玩家的存档成功', !e4.fail, e4.hit);
const e5 = req('exportserver');
ok('⑩ 导出整个服务端成功', !e5.fail, e5.hit);
const e6 = req('exportserver-clean');
ok('⑩ 导出纯净服务端成功', !e6.fail, e6.hit);
const expDirs = exists(EXPORT) ? fs.readdirSync(EXPORT) : [];
const cleanDir = expDirs.filter(n => /clean|纯净/.test(n)).sort().pop();
const cleanPath = cleanDir ? path.join(EXPORT, cleanDir) : '';
if (cleanPath) {
  ok('⑩ 纯净导出不含存档（World/world_flat）', !exists(path.join(cleanPath, 'World')) && !exists(path.join(cleanPath, 'world_flat')));
  ok('⑩ 纯净导出不含玩家名单类文件（ops/whitelist）', !exists(path.join(cleanPath, 'ops.json')) && !exists(path.join(cleanPath, 'whitelist.json')));
  ok('⑩ 纯净导出不含 logs / crash-reports', !exists(path.join(cleanPath, 'logs')) && !exists(path.join(cleanPath, 'crash-reports')));
  ok('⑩ 纯净导出仍然带 mods/config（能直接开服）', exists(path.join(cleanPath, 'mods')) || exists(path.join(cleanPath, 'config')));
  ok('⑩ 纯净导出带说明文件', exists(path.join(cleanPath, '导出说明.txt')));
} else {
  ok('⑩ 纯净导出目录存在', false, expDirs.join(' '));
}

// ---------- 11. 删除存档 ----------
const all = snaps();
const victim = all.filter(n => !n.endsWith('_full'))[1] || all[0];
const d1 = req('delsnap-' + victim);
ok('⑪ 删除指定快照成功', !d1.fail && !exists(path.join(BACKUP, 'sandbox', victim)), d1.hit);
const d2 = req('delsnap-19990101-000000_full');
ok('⑪ 删不存在的快照会报错而不是静默成功', d2.fail, d2.hit);

// ---------- 12. 设置（单个 / 全局） ----------
const setInst = JSON.stringify({ d: uuid, b: 5, t: [[5, 4, 0], [60, 2, 2]] });
const s1r = req('settings-' + b64u(setInst));
ok('⑫ 单个服务端设置成功', !s1r.fail, s1r.hit);
let cfgNow = readJson(CFG);
eq('⑫ 单个设置写进配置（间隔 5 分钟）', cfgNow.instances[0].baseMinutes, 5);
eq('⑫ 单个设置写进配置（完整档份数进了档位表）',
  JSON.stringify(cfgNow.instances[0].tiers.map(t => [t.minutes, t.keep, t.full])), JSON.stringify([[5, 4, 0], [60, 2, 2]]));
engine(['status']);
st = readJson(STATUS).instances[0];
// 状态里的 tiers 按间隔从小到大排（卡片也是这么显示的）
eq('⑫ 状态里能读到单个设置（含完整档份数）', JSON.stringify(st.tiers),
  JSON.stringify([{ minutes: 5, keep: 4, full: 0 }, { minutes: 60, keep: 2, full: 2 }]));
ok('⑫ 状态标记「单独设置」', st.ownInterval === true && st.ownTiers === true);
eq('⑫ 填 0 的那档：状态里完整份数就是 0（不存）', st.tiers[0].full, 0);
const setGlobal = JSON.stringify({ b: 10, t: [[10, 6, 1], [60, 2, 1], [120, 2, 1]] });
const s2r = req('settings-' + b64u(setGlobal));
ok('⑫ 全局设置成功', !s2r.fail, s2r.hit);
cfgNow = readJson(CFG);
eq('⑫ 全局档位表写进配置（完整份数在内）',
  JSON.stringify(cfgNow.tiers.map(t => [t.minutes, t.keep, t.full])), JSON.stringify([[10, 6, 1], [60, 2, 1], [120, 2, 1]]));
eq('⑫ 全局间隔写进配置', cfgNow.baseMinutes, 10);
ok('⑫ 设置非法值会被拒绝（增量和完整都是 0 的那一档）', req('settings-' + b64u(JSON.stringify({ b: 10, t: [[10, 0, 0]] }))).fail);
ok('⑫ 设置非法值会被拒绝（负数份数）', req('settings-' + b64u(JSON.stringify({ b: 10, t: [[10, -1, 1]] }))).fail);
// 把单个服务端改回「跟随全局」，好让下面的保留规则用全局那套（10 分钟 6 份 + 1 小时 2 份 + 2 小时 2 份 + 完整档 1 份）
const reset = req('settings-' + b64u(JSON.stringify({ d: uuid, x: 1 })));
ok('⑫ 改回跟随全局成功', !reset.fail, reset.hit);
let cfgReset = readJson(CFG).instances[0];
ok('⑫ 单个设置已被清掉（tiers / baseMinutes 都没了）',
  !cfgReset.tiers && !cfgReset.baseMinutes,
  JSON.stringify({ t: cfgReset.tiers, b: cfgReset.baseMinutes }));
engine(['status']);
st = readJson(STATUS).instances[0];
eq('⑫ 状态回到全局的保留策略', JSON.stringify(st.tiers),
  JSON.stringify([{ minutes: 10, keep: 6, full: 1 }, { minutes: 60, keep: 2, full: 1 }, { minutes: 120, keep: 2, full: 1 }]));
eq('⑫ 状态里的完整档份数回到全局值', st.fullKeep, 1);

// ---------- 13. 分档保留（时间段锚点）+ 完整档 1 份 ----------
// 造 8 小时时间线：每 10 分钟一份假快照（直接写目录 + meta，名字按时间），06:50 与 07:50 各一份完整档
const sandboxBackup = path.join(BACKUP, 'sandbox');
const t0 = new Date('2026-09-22T00:00:00');
function fakeSnap(d, type) {
  const p = n => String(n).padStart(2, '0');
  const name = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}_${type}`;
  const dir = path.join(sandboxBackup, name);
  fs.mkdirSync(path.join(dir, 'World'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'World', 'level.dat'), 'x');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    name, type, format: type, createdAt: d.toISOString(), files: 1, fileCount: 1, treeMB: 1, sizeMB: 1, deltaMB: 1,
    linked: 0, copied: 1, seconds: 0.1
  }));
}
// 清掉前面的快照，重造一条干净时间线
for (const n of fs.readdirSync(sandboxBackup)) { if (/^\d{8}-\d{6}_/.test(n) && fs.statSync(path.join(sandboxBackup, n)).isDirectory()) rm(path.join(sandboxBackup, n)); }
// 完整档放在 05:50 / 06:50 / 07:50，正好横跨三个时间段，用来验「完整存档也分三段」
for (let i = 0; i < 8 * 6; i++) fakeSnap(new Date(t0.getTime() + i * 10 * 60000), (i === 35 || i === 41 || i === 47) ? 'full' : 'hardlink');
engine(['prune']);
let kept = snaps();
const keptFulls = kept.filter(n => n.endsWith('_full'));
// 最近档 = 07:50；1 小时档 = 上一个时间段（06 点那个小时）里的 06:50；2 小时档 = 再往前一段（04~06 点）里的 05:50
eq('⑬ 完整档也分三段（最近 + 1 小时档 + 2 小时档）', keptFulls.length, 3);
ok('⑬ 三段完整档分别是 0550 / 0650 / 0750',
  keptFulls.map(n => n.slice(9, 13)).sort().join(',') === '0550,0650,0750', keptFulls.map(n => n.slice(9, 13)).join(','));
ok('⑬ 保留份数在预期范围（10 分钟档 6 + 增量锚点 + 完整档三段）', kept.length <= 13, kept.length + ' 份');
const times = kept.map(n => n.slice(9, 13)).sort();
ok('⑬ 保留了跨小时的锚点（最早的锚点比第 6 新的还旧）', times[0] < times[times.length - 7] || kept.length > 7, times.join(' '));

// ⑬b 完整档那列填 0 = 这一档不存完整档
ok('⑬b 「完整留 0」的设置能保存（增量没填 0）',
  !req('settings-' + b64u(JSON.stringify({ b: 10, t: [[10, 6, 0], [60, 2, 0], [120, 2, 0]] }))).fail);
engine(['prune']);
kept = snaps();
// 自动档的「完整留 0」→ 老的完整档清掉；但兜底规则保住「最新那份自动档」（它正好是完整复制），
// 不然一旦没有基准，下一份又会变成完整复制再被清掉，这个实例就永远存不下东西
ok('⑬b 完整档填 0 → 旧的完整档被清（只留兜底的最新那份）',
  kept.filter(n => n.endsWith('_full')).length <= 1 && !kept.some(n => n.startsWith('20260922-0650')),
  kept.filter(n => n.endsWith('_full')).join(' '));
ok('⑬b 增量档不受影响（还在）', kept.filter(n => !n.endsWith('_full')).length >= 6, kept.length + ' 份');
req('settings-' + b64u(JSON.stringify({ b: 10, t: [[10, 6, 1], [60, 2, 1], [120, 2, 1]] })));

// ---------- 14. 进度文件 ----------
const prog = readJson(path.join(root, 'mcbackup-progress.json'));
ok('⑭ 任务跑完写了进度文件（完成态 done）', prog && prog.task === 'done', JSON.stringify(prog && prog.task));
ok('⑭ 进度文件带百分比/份数/用时', prog && prog.percent === 100 && typeof prog.seconds === 'number');

// ---------- 15. 未知实例请求进 _orphan ----------
const orphanDir = path.join(BACKUP, '_queue', 'ffffffff00000000000000000000ffff');
fs.mkdirSync(orphanDir, { recursive: true });
fs.writeFileSync(path.join(orphanDir, 'snapshot.req'), '1');
engine(['queue']);
ok('⑮ 不认识的实例请求被挪到 _orphan（不会一直堆着）', exists(path.join(BACKUP, '_queue', '_orphan', 'ffffffff00000000000000000000ffff', 'snapshot.req')));

// ---------- 16. 备份内容分片设置（卡片用的那套） ----------
const incText = 'World, config, server.properties';
const b = b64u(incText);
const mid = Math.ceil(b.length / 2);
req('setinc-global~0~2~' + b.slice(0, mid));
const last = req('setinc-global~1~2~' + b.slice(mid));
ok('⑯ 备份内容分片提交成功', !last.fail, last.hit);
eq('⑯ 分片拼回来的备份内容正确', (readJson(CFG).include || []).join(', '), 'World, config, server.properties');

// ---------- 结果 ----------
// ---------- 17. 引擎的默认设置 = 线上当前那套 ----------
const defRoot = path.join(root, 'defaults');
fs.mkdirSync(defRoot, { recursive: true });
const defCfg = path.join(defRoot, 'c.json');
fs.writeFileSync(defCfg, JSON.stringify({
  panelUrl: 'http://127.0.0.1:9', backupRoot: path.join(defRoot, 'b'),
  statusFile: path.join(defRoot, 's.json'), exportRoot: path.join(defRoot, 'e'),
  instances: []
}, null, 2));
execFileSync('node', [ENGINE, 'status', '--config', defCfg], { encoding: 'utf8' });
const defStatus = readJson(path.join(defRoot, 's.json'));
ok('引擎默认档位 = 线上那套（10 分钟 增量6/完整0 + 2 小时 增量1/完整0）',
  JSON.stringify(defStatus.settings.tiers.slice().sort((a, b) => a.minutes - b.minutes).map(t => [t.minutes, t.keep, t.full]))
  === JSON.stringify([[10, 6, 0], [120, 1, 0]]),
  JSON.stringify(defStatus.settings.tiers));
eq('引擎默认存档间隔 = 10 分钟', defStatus.settings.baseMinutes, 10);

dump(results.filter(r => !r.pass).length ? 1 : 0);
