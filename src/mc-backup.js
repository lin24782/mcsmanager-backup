#!/usr/bin/env node
/*
  Minecraft 多服务端滚动备份组件（Node 版，Windows / Linux 通用）
  ------------------------------------------------------------------
  为什么有这份：PowerShell 版依赖 Windows 专有的硬链接 API、robocopy 和计划任务，
  Linux 上要额外装 PowerShell 才能跑。MCSManager 本身是 Node 应用，机器上一定有 node，
  所以这个 Node 版不需要任何额外安装，两个系统同一份代码。

  文件格式与 PowerShell 版完全一致（配置 / 快照 / 队列 / 状态文件），所以面板卡片不用改。

  只需要两个文件：
    mc-backup.js        ← 本文件：备份引擎 + 一键安装
    card-backup.html    ← 面板卡片（安装时会自动放进面板）

  用法:
    node mc-backup.js install                # 一键安装（可加 --yes / --service）
    node mc-backup.js status                 # 刷新状态文件（卡片读的那个）
    node mc-backup.js snapshot               # 给到时间的服务端各存一份
    node mc-backup.js snapshot -i mc-1        # 只存某一个
    node mc-backup.js queue                  # 处理面板卡片发来的请求
    node mc-backup.js watch                  # 常驻：每分钟处理队列 + 到点自动存档
    node mc-backup.js list / prune / restore / export ...
*/

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const ACTION = (process.argv[2] || 'status').toLowerCase();

// ---------------- 基础工具 ----------------
function log(msg, level = 'INFO') {
  const t = new Date().toLocaleString('sv-SE').replace('T', ' ');
  const line = `[${t}] [${level}] ${msg}`;
  console.log(line);
  try {
    const f = path.join(__dirname, 'mc-backup.log');
    fs.appendFileSync(f, line + os.EOL);
  } catch { }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');   // 不带 BOM，浏览器 fetch 直接读
}
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function stat(p) { try { return fs.statSync(p); } catch { return null; } }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { } }
function b64uDecode(s) {
  if (!s) return '';
  let t = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  try { return Buffer.from(t, 'base64').toString('utf8'); } catch { return ''; }
}
function b64uEncode(s) {
  return Buffer.from(String(s), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function mb(bytes) { return Math.round(bytes / 1048576 * 10) / 10; }
function copyTree(src, dst) {
  // preserveTimestamps：保留修改时间，否则下一次快照会把「刚还原的文件」全当成变化文件重抄一遍
  fs.cpSync(src, dst, { recursive: true, force: true, preserveTimestamps: true });
}
// 数一下要处理多少文件（给进度条用）
function countFiles(p) {
  const st = stat(p);
  if (!st) return 0;
  if (st.isFile()) return 1;
  let n = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let items = [];
    try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const cp = path.join(cur, it.name);
      if (it.isDirectory()) stack.push(cp); else n++;
    }
  }
  return n;
}
// 带进度的目录复制（回档 / 导出用，卡片上能看到跑了多少）
function copyTreeProgress(src, dst, label) {
  const total = countFiles(src);
  beginTask((label && label.task) || 'copy', label && label.inst, total, (label && label.message) || '');
  let n = 0;
  const walk = (s, d) => {
    const st = stat(s);
    if (!st) return;
    if (st.isFile()) {
      mkdirp(path.dirname(d));
      fs.copyFileSync(s, d);
      try { fs.utimesSync(d, st.atimeMs / 1000, st.mtimeMs / 1000); } catch { }
      n++;
      if (n % 100 === 0 || n === total) stepTask(n);
      return;
    }
    mkdirp(d);
    for (const it of fs.readdirSync(s, { withFileTypes: true })) walk(path.join(s, it.name), path.join(d, it.name));
  };
  walk(src, dst);
  endTask(((label && label.done) || '完成') + '（' + n + ' 个文件）');
  return n;
}

// ---------------- 配置 ----------------
const cfgArgIdx = process.argv.indexOf('--config');
const CONFIG_FILE = (cfgArgIdx >= 0 && process.argv[cfgArgIdx + 1]) ? process.argv[cfgArgIdx + 1]
  : (process.env.MC_BACKUP_CONFIG || path.join(__dirname, 'mc-backup-config.json'));

// ---------- install：一键安装（不需要已有配置，先跑这个再说） ----------
if (ACTION === 'install') {
  const has = f => process.argv.includes(f);
  const val = (f, d = '') => { const i = process.argv.indexOf(f); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
  const YES = has('--yes'), WITH_SERVICE = has('--service');
  const SERVICE_NAME = val('--name', '备份服务');
  const DAEMON_DATA = val('--daemon-data', '');
  const RUNTIME_DIR_ARG = val('--runtime-dir', '');
  let SVC_DIR = __dirname, SVC_JS = __filename, SVC_CFG = CONFIG_FILE;

  const findMcsm = () => {
    const cands = ['E:\\MCSM', 'D:\\MCSM', 'C:\\MCSM', 'C:\\Program Files\\MCSM',
      '/opt/mcsmanager', '/usr/local/mcsmanager', '/srv/mcsmanager', path.join(os.homedir(), 'mcsmanager')];
    for (const c of cands) {
      if (exists(path.join(c, 'web', 'app.js'))) {
        return { root: c, web: path.join(c, 'web'), daemonData: exists(path.join(c, 'daemon', 'data')) ? path.join(c, 'daemon', 'data') : '' };
      }
    }
    return null;
  };
  const srvInstanceJson = uuid => ({
    nickname: SERVICE_NAME, type: 0, startCommand: `"${process.execPath}" "${SVC_JS}" watch --config "${SVC_CFG}"`,
    stopCommand: '\u0003', stopTimeout: 0, cwd: SVC_DIR, ie: 'UTF-8', oe: 'UTF-8',
    createDatetime: Date.now(), lastDatetime: 0, tag: [], endTime: 0, fileCode: 'UTF-8', processType: 'general',
    updateCommand: '', runAs: '', actionCommandList: [], crlf: 2, category: 0, enableRcon: false, rconPassword: '',
    rconPort: 0, rconIp: '', java: { id: '' },
    terminalOption: { haveColor: true, pty: true, ptyWindowCol: 164, ptyWindowRow: 40 },
    eventTask: { autoStart: true, autoRestart: true, autoRestartMaxTimes: 0, ignore: false },
    docker: { image: '', containerName: '', memory: '', ports: [], extraVolumes: [], networkMode: 'bridge', workingDir: '/data', env: [], changeWorkdir: true },
    pingConfig: { ip: '', port: 0, type: 1 }, extraServiceConfig: { openFrpTunnelId: '', openFrpToken: '' },
    basePort: 0, instanceUuid: uuid
  });
  const apiLogin = async (base, cfg) => {
    const r = await fetch(base + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ username: cfg.panelUser, password: cfg.panelPass })
    });
    const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''])
      .filter(Boolean).map(c => c.split(';')[0]).join('; ');
    const j = await (async () => { try { return await r.json(); } catch { return null; } })();
    const token = (j && typeof j.data === 'string' && j.data.length > 10) ? j.data : null;
    return token ? { token, cookies } : null;
  };
  const registerCard = async (cfg, target) => {
    const base = (cfg.panelUrl || 'http://127.0.0.1:23333').replace(/\/+$/, '');
    const auth = await apiLogin(base, cfg);
    if (!auth) { console.log('  ⚠ 面板登录失败：卡片文件已放好，可在面板里手动加（自定义布局 → 添加 → 扩展页面卡片 → /upload_files/card-backup.html）'); return false; }
    const H = extra => Object.assign({ 'X-Requested-With': 'XMLHttpRequest', 'Cookie': auth.cookies, 'Authorization': auth.token }, extra || {});
    const raw = await (await fetch(base + '/api/overview/layout', { headers: H() })).json();
    let layout; try { layout = JSON.parse(raw.data); } catch { console.log('  ⚠ 读布局失败，跳过卡片注册'); return false; }
    const page = layout.find(p => p.page === '/overview');
    if (!page) { console.log('  ⚠ 布局里没有 /overview，跳过卡片注册'); return false; }
    page.items = (page.items || []).filter(i => !(i.type === 'PluginCard' && i.title === '存档备份'));
    page.items.push({
      id: crypto.randomUUID(), type: 'PluginCard', title: '存档备份',
      meta: { url: '/upload_files/card-backup.html?v=' + Math.floor(Date.now() / 1000) }, width: 6, height: '680px',
      description: '存档备份：增量/全部保存、世界·玩家·区块回档、导出、删除存档、全局/单个设置'
    });
    const saved = await (await fetch(base + '/api/overview/layout?token=' + encodeURIComponent(auth.token), {
      method: 'POST', headers: H({ 'Content-Type': 'application/json; charset=utf-8' }), body: JSON.stringify(layout)
    })).json();
    const ok = !!(saved && (saved.data === true || saved.status === 200));
    console.log(ok ? '  ✓ 卡片已注册到面板首页（刷新面板即可看到）' : '  ⚠ 卡片注册返回异常：' + JSON.stringify(saved));
    return ok;
  };
  const createService = async cfg => {
    const base = (cfg.panelUrl || 'http://127.0.0.1:23333').replace(/\/+$/, '');
    const auth = await apiLogin(base, cfg);
    if (!auth) return null;
    const H = extra => Object.assign({ 'X-Requested-With': 'XMLHttpRequest', 'Cookie': auth.cookies, 'Authorization': auth.token }, extra || {});
    const list = await (await fetch(`${base}/api/service/remote_service_instances?daemonId=${cfg.daemonId}&page=1&page_size=100&token=${encodeURIComponent(auth.token)}`, { headers: H() })).json();
    const old = ((list && list.data && list.data.data) || []).find(i => i.config && i.config.nickname === SERVICE_NAME);
    if (old) await fetch(`${base}/api/instance?daemonId=${cfg.daemonId}&uuid=${old.instanceUuid}&token=${encodeURIComponent(auth.token)}`, { method: 'DELETE', headers: H() }).catch(() => { });
    const uuid = crypto.randomUUID().replace(/-/g, '');
    const created = await (await fetch(`${base}/api/instance?daemonId=${cfg.daemonId}&token=${encodeURIComponent(auth.token)}`, {
      method: 'POST', headers: H({ 'Content-Type': 'application/json; charset=utf-8' }), body: JSON.stringify(srvInstanceJson(uuid))
    })).json();
    const ok = !!(created && created.data && (created.data === true || created.data.instanceUuid));
    console.log(ok ? `  ✓ 已在面板里创建常驻实例「${SERVICE_NAME}」（uuid=${uuid}）—— 到实例列表点一下启动即可（或重启节点自动拉起）`
      : '  ⚠ 面板 API 创建实例失败：' + JSON.stringify(created));
    return ok ? uuid : null;
  };
  const writeServiceFile = (cfg, mcs) => {
    const dd = DAEMON_DATA || cfg.daemonDataDir || (mcs && mcs.daemonData);
    if (!dd) { console.log('  ⚠ 没找到节点数据目录，跳过常驻服务'); return; }
    const dir = path.join(dd, 'InstanceConfig');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const j = readJson(path.join(dir, f), null);
      if (j && j.nickname === SERVICE_NAME) {
        j.startCommand = `"${process.execPath}" "${SVC_JS}" watch --config "${SVC_CFG}"`; j.cwd = SVC_DIR; j.crlf = 2;
        writeJson(path.join(dir, f), j);
        console.log(`  ✓ 已更新「${SERVICE_NAME}」实例配置（重启节点后生效）`);
        return;
      }
    }
    const uuid = crypto.randomUUID().replace(/-/g, '');
    writeJson(path.join(dir, uuid + '.json'), srvInstanceJson(uuid));
    console.log(`  ✓ 已写入「${SERVICE_NAME}」实例配置（uuid=${uuid}，重启节点后生效）`);
  };

  (async () => {
    console.log('=== MCSManager 存档备份插件 安装 ===');
    const mcs = findMcsm();
    console.log('  找到 MCSManager: ' + (mcs ? mcs.root : '没找到（可在配置里手填 panelDir / daemonDataDir）'));
    let cfg = readJson(CONFIG_FILE, null);
    if (!cfg) {
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      const ask = (q, d) => YES ? Promise.resolve(d) : new Promise(res => rl.question(`${q}${d ? '（默认 ' + d + '）' : ''}: `, a => res(a.trim() || d)));
      const backupRoot = await ask('存档备份放哪（要和游戏服同一个盘，硬链接才省空间）', process.platform === 'win32' ? 'E:\\MC\\_backups' : '/srv/backups');
      cfg = {
        panelUrl: await ask('面板地址', 'http://127.0.0.1:23333'),
        panelDir: mcs ? mcs.root : '',
        panelUser: await ask('面板账号', ''),
        panelPass: await ask('面板密码', ''),
        daemonId: await ask('节点 ID（面板「节点」页可见）', ''),
        daemonDataDir: mcs ? mcs.daemonData : '',
        backupRoot, statusFile: path.join(mcs ? mcs.web : '.', 'public', 'upload_files', 'mcbackup-status.json'),
        exportRoot: path.join(backupRoot, '_exports'),
        // 默认值 = 2026-09-22 线上实际在用的那套设置（面板里调好之后抄回来的）
        include: ['world', 'config', 'kubejs', 'defaultconfigs', 'server.properties', 'ops.json', 'whitelist.json',
          'banned-ips.json', 'banned-players.json', 'usercache.json', 'usernamecache.json', 'user_jvm_args.txt',
          'serverutilities', 'journeymap', 'TCNodeTracker', 'visualprospecting', 'local', 'customnpcs',
          'java9args.txt', 'startserver-java9.bat', 'startserver-java9.sh', 'startserver.bat', 'startserver.sh',
          'server-icon.png', 'eula.txt'],
        excludeFileNames: ['session.lock'], fullSnapshots: 0, fullKeep: 0, manualKeep: 20,
        baseRefreshHours: 12, keepSnapshots: 7,
        retentionHours: 6, minFreeGB: 20, hardlinkDeltas: true, saveAllBeforeSnapshot: true, saveAllWaitSeconds: 6,
        baseMinutes: 10, gtnhIncludesDone: true,
        tiers: [{ minutes: 10, keep: 6, full: 0 }, { minutes: 120, keep: 1, full: 0 }], instances: []
      };
      writeJson(CONFIG_FILE, cfg);
      rl.close();
      console.log('  ✓ 已生成配置: ' + CONFIG_FILE);
    } else console.log('  ✓ 使用已有配置: ' + CONFIG_FILE);

    if (cfg.daemonDataDir) {
      const instDir = path.join(cfg.daemonDataDir, 'InstanceConfig');
      if (exists(instDir)) {
        const known = new Set(cfg.instances.map(i => i.uuid));
        let added = 0;
        for (const f of fs.readdirSync(instDir).filter(f => f.endsWith('.json'))) {
          const uuid = f.replace(/\.json$/, '');
          if (uuid === 'global0001' || known.has(uuid)) continue;
          const j = readJson(path.join(instDir, f), null);
          if (!j || !j.cwd) continue;
          if (j.nickname === SERVICE_NAME || String(j.startCommand || '').includes('mc-backup.js')) continue;
          cfg.instances.push({ uuid, name: j.nickname || uuid, dir: j.cwd, enabled: true });
          added++;
        }
        if (added) { writeJson(CONFIG_FILE, cfg); console.log(`  ✓ 发现 ${added} 个服务端，已加入备份清单`); }
        console.log('  当前备份清单：' + (cfg.instances.map(i => i.name).join('、') || '（空）'));
      }
    }
    if (WITH_SERVICE) {
      if (!RUNTIME_DIR_ARG) SVC_DIR = mcs ? path.join(mcs.root, 'backup-plugin') : path.join(__dirname, 'backup-plugin');
      else SVC_DIR = RUNTIME_DIR_ARG;
      try {
        fs.mkdirSync(SVC_DIR, { recursive: true });
        fs.copyFileSync(__filename, path.join(SVC_DIR, 'mc-backup.js'));
        const side = path.join(__dirname, 'card-backup.html');
        if (exists(side)) fs.copyFileSync(side, path.join(SVC_DIR, 'card-backup.html'));
        SVC_JS = path.join(SVC_DIR, 'mc-backup.js');
        SVC_CFG = path.join(SVC_DIR, 'mc-backup-config.json');
        writeJson(SVC_CFG, cfg);
        console.log('  ✓ 插件已安装到 ' + SVC_DIR);
      } catch (e) { console.log('  ⚠ 复制插件失败：' + e.message); }
    }
    // 卡片：优先用运行目录里那份，其次用脚本旁边那份
    const card = [path.join(SVC_DIR, 'card-backup.html'), path.join(__dirname, 'card-backup.html')].find(exists);
    if (card && cfg.panelDir) {
      const pub = exists(path.join(cfg.panelDir, 'web')) ? path.join(cfg.panelDir, 'web', 'public', 'upload_files') : path.join(cfg.panelDir, 'public', 'upload_files');
      try {
        fs.mkdirSync(pub, { recursive: true });
        fs.copyFileSync(card, path.join(pub, 'card-backup.html'));
        console.log('  ✓ 卡片已放入面板: ' + path.join(pub, 'card-backup.html'));
        await registerCard(cfg);
      } catch (e) { console.log('  ⚠ 放卡片失败：' + e.message); }
    } else if (!card) console.log('  ⚠ 没找到 card-backup.html（面板里手动加卡片即可）');
    if (WITH_SERVICE) { if (!(await createService(cfg))) writeServiceFile(cfg, mcs); }
    try { require('child_process').execFileSync(process.execPath, [__filename, 'status', '--config', CONFIG_FILE], { stdio: 'inherit' }); } catch { }
    console.log('=== 安装完成 ===');
    console.log(WITH_SERVICE ? '常驻服务已在面板实例列表里（点一下启动，或重启节点自动拉起）。'
      : '还没开常驻服务：想让它在后台自动存档，再跑： node mc-backup.js install --service');
  })();
  return;   // install 模式到此为止，不走下面的备份引擎
}

if (!exists(CONFIG_FILE)) {
  console.error('找不到配置文件: ' + CONFIG_FILE);
  console.error('如果是第一次装，先跑: node mc-backup.js install');
  process.exit(1);
}
let cfg = readJson(CONFIG_FILE, {});
cfg.include = cfg.include || [];
cfg.excludeFileNames = cfg.excludeFileNames || ['session.lock'];
cfg.fullSnapshots = cfg.fullSnapshots == null ? 0 : +cfg.fullSnapshots;
// 完整档（点「全部保存」存的那种独立一份）的兼容字段：现在份数在档位表的 full 列里，这里只留给老配置升级用
cfg.fullKeep = cfg.fullKeep == null ? 0 : +cfg.fullKeep;
// 手动保存（面板上点「立刻保存 / 全部保存」）单独留几份，默认 20
cfg.manualKeep = (cfg.manualKeep == null || +cfg.manualKeep <= 0) ? 20 : +cfg.manualKeep;
cfg.keepSnapshots = cfg.keepSnapshots || 36;
cfg.retentionHours = cfg.retentionHours || 6;
cfg.minFreeGB = cfg.minFreeGB == null ? 20 : cfg.minFreeGB;
cfg.baseMinutes = cfg.baseMinutes || 10;
cfg.exportRoot = cfg.exportRoot || path.join(cfg.backupRoot, '_exports');
cfg.tiers = cfg.tiers && cfg.tiers.length ? cfg.tiers
  : [{ minutes: 10, keep: 6, full: 0 }, { minutes: 120, keep: 1, full: 0 }];   // 默认 = 线上在用的那套
// 老配置升级：档位里没有「完整档份数」字段的补上，保持和升级前一样的行为
// （最近那档 = 原来那个「完整档保留」值，粗档各 1 份）
function migrateTiers(tiers) {
  const list = (tiers || []).slice().sort((a, b) => (+a.minutes) - (+b.minutes));
  const fk = Math.max(0, +cfg.fullKeep || 0);
  list.forEach((t, i) => { if (t.full == null) t.full = (i === 0) ? fk : (fk > 0 ? 1 : 0); });
  return tiers;
}
cfg.tiers = migrateTiers(cfg.tiers);
for (const one of (cfg.instances || [])) { if (one.tiers && one.tiers.length) migrateTiers(one.tiers); }
if (!cfg.daemonDataDir) {
  const cands = ['/opt/mcsmanager/daemon/data', '/usr/local/mcsmanager/daemon/data', '/srv/mcsmanager/daemon/data',
    'E:\\MCSM\\daemon\\data', 'D:\\MCSM\\daemon\\data', 'C:\\MCSM\\daemon\\data'];
  cfg.daemonDataDir = cands.find(c => exists(path.join(c, 'InstanceConfig'))) || cands[0];
}
cfg.instances = cfg.instances || [];

function backupRoot() { return cfg.backupRoot; }
function queueRoot() { return path.join(cfg.backupRoot, '_queue'); }
function statusFile() { return cfg.statusFile || path.join(cfg.backupRoot, 'status.json'); }
function instBackupDir(inst) { return path.join(cfg.backupRoot, inst.name); }

function saveConfig() { writeJson(CONFIG_FILE, cfg); }

// 每个实例生效的间隔 / 分档 / 备份内容（实例自己的优先，否则用全局）
function instInterval(inst) { return (inst && inst.baseMinutes > 0) ? inst.baseMinutes : cfg.baseMinutes; }
// 档位表：每档 = { minutes 每隔多少分钟, keep 增量留几份, full 完整档留几份 }（都为 0 表示这档不存）
// 兼容老的 inst.fullKeep / cfg.fullKeep：只出现在日志和状态里当「最近档的完整份数」
function instFullKeep(inst) {
  const t = instTiers(inst);
  return t.length ? (+t[t.length - 1].full || 0) : ((inst && inst.fullKeep > 0) ? +inst.fullKeep : (+cfg.fullKeep || 1));
}
function instManualKeep(inst) { return (inst && inst.manualKeep > 0) ? +inst.manualKeep : (+cfg.manualKeep || 20); }
function instTiers(inst) {
  const src = (inst && inst.tiers && inst.tiers.length) ? inst.tiers : cfg.tiers;
  return src.map(t => ({ minutes: +t.minutes, keep: +t.keep || 0, full: +t.full || 0 }))
    .filter(t => t.minutes > 0 && (t.keep > 0 || t.full > 0))
    .sort((a, b) => b.minutes - a.minutes);
}
function minInterval() {
  const list = [cfg.baseMinutes, ...cfg.instances.filter(i => i.enabled).map(i => instInterval(i))];
  return Math.max(1, Math.min(...list));
}
// 把时刻对齐到系统整刻：间隔 10 分钟 → 12:00 / 12:10 / 12:20…；间隔 2 小时 → 12:00 / 14:00…
// 这样保存时间跟系统时间对齐，不会因为进程是什么时候启动的而一直偏着几分钟
function alignedMark(ms, stepMs) {
  const step = Math.max(60000, +stepMs || 600000);
  const d = new Date(ms);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return dayStart + Math.ceil(Math.max(0, ms - dayStart) / step) * step;
}
function instNextSaveAt(inst) { return alignedMark(Date.now(), Math.max(1, instInterval(inst)) * 60000); }
// 备份内容：按实例目录里真实的大小写还原（GTNH 的世界目录叫 World，大写）
function instInclude(inst) {
  const raw = (inst && inst.include && inst.include.length) ? inst.include : cfg.include;
  let names = {};
  try {
    for (const d of fs.readdirSync(inst.dir, { withFileTypes: true })) names[d.name.toLowerCase()] = d.name;
  } catch { }
  return raw.map(r => names[String(r).toLowerCase()] || r);
}

// ---------------- 面板 API（停止/启动/发指令） ----------------
let panelToken = null;
async function panelLogin() {
  if (panelToken) return panelToken;
  const r = await fetch(cfg.panelUrl + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({ username: cfg.panelUser, password: cfg.panelPass })
  });
  const j = await r.json();
  panelToken = j.data;
  if (!panelToken || String(panelToken).length < 10) throw new Error('面板登录失败: ' + JSON.stringify(j));
  return panelToken;
}
async function panelCall(apiPath, method = 'POST') {
  const token = await panelLogin();
  const sep = apiPath.includes('?') ? '&' : '?';
  const r = await fetch(cfg.panelUrl + apiPath + sep + 'token=' + encodeURIComponent(token), {
    method, headers: { 'X-Requested-With': 'XMLHttpRequest' }
  });
  return r.json();
}
async function instStatus(uuid) {
  try {
    const r = await panelCall(`/api/service/remote_service_instances?daemonId=${cfg.daemonId}&page=1&page_size=100`, 'GET');
    const list = (r.data && r.data.data) || [];
    const hit = list.find(i => i.instanceUuid === uuid);
    return hit ? +hit.status : null;
  } catch { return null; }
}
async function instStop(uuid) { try { await panelCall(`/api/protected_instance/stop?daemonId=${cfg.daemonId}&uuid=${uuid}`); } catch { } }
async function instStart(uuid) { try { await panelCall(`/api/protected_instance/open?daemonId=${cfg.daemonId}&uuid=${uuid}`); } catch { } }
async function instCommand(uuid, cmd) {
  try { await panelCall(`/api/protected_instance/command?daemonId=${cfg.daemonId}&uuid=${uuid}&command=${encodeURIComponent(cmd)}`); } catch { }
}

// ---------------- 快照 ----------------
const SNAP_RE = /^\d{8}-\d{6}_(full|inc|hardlink)$/;

function snapshotList(inst) {
  const root = instBackupDir(inst);
  if (!exists(root)) return [];
  const out = [];
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !SNAP_RE.test(d.name)) continue;
    const dir = path.join(root, d.name);
    const meta = readJson(path.join(dir, 'meta.json'), null) || {
      type: 'full', format: 'full', createdAt: stat(dir).ctime.toISOString(), parent: '', deltaMB: null
    };
    const sizeMB = (meta.treeMB != null) ? meta.treeMB : mb(dirSize(dir));
    out.push({
      name: d.name, type: meta.type, format: meta.format || meta.type, parent: meta.parent || '',
      manual: !!meta.manual,
      baseName: meta.baseName || '',
      refreshedAt: meta.refreshedAt || '',
      refreshCount: meta.refreshCount || 0,
      createdAt: meta.createdAt, path: dir, sizeMB, deltaMB: meta.deltaMB == null ? null : meta.deltaMB,
      seconds: meta.seconds || 0, files: meta.fileCount || meta.files || 0, copied: meta.copied || 0
    });
  }
  return out.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}
function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let items = [];
    try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const it of items) {
      const p = path.join(cur, it.name);
      if (it.isDirectory()) stack.push(p);
      else { const s = stat(p); if (s) total += s.size; }
    }
  }
  return total;
}
function complete(s) { return s.format === 'full' || s.format === 'hardlink'; }
function targetSnapshot(inst, which) {
  const snaps = snapshotList(inst);
  if (!snaps.length) throw new Error(`[${inst.name}] 没有任何快照`);
  if (!which || which === 'latest') return snaps[snaps.length - 1];
  const hit = snaps.filter(s => s.name.startsWith(which));
  if (!hit.length) throw new Error(`[${inst.name}] 找不到快照: ${which}`);
  return hit[hit.length - 1];
}

// 扫一遍实例目录，得到要备份的文件清单（rel 用 / 分隔）
function scanTreeIn(rootDir, inst) {
  const list = [];
  let totalBytes = 0;
  for (const item of instInclude(inst)) {
    const p = path.join(rootDir, item);
    const st = stat(p);
    if (!st) continue;
    if (st.isFile()) {
      if (cfg.excludeFileNames.includes(path.basename(p))) continue;
      list.push({ rel: item.split(path.sep).join('/'), size: st.size, mtime: st.mtimeMs, src: p });
      totalBytes += st.size;
      continue;
    }
    const stack = [p];
    while (stack.length) {
      const cur = stack.pop();
      let items = [];
      try { items = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const it of items) {
        const cp = path.join(cur, it.name);
        if (it.isDirectory()) { stack.push(cp); continue; }
        if (cfg.excludeFileNames.includes(it.name)) continue;
        const s = stat(cp);
        if (!s) continue;
        const rel = path.relative(rootDir, cp).split(path.sep).join('/');
        list.push({ rel, size: s.size, mtime: s.mtimeMs, src: cp });
        totalBytes += s.size;
      }
    }
  }
  return { list, totalBytes };
}
function scanTree(inst) { return scanTreeIn(inst.dir, inst); }

// 「增量保存」= 刷新最近那份手动档：变了的文件覆盖进快照、没变的保持、源里删掉的从快照里删掉。
// 这样手动档不会被复制成好多份，只有「全部保存」才另起一份新的独立完整复制。
function refreshSnapshot(inst, base) {
  const { list, totalBytes } = scanTreeIn(inst.dir, inst);
  const t0 = Date.now();
  beginTask('snapshot', inst, list.length, '正在刷新手动档（增量：变化的覆盖、其余保持）');
  const want = new Set(list.map(f => f.rel));
  let copied = 0, kept = 0, removed = 0, bytes = 0, idx = 0;
  const madeDirs = new Set();
  for (const f of list) {
    idx++;
    if (idx % 200 === 0 || idx === list.length) stepTask(idx, '已刷新 ' + idx + '/' + list.length + ' 个文件');
    const dst = path.join(base.path, f.rel.split('/').join(path.sep));
    const ds = stat(dst);
    if (ds && ds.size === f.size && Math.abs(ds.mtimeMs - f.mtime) < 1) { kept++; continue; }
    const dir = path.dirname(dst);
    if (!madeDirs.has(dir)) { mkdirp(dir); madeDirs.add(dir); }
    fs.copyFileSync(f.src, dst);
    // 和时间对齐：不然下一轮又会把这份当成"变了"
    try { fs.utimesSync(dst, f.mtime / 1000, f.mtime / 1000); } catch { }
    copied++; bytes += f.size;
  }
  // 源里已经没有的文件，从快照里删掉（快照要等于"现在的样子"）
  for (const old of scanTreeIn(base.path, inst).list) {
    if (want.has(old.rel)) continue;
    try { fs.rmSync(old.src, { force: true }); removed++; } catch { }
  }
  const seconds = (Date.now() - t0) / 1000;
  const meta = readJson(path.join(base.path, 'meta.json'), {}) || {};
  const next = Object.assign({}, meta, {
    name: base.name, type: base.type, format: base.format || base.type, parent: base.parent || '',
    createdAt: meta.createdAt || base.createdAt, source: inst.dir, instanceUuid: inst.uuid,
    manual: true, baseName: '',
    files: list.length, fileCount: list.length, treeMB: mb(totalBytes),
    sizeMB: mb(bytes), deltaMB: mb(bytes),
    linked: kept, copied, linkFail: 0, seconds: Math.round(seconds * 10) / 10,
    refreshedAt: new Date().toISOString(), refreshCount: (meta.refreshCount || 0) + 1
  });
  writeJson(path.join(base.path, 'meta.json'), next);
  endTask('手动档已刷新：' + base.name + '（变化 ' + copied + ' 个 / 保持 ' + kept + ' 个'
    + (removed ? ' / 删掉 ' + removed + ' 个' : '') + '，用时 ' + next.seconds + ' 秒）');
  log(`  [${inst.name}] 刷新手动档 ${base.name}：变化 ${copied} 个 / 保持 ${kept} 个 / 删掉 ${removed} 个，用时 ${seconds.toFixed(1)}s`);
  prune(inst);
  return next;
}

function newSnapshot(inst, forceFull = false, manual = false) {
  if (!inst.enabled && !forceFull) return null;
  const snaps = snapshotList(inst);
  // 面板上的「增量保存」（manual 且非完整）：刷新最近那份手动档，而不是再建一份
  if (manual && !forceFull) {
    const base = snaps.filter(s => s.manual).slice(-1)[0];
    if (base && complete(base)) return refreshSnapshot(inst, base);
  }
  // 手动 / 自动 各自成一条链：手动增量基于「上一份手动档」增量，自动保存也只在自动档之间增量，
  // 互不干扰（面板上手动点出来的那份不会被自动轮转影响，增量基准也不会跳到自动档上）
  const pool = snaps.filter(s => !!s.manual === !!manual);
  let prev = pool.length ? pool[pool.length - 1] : null;
  // 手动档还没有基准时（比如第一次点"立刻保存"），接着最新的那份继续做增量 ——
  // 「另起一份完整复制」是「全部保存」的活，手动增量不该白抄一遍
  if (!prev && manual) prev = snaps.length ? snaps[snaps.length - 1] : null;
  const prevComplete = prev && complete(prev);
  const type = (prevComplete && !forceFull && cfg.hardlinkDeltas !== false) ? 'hardlink'
    : (prevComplete && !forceFull ? 'inc' : 'full');
  const parent = type === 'inc' && prev ? prev.name : '';

  const root = instBackupDir(inst);
  mkdirp(root);
  const pad = n => String(n).padStart(2, '0');
  // 快照名精确到秒；一秒内连着存两次会撞名，那就等一下再取名字（保持名字格式不变）
  let stamp, name, dest, waitMs = 0;
  for (;;) {
    stamp = new Date();
    name = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}_${type}`;
    dest = path.join(root, name);
    if (!exists(dest) && !exists(dest + '.tmp')) break;
    if (waitMs > 5000) throw new Error(`[${inst.name}] 连续存档太快，名字一直撞车，等一秒再试`);
    require('child_process').execSync(process.platform === 'win32' ? 'ping -n 2 127.0.0.1 > nul' : 'sleep 1');
    waitMs += 1100;
  }
  const build = dest + '.tmp';

  // 清掉上次被中断留下的半成品（只动 2 小时前的）
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (d.isDirectory() && d.name.endsWith('.tmp')) {
      const s = stat(path.join(root, d.name));
      if (s && (Date.now() - s.ctimeMs) > 2 * 3600 * 1000) {
        log(`  [${inst.name}] 清理上次中断留下的半成品 ${d.name}`, 'WARN');
        rmrf(path.join(root, d.name));
      }
    }
  }
  rmrf(build);
  mkdirp(build);

  const { list, totalBytes } = scanTree(inst);
  const t0 = Date.now();
  beginTask('snapshot', inst, list.length, '正在写入快照（' + (type === 'full' ? '完整复制' : '增量：变化的复制、其余硬链接') + '）');
  let copied = 0, linked = 0, linkFail = 0, bytes = 0;
  const madeDirs = new Set();
  let idx = 0;
  for (const f of list) {
    idx++;
    if (idx % 200 === 0 || idx === list.length) { stepTask(idx, '已处理 ' + idx + '/' + list.length + ' 个文件'); }
    const dst = path.join(build, f.rel.split('/').join(path.sep));
    const dir = path.dirname(dst);
    if (!madeDirs.has(dir)) { mkdirp(dir); madeDirs.add(dir); }
    let done = false;
    if (prevComplete && type !== 'inc') {
      const prevFile = path.join(prev.path, f.rel.split('/').join(path.sep));
      const ps = stat(prevFile);
      if (ps && ps.size === f.size && Math.abs(ps.mtimeMs - f.mtime) < 1) {
        try { fs.linkSync(prevFile, dst); linked++; done = true; } catch { linkFail++; }
      }
    } else if (type === 'inc') {
      const prevFile = path.join(prev.path, f.rel.split('/').join(path.sep));
      const ps = stat(prevFile);
      if (ps && ps.size === f.size && Math.abs(ps.mtimeMs - f.mtime) < 1) continue;   // 老式增量：没变就不写
    }
    if (!done) {
      fs.copyFileSync(f.src, dst);
      // 复制后把修改时间对齐源文件：不然下一轮比对会认为"变了"，增量退化成全量复制
      try { fs.utimesSync(dst, f.mtime / 1000, f.mtime / 1000); } catch { }
      copied++; bytes += f.size;
    }
  }
  const seconds = (Date.now() - t0) / 1000;
  const meta = {
    name, type, format: type, parent, createdAt: stamp.toISOString(), source: inst.dir, instanceUuid: inst.uuid,
    // manual = 面板上手动点出来的（立刻保存 / 全部保存）：不会进自动保存循环，也不占自动时间段的位置
    manual: !!manual,
    baseName: prev ? prev.name : '',        // 这次增量是拿哪一份当基准算的（手动链只看手动档）
    files: list.length, fileCount: list.length, treeMB: mb(totalBytes), sizeMB: mb(bytes), deltaMB: mb(bytes),
    linked, copied, linkFail, seconds: Math.round(seconds * 10) / 10, deleted: []
  };
  writeJson(path.join(build, 'meta.json'), meta);
  fs.renameSync(build, dest);          // 全部写完才改成正式名字：半成品不会被当成能回档的快照
  endTask('存档完成：' + name + '（新写入 ' + copied + ' 个 / 硬链接 ' + linked + ' 个，用时 ' + meta.seconds + ' 秒）');

  log(`  [${inst.name}] 完成${type === 'full' ? '完整' : '增量'}快照 ${name}：新写入 ${copied} 个文件 / ${mb(bytes)} MB，硬链接复用 ${linked} 个，用时 ${meta.seconds}s`);
  const iv = instInterval(inst);
  if (iv > 0 && seconds >= iv * 30) {
    log(`  [${inst.name}] 注意：本次快照用了 ${meta.seconds} 秒（${list.length} 个文件），已超过存档间隔（${iv} 分钟）的一半 —— 建议把间隔调大`, 'WARN');
  }
  prune(inst);
  return meta;
}

// ---------------- Minecraft region(.mca) 区块级读写 ----------------
// .mca 结构：前 4096 字节 = 1024 个区块位置（3 字节扇区偏移 + 1 字节扇区数，大端），接着 4096 字节时间戳；
// 每个区块的数据 = 4 字节长度 + 1 字节压缩类型 + 压缩数据。这里只按字节搬运，不解压，所以任何版本/任何模组都通用。
function mcaReadChunk(file, cx, cz) {
  let fd;
  try {
    if (!exists(file)) return null;
    const st = stat(file);
    if (!st || st.size < 8192) return null;
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(4096);
    fs.readSync(fd, header, 0, 4096, 0);
    const idx = (cx & 31) + (cz & 31) * 32;
    const offset = (header[idx * 4] << 16) | (header[idx * 4 + 1] << 8) | header[idx * 4 + 2];
    const sectors = header[idx * 4 + 3];
    if (offset <= 0 || sectors <= 0) return null;
    const payloadLen = sectors * 4096;
    const buf = Buffer.alloc(payloadLen);
    fs.readSync(fd, buf, 0, payloadLen, offset * 4096);
    const len = buf.readInt32BE(0);
    if (len <= 0 || 4 + len > payloadLen) return null;
    return buf.slice(0, 4 + len);
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { } } }
}

function mcaWriteChunk(file, cx, cz, payload) {
  const sectors = Math.ceil(payload.length / 4096);
  if (sectors > 255) throw new Error('区块数据超过 255 扇区，数据异常');
  if (!exists(file)) fs.writeFileSync(file, Buffer.alloc(8192));
  let fd = null;
  // 服务端刚关掉时文件可能还被短暂占用，重试几次
  for (let i = 0; i < 5; i++) {
    try { fd = fs.openSync(file, 'r+'); break; }
    catch (e) {
      if (i === 4) throw new Error(`无法写入 ${file}（文件被占用，确认实例已停止）: ${e.message}`);
      require('child_process').execSync(process.platform === 'win32' ? 'ping -n 3 127.0.0.1 > nul' : 'sleep 2');
    }
  }
  try {
    const header = Buffer.alloc(4096);
    fs.readSync(fd, header, 0, 4096, 0);
    const idx = (cx & 31) + (cz & 31) * 32;
    const oldOffset = (header[idx * 4] << 16) | (header[idx * 4 + 1] << 8) | header[idx * 4 + 2];
    const oldSectors = header[idx * 4 + 3];
    const size = fs.fstatSync(fd).size;
    let target;
    if (oldOffset > 0 && oldSectors * 4096 >= payload.length) {
      target = oldOffset;                              // 原位置放得下就直接覆盖
    } else {
      target = Math.ceil(size / 4096);                 // 否则追加到末尾
      if (target < 2) target = 2;
      fs.ftruncateSync(fd, target * 4096);
    }
    const buf = Buffer.alloc(sectors * 4096);
    payload.copy(buf, 0);
    fs.writeSync(fd, buf, 0, buf.length, target * 4096);
    header[idx * 4] = (target >> 16) & 0xff;           // 更新位置表
    header[idx * 4 + 1] = (target >> 8) & 0xff;
    header[idx * 4 + 2] = target & 0xff;
    header[idx * 4 + 3] = sectors;
    fs.writeSync(fd, header, idx * 4, 4, idx * 4);
    const ts = Math.floor(Date.now() / 1000);          // 更新时间戳
    const tbuf = Buffer.from([(ts >>> 24) & 0xff, (ts >>> 16) & 0xff, (ts >>> 8) & 0xff, ts & 0xff]);
    fs.writeSync(fd, tbuf, 0, 4, 4096 + idx * 4);
  } finally { try { fs.closeSync(fd); } catch { } }
}

// 方块坐标 → 区块 / 区域（1 区块 = 16×16 方块，1 区域 = 32×32 区块）
function chunkCoords(blockX, blockZ) {
  const cx = Math.floor(blockX / 16), cz = Math.floor(blockZ / 16);
  return { blockX, blockZ, chunkX: cx, chunkZ: cz, regionX: Math.floor(cx / 32), regionZ: Math.floor(cz / 32) };
}
function regionRel(world, rx, rz) { return `${world}/region/r.${rx}.${rz}.mca`; }
function relJoin(root, rel) { return path.join(root, rel.split('/').join(path.sep)); }

// 按方块坐标查这个区块在各份快照里的变化历史（新 → 旧，只留变化点）
function chunkHistory(inst, world, blockX, blockZ, limit = 20) {
  const cc = chunkCoords(blockX, blockZ);
  const rel = regionRel(world, cc.regionX, cc.regionZ);
  const snaps = snapshotList(inst).slice().reverse();
  const all = snaps.map(s => {
    const payload = mcaReadChunk(relJoin(s.path, rel), cc.chunkX, cc.chunkZ);
    return {
      name: s.name, time: new Date(s.createdAt).toLocaleString('sv-SE').slice(5, 19),
      exists: !!payload, size: payload ? payload.length : 0,
      hash: payload ? require('crypto').createHash('md5').update(payload).digest('hex') : ''
    };
  });
  const rows = [];
  for (let i = 0; i < all.length; i++) {
    const cur = all[i], older = all[i + 1];
    if (older && cur.hash === older.hash) continue;    // 和更旧那份一样就不算变化点
    rows.push({ name: cur.name, time: cur.time, exists: cur.exists, size: cur.size, hash: cur.hash ? cur.hash.slice(0, 8) : '' });
    if (rows.length >= limit) break;
  }
  return { world, blockX, blockZ, chunkX: cc.chunkX, chunkZ: cc.chunkZ, regionX: cc.regionX, regionZ: cc.regionZ,
    regionFile: rel, snapshotCount: snaps.length, rows };
}

function writeChunkHistory(inst, h) {
  const dir = path.dirname(statusFile());
  mkdirp(dir);
  const out = path.join(dir, 'mcchunk-history-' + inst.uuid + '.json');
  writeJson(out, { generatedAt: new Date().toLocaleString('sv-SE'), instanceUuid: inst.uuid, instanceName: inst.name,
    world: h.world, blockX: h.blockX, blockZ: h.blockZ, chunkX: h.chunkX, chunkZ: h.chunkZ,
    regionFile: h.regionFile, snapshotCount: h.snapshotCount, rows: h.rows });
  log(`  [${inst.name}] 区块历史已写到 ${out}（方块 X=${h.blockX} Z=${h.blockZ} → 区块 ${h.chunkX},${h.chunkZ}，${h.rows.length} 个变化点）`);
}

// 只回档一个区块：把快照里那一个区块的数据原样写回现在的区域文件（其它区块不动）
async function restoreChunk(inst, world, blockX, blockZ, which) {
  const cc = chunkCoords(blockX, blockZ);
  const snap = targetSnapshot(inst, which);
  const rel = regionRel(world, cc.regionX, cc.regionZ);
  const src = relJoin(snap.path, rel);
  if (!exists(src)) throw new Error(`[${inst.name}] 快照 ${snap.name} 里没有区域文件 ${rel}（该区块当时可能还没生成）`);
  const payload = mcaReadChunk(src, cc.chunkX, cc.chunkZ);
  if (!payload) throw new Error(`快照 ${snap.name} 里没有区块 (${cc.chunkX}, ${cc.chunkZ})（当时未生成）；如果那时确实没有这个区块，应改用「回档整个区域」`);
  log(`  [${inst.name}] 区块回档：${world} 方块(X=${cc.blockX},Z=${cc.blockZ}) → 区块(${cc.chunkX},${cc.chunkZ}) <- 快照 ${snap.name}（${payload.length} 字节）`);
  return withInstanceStopped(inst, () => {
    const backupDir = filesBackup(inst, rel);
    const dst = relJoin(inst.dir, rel);
    mkdirp(path.dirname(dst));
    if (!exists(dst)) fs.copyFileSync(src, dst);       // 现在没有这个区域文件就用快照里的垫底
    mcaWriteChunk(dst, cc.chunkX, cc.chunkZ, payload);
    log(`  [${inst.name}] 区块 (${cc.chunkX},${cc.chunkZ}) 已回档完成（原区域文件备份在 ${backupDir}）`);
  }, false);
}

// 回档整个区域文件（32×32 个区块）
async function restoreRegion(inst, world, blockX, blockZ, which) {
  const cc = chunkCoords(blockX, blockZ);
  const snap = targetSnapshot(inst, which);
  const rel = regionRel(world, cc.regionX, cc.regionZ);
  const src = relJoin(snap.path, rel);
  if (!exists(src)) throw new Error(`[${inst.name}] 快照 ${snap.name} 里没有区域文件 ${rel}`);
  log(`  [${inst.name}] 区域回档：${rel} <- 快照 ${snap.name}`);
  return withInstanceStopped(inst, () => {
    const backupDir = filesBackup(inst, rel);
    const dst = relJoin(inst.dir, rel);
    mkdirp(path.dirname(dst));
    fs.copyFileSync(src, dst);
    log(`  [${inst.name}] 区域文件 ${rel} 已回档完成（原来的备份在 ${backupDir}）`);
  }, false);
}

// ---------------- 分档保留 ----------------
// 时间块：把一份快照归到「自然时间段」。例：60 分钟档 = 每个自然小时；120 分钟档 = 每 2 小时；
// 以本地 0 点为基准切块，所以「11 点档」永远是 11:00~12:00 那一段，不随新的 10 分钟快照漂移
function timeBlock(dateMs, minutes) {
  const d = new Date(dateMs);
  const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const n = Math.floor((dateMs - dayStart) / 60000 / minutes);
  return dayStart + n * minutes * 60000;
}

// 选出要保留的快照。
// 基础档（最小间隔那档，通常是 10 分钟）= 最新 keep 份；
// 粗档（1 小时 / 2 小时 / …）= 每个自然时间段留一份，钉在「这个时间段里最早的那一份」上，
// 所以时间段一过它的档位就不再变，10 分钟那一档转多少圈都挤不掉它。
// 返回 { keep:Set<快照名>, tierOf:Map<快照名, 档位分钟> }
function planRetention(desc, tiers, base) {
  const keep = new Set(), tierOf = new Map(), tierAll = new Map();
  if (!desc.length) return { keep, tierOf, tierAll };
  const list = (tiers || []).slice().sort((a, b) => a.minutes - b.minutes);
  const baseTier = list.length ? list[0] : { minutes: Math.max(1, base || 10), keep: 6 };
  for (const s of desc.slice(0, Math.max(1, baseTier.keep))) keep.add(s.name);   // 最新的若干份永远留
  // 粗档：从最粗的一档开始认领，同一份被多档看中时算最粗的那档
  for (const t of list.slice(1).sort((a, b) => b.minutes - a.minutes)) {
    const byBlock = new Map();
    for (const s of desc) {
      const b = timeBlock(new Date(s.createdAt).getTime(), t.minutes);
      if (!byBlock.has(b)) byBlock.set(b, []);
      byBlock.get(b).push(s);                       // 每个块里按 新 → 旧 排
    }
    const newestBlocks = [...byBlock.keys()].sort((a, b) => b - a).slice(0, t.keep);
    for (const b of newestBlocks) {
      const arr = byBlock.get(b);
      const mark = arr[arr.length - 1];             // 这个时间段里最早的一份：定了就不再变
      keep.add(mark.name);
      if (!tierOf.has(mark.name)) tierOf.set(mark.name, t.minutes);
      const own = tierAll.get(mark.name) || [];
      if (own.indexOf(t.minutes) < 0) own.push(t.minutes);
      tierAll.set(mark.name, own);
    }
  }
  return { keep, tierOf, tierAll };
}

// 档位名字：60 → 1 小时档，120 → 2 小时档，10 → 10 分钟档
function tierName(minutes) {
  const m = +minutes || 0;
  return (m >= 60 && m % 60 === 0) ? (m / 60) + ' 小时档' : m + ' 分钟档';
}
// 增量快照的时间段计划（增量部分）
function retentionPlan(inst, snapsAsc) {
  const asc = snapsAsc.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));   // 不依赖调用方顺序
  const incs = asc.filter(s => s.type !== 'full');
  const cands = incs.filter(complete);
  const desc = (cands.length ? cands : incs).slice().reverse();
  return planRetention(desc, instTiers(inst), instInterval(inst));
}

// 保留总计划（prune 与状态文件共用一套算法，免得两边显示不一致）：
// 完整档也按档位表来：每档的 tier.full 就是「这一档留几份完整档」（0 = 这档不存）。
// 最近档（最小间隔那档）取最新 N 份；粗档锚点必须来自「更早且还没被占用」的时间段，
// 这样 1 小时档 / 2 小时档拿到的是不同时间的完整档，而不是三档全指向同一份
function planFullKeep(fullsDesc, tiers) {
  const picks = new Map();                                   // 快照名 → 档位分钟（0 = 最近档）
  if (!fullsDesc.length) return picks;
  const list = (tiers || []).slice().sort((a, b) => a.minutes - b.minutes);
  const byName = new Map(fullsDesc.map(s => [s.name, s]));
  const base = list[0] || { minutes: 10, full: 1 };
  if (!list.length) return picks;
  // 最近档（最小间隔那档）：留最新 base.full 份（填 0 = 不存）
  for (const s of fullsDesc.slice(0, Math.max(0, +base.full || 0))) picks.set(s.name, 0);
  for (const t of list.slice(1)) {
    let want = Math.max(0, +t.full || 0);
    if (!want) continue;                                       // 这一档填 0：不存完整档
    const taken = new Set([...picks.keys()].map(n => timeBlock(new Date(byName.get(n).createdAt).getTime(), t.minutes)));
    const byBlock = new Map();
    for (const s of fullsDesc) {
      const b = timeBlock(new Date(s.createdAt).getTime(), t.minutes);
      if (!byBlock.has(b)) byBlock.set(b, []);
      byBlock.get(b).push(s);
    }
    for (const b of [...byBlock.keys()].sort((x, y) => y - x)) {   // 新 → 旧
      if (want <= 0) break;
      if (taken.has(b)) continue;                                  // 这个时间段已经有完整档被选走了，往前找
      const arr = byBlock.get(b);
      picks.set(arr[arr.length - 1].name, t.minutes);              // 取这个时间段里最早的那份
      want--;
    }
  }
  return picks;
}

function retentionPlanAll(inst, snapsAsc) {
  const asc = snapsAsc.slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));   // 旧 → 新
  const fullKeep = instFullKeep(inst);
  const manualKeep = instManualKeep(inst);
  // 手动保存的单独一组：不进自动保存循环，也不跟自动的时间段轮转抢位置，只按份数留
  const autos = asc.filter(s => !s.manual);
  const manuals = asc.filter(s => s.manual);
  const plan = retentionPlan(inst, autos);
  const keep = new Set(plan.keep);
  const fullsAsc = autos.filter(s => s.type === 'full');
  const fullTierOf = planFullKeep(fullsAsc.slice().reverse(), instTiers(inst));
  for (const name of fullTierOf.keys()) keep.add(name);
  // 兜底：自动档里最新那一份必须留 ——「完整留 0」时第一份自动快照正好是完整复制，
  // 不留它的话它会被清掉，下一份又因为没有基准而变成完整复制、再被清掉，这个实例就永远存不下东西
  if (autos.length) keep.add(autos[autos.length - 1].name);
  for (const s of manuals.slice(-manualKeep)) keep.add(s.name);
  return { keep, tierOf: plan.tierOf, tierAll: plan.tierAll, fullKeep, fullTierOf, manualKeep };
}

function prune(inst) {
  const snaps = snapshotList(inst).slice().reverse();     // 新 → 旧
  if (!snaps.length) return;
  const tiers = instTiers(inst);
  const { keep, tierOf, fullKeep, fullTierOf, manualKeep } = retentionPlanAll(inst, snapshotList(inst));
  // 兜底：只有算出来一份都不剩时，才强行留最新那份（避免全被清空）；
  // 否则「完整档填 0」这种设置就会失效 —— 刚存的那份完整档按规则该清就清
  if (!keep.size) keep.add(snaps[0].name);
  // 老格式增量链的父快照必须一起留
  const byName = new Map(snaps.map(s => [s.name, s]));
  const queue = [...keep];
  while (queue.length) {
    const s = byName.get(queue.shift());
    if (!s) continue;
    if (!complete(s) && s.parent && !keep.has(s.parent)) { keep.add(s.parent); queue.push(s.parent); }
  }
  let removed = 0;
  for (const s of snaps) {
    if (keep.has(s.name)) continue;
    rmrf(s.path); removed++;
  }
  if (removed > 0) {
    const marks = [...tierOf].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([n, m]) => `${tierName(m)}=${n.slice(9, 15)}`).join(' ');
    const fullMarks = [...fullTierOf].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([n, m]) => `${tierName(m)}=${n.slice(9, 15)}`).join(' ');
    const manualCnt = snaps.filter(s => s.manual).length;
    log(`  [${inst.name}] 按保留策略清理 ${removed} 份旧快照（`
      + tiers.map(t => `${tierName(t.minutes)} 增量 ${t.keep} / 完整 ${t.full} 份`).join('，')
      + `；手动档另留 ${manualKeep} 份（现有 ${manualCnt} 份）；共保留 ${keep.size} 份`
      + `${marks ? '；增量时间段锚点 ' + marks : ''}`
      + `${fullMarks ? '；完整档时间段锚点 ' + fullMarks : ''}）`);
  }
}

// ---------------- 回档 / 导出 ----------------
async function withInstanceStopped(inst, body, noStart) {
  let wasRunning = false;
  if (await instStatus(inst.uuid) === 3) {
    wasRunning = true;
    log(`  [${inst.name}] 先停止实例`);
    await instStop(inst.uuid);
    let stopped = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      if (await instStatus(inst.uuid) === 0) { stopped = true; break; }
    }
    if (!stopped) throw new Error(`[${inst.name}] 等待实例停止超时，已中止（存档没被动）`);
    await new Promise(r => setTimeout(r, 3000));
  }
  try { await body(); }
  finally {
    if (wasRunning && !noStart) { await instStart(inst.uuid); log(`  [${inst.name}] 已重新启动实例`); }
  }
}
function filesBackup(inst, rel) {
  const dir = path.join(cfg.backupRoot, '_manual', new Date().toISOString().replace(/[:.]/g, '-'), inst.name);
  const src = path.join(inst.dir, rel);
  if (!exists(src)) return dir;
  const dst = path.join(dir, rel);
  mkdirp(path.dirname(dst));
  copyTree(src, dst);
  return dir;
}
function worldList(snapDir, inst) {
  const skip = new Set(['_state', 'config', 'kubejs', 'defaultconfigs', 'mods', 'logs', 'libraries', 'crash-reports',
    'local', 'modernfix', 'journeymap', 'resourcepacks', 'visualprospecting', 'TCNodeTracker', 'serverutilities']);
  const out = [];
  let tops = [];
  try { tops = fs.readdirSync(snapDir, { withFileTypes: true }).filter(d => d.isDirectory() && !skip.has(d.name)); } catch { return out; }
  for (const d of tops) {
    const stack = [{ dir: path.join(snapDir, d.name), depth: 0 }];
    while (stack.length) {
      const cur = stack.pop();
      const hasLevel = exists(path.join(cur.dir, 'level.dat'));
      let regionCount = 0, regionBytes = 0;
      const regionDir = path.join(cur.dir, 'region');
      if (exists(regionDir)) {
        for (const f of fs.readdirSync(regionDir)) {
          if (!f.endsWith('.mca')) continue;
          const s = stat(path.join(regionDir, f)); if (s) { regionCount++; regionBytes += s.size; }
        }
      }
      if (hasLevel || regionCount > 0) {
        const rel = path.relative(snapDir, cur.dir).split(path.sep).join('/');
        out.push({ world: rel, regions: regionCount, sizeMB: mb(regionBytes), kind: worldKind(rel, cur.dir) });
      }
      if (cur.depth >= 5) continue;
      for (const sub of fs.readdirSync(cur.dir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        if (['region', 'entities', 'poi', 'data', 'DIM_data', 'playerdata', 'players', 'stats', 'advancements'].includes(sub.name)) continue;
        stack.push({ dir: path.join(cur.dir, sub.name), depth: cur.depth + 1 });
      }
    }
  }
  return out;
}
function worldKind(rel, dir) {
  const p = rel.replace(/\\/g, '/');
  const low = p.toLowerCase();
  const leaf = p.split('/').pop();
  const leafLow = String(leaf).toLowerCase();       // GTNH 的世界目录叫 World（大写），这里一律按小写比
  let kind = '';
  if (leafLow === 'world') kind = '主世界';
  else if (leafLow === 'world_nether') kind = '下界';
  else if (leafLow === 'world_the_end') kind = '末地';
  else if (leafLow === 'dim-1') kind = '下界(DIM-1)';
  else if (leafLow === 'dim1') kind = '末地(DIM1)';
  else {
    let m = low.match(/\/dimensions\/minecraft\/([^/]+)$/);
    if (m) kind = { overworld: '主世界', the_nether: '下界', the_end: '末地' }[m[1]] || ('原版维度 ' + m[1]);
    else if ((m = low.match(/\/dimensions\/([^/]+)\/([^/]+)$/))) kind = `${m[1]} 的 ${m[2]}`;
    else if ((m = leaf.match(/^DIM(-?\d+)$/i))) {
      const id = +m[1];
      kind = (id >= 100 || id <= -100) ? `个人维度 ${leaf}（GTNH 这类一人一个岛）` : `模组维度 ${leaf}`;
    }
  }
  if (/flat/i.test(low)) kind = kind ? kind + ' · 平坦' : '平坦世界';
  else if (/void/i.test(low)) kind = kind ? kind + ' · 虚空' : '虚空世界';
  return kind;
}
function playerList(snapDir, inst, nameMap) {
  const out = [];
  for (const w of worldList(snapDir, inst)) {
    const wdir = path.join(snapDir, w.world.split('/').join(path.sep));
    for (const [sub, legacy] of [['playerdata', false], ['players', true]]) {
      const pdir = path.join(wdir, sub);
      if (!exists(pdir)) continue;
      for (const f of fs.readdirSync(pdir)) {
        if (!f.endsWith('.dat')) continue;
        const key = f.replace(/\.dat$/, '');
        const s = stat(path.join(pdir, f));
        out.push({
          world: w.world, key, uuid: legacy ? '' : key, name: legacy ? key : (nameMap[key.toLowerCase()] || ''),
          legacy, sizeKB: s ? Math.round(s.size / 1024 * 10) / 10 : 0,
          mtime: s ? new Date(s.mtimeMs).toLocaleString('sv-SE').slice(5, 16) : '',
          stats: exists(path.join(wdir, 'stats', key + '.json')), adv: exists(path.join(wdir, 'advancements', key + '.json')),
          mainRel: `${sub}/${key}.dat`
        });
      }
    }
  }
  return out;
}
function playerNameMap(inst) {
  const map = {};
  const uc = path.join(inst.dir, 'usercache.json');
  const ucJson = readJson(uc, []);
  for (const e of (Array.isArray(ucJson) ? ucJson : [])) if (e.uuid && e.name && e.name !== 'Unknown') map[e.uuid.toLowerCase()] = e.name;
  for (const f of ['usernamecache.json', 'ops.json', 'whitelist.json', 'banned-players.json']) {
    const j = readJson(path.join(inst.dir, f), null);
    if (!j) continue;
    if (Array.isArray(j)) for (const e of j) if (e.uuid && e.name) map[e.uuid.toLowerCase()] = e.name;
    else for (const [k, v] of Object.entries(j)) if (v && v !== 'Unknown') map[k.toLowerCase()] = v;
  }
  return map;
}
function playerRelFiles(key, legacy) {
  const base = legacy ? 'players' : 'playerdata';
  return [`${base}/${key}.dat`, `${base}/${key}.dat_old`, `stats/${key}.json`, `advancements/${key}.json`];
}
// 玩家存档目录别只按 key 的形状猜：先看这个玩家在源目录里到底躺在 playerdata 还是 players（GTNH 是 players/名字.dat）
function playerBaseOf(worldDir, key, legacy) {
  const guess = legacy ? 'players' : 'playerdata';
  if (exists(path.join(worldDir, guess, key + '.dat'))) return guess;
  const other = guess === 'players' ? 'playerdata' : 'players';
  if (exists(path.join(worldDir, other, key + '.dat'))) return other;
  return guess;
}
function playerFilesOf(worldDir, key, legacy) {
  const base = playerBaseOf(worldDir, key, legacy);
  return { base, rels: playerRelFiles(key, base === 'players') };
}
function restoreWorld(inst, world, snapName, restoreTo, noStart) {
  const snap = targetSnapshot(inst, snapName);
  const src = path.join(snap.path, world.split('/').join(path.sep));
  if (!exists(src)) throw new Error(`[${inst.name}] 快照 ${snap.name} 里没有 ${world}`);
  log(`  [${inst.name}] 世界回档: ${world}  <- 快照 ${snap.name}`);
  if (restoreTo) {
    const dst = path.join(restoreTo, world.split('/').join(path.sep));
    mkdirp(path.dirname(dst));
    copyTree(src, dst);
    log(`  [${inst.name}] 已还原到 ${dst}（演练，未动线上）`);
    return;
  }
  return withInstanceStopped(inst, () => {
    beginTask('restore', inst, 0, '正在备份当前世界，然后还原…');
    const dir = filesBackup(inst, world);
    const dst = path.join(inst.dir, world);
    rmrf(dst); mkdirp(dst);
    copyTreeProgress(src, dst, { task: 'restore', inst: inst, message: '正在还原世界 ' + world, done: '世界 ' + world + ' 已还原' });
    log(`  [${inst.name}] 世界 ${world} 已回档完成（原目录备份在 ${dir}）`);
  }, noStart);
}
function restorePlayer(inst, world, key, snapName, restoreTo, noStart) {
  const snap = targetSnapshot(inst, snapName);
  const legacy = !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key);
  const snapWorld = path.join(snap.path, world.split('/').join(path.sep));
  const legacyFixed = playerBaseOf(snapWorld, key, legacy) === 'players';   // 以快照里的真实位置为准
  const rels = playerRelFiles(key, legacyFixed).filter(r => exists(path.join(snapWorld, r.split('/').join(path.sep))));
  if (!rels.length) throw new Error(`[${inst.name}] 快照 ${snap.name} 里没有玩家 ${key} 的存档（${world}）`);
  log(`  [${inst.name}] 玩家回档: ${world}/${key} <- 快照 ${snap.name}（${rels.length} 个文件）`);
  if (restoreTo) {
    for (const r of rels) {
      const dst = path.join(restoreTo, world, r.split('/').join(path.sep));
      mkdirp(path.dirname(dst));
      fs.copyFileSync(path.join(snap.path, world, r.split('/').join(path.sep)), dst);
    }
    log(`  [${inst.name}] 已还原到 ${restoreTo}（演练，未动线上）`);
    return;
  }
  return withInstanceStopped(inst, () => {
    const dir = filesBackup(inst, path.join(world, legacyFixed ? 'players' : 'playerdata'));
    for (const r of rels) {
      const dst = path.join(inst.dir, world, r.split('/').join(path.sep));
      mkdirp(path.dirname(dst));
      fs.copyFileSync(path.join(snap.path, world, r.split('/').join(path.sep)), dst);
    }
    log(`  [${inst.name}] 玩家 ${key} 已回档完成（原文件备份在 ${dir}）`);
  }, noStart);
}
function transferPlayer(inst, world, srcKey, dstKey, from, restoreTo, noStart) {
  const useLive = !from || from === 'live';
  const srcRoot = useLive ? inst.dir : targetSnapshot(inst, from).path;
  const legacy = !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(srcKey);
  const srcWorld = path.join(srcRoot, world.split('/').join(path.sep));
  const legacyFixed = playerBaseOf(srcWorld, srcKey, legacy) === 'players';   // 以来源里的真实位置为准
  const map = [];
  for (const r of playerRelFiles(srcKey, legacyFixed)) {
    const s = path.join(srcRoot, world, r.split('/').join(path.sep));
    if (!exists(s)) continue;
    const dirPart = r.split('/')[0];
    const ext = r.slice(r.indexOf(srcKey) + srcKey.length);
    map.push({ src: s, dst: path.join(world, dirPart, dstKey + ext) });
  }
  if (!map.length) throw new Error(`[${inst.name}] 找不到玩家 ${srcKey} 的存档（世界 ${world}）`);
  log(`  [${inst.name}] 玩家数据转移: ${srcKey} -> ${dstKey}  世界 ${world}  来源 ${useLive ? '线上' : '快照 ' + from}（${map.length} 个文件）`);
  if (restoreTo) {
    for (const m of map) {
      const dst = path.join(restoreTo, m.dst.split('/').join(path.sep));
      mkdirp(path.dirname(dst));
      fs.copyFileSync(m.src, dst);
    }
    log(`  [${inst.name}] 已写出到 ${restoreTo}（演练，未动线上）`);
    return;
  }
  return withInstanceStopped(inst, () => {
    const dir = filesBackup(inst, world);
    for (const m of map) {
      const dst = path.join(inst.dir, m.dst.split('/').join(path.sep));
      mkdirp(path.dirname(dst));
      fs.copyFileSync(m.src, dst);
    }
    log(`  [${inst.name}] 已把 ${srcKey} 的存档给 ${dstKey}（目标原存档备份在 ${dir}）`);
  }, noStart);
}
function exportInstance(inst, snapName, opt = {}) {
  const snap = targetSnapshot(inst, snapName || 'latest');
  const root = cfg.exportRoot;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const safe = s => String(s).replace(/[\\/:*?"<>|、·]/g, '_');
  const tag = opt.player ? '-玩家' : (opt.world ? '-' + safe(opt.world) : '');
  const dest = path.join(root, `${inst.name}${tag}_${stamp}`);
  mkdirp(dest);
  const skipPlayerDirs = new Set(['playerdata', 'players', 'stats', 'advancements']);
  if (opt.player) {
    const legacy = !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(opt.player);
    let got = 0;
    for (const r of playerRelFiles(opt.player, legacy)) {
      const s = path.join(snap.path, opt.world || 'world', r.split('/').join(path.sep));
      if (!exists(s)) continue;
      const dst = path.join(dest, opt.world || 'world', r.split('/').join(path.sep));
      mkdirp(path.dirname(dst));
      fs.copyFileSync(s, dst); got++;
    }
    if (!got) throw new Error(`[${inst.name}] 快照里没有玩家 ${opt.player} 的存档`);
    log(`  [${inst.name}] 已导出玩家 ${opt.player} 的存档（${got} 个文件）到 ${dest}`);
    return dest;
  }
  const isRoot = !opt.world;
  let n = 0;
  // 先数一下总量，进度条才有百分比
  let totalFiles = 0;
  for (const item of instInclude(inst)) {
    const s = opt.world ? path.join(snap.path, opt.world.split('/').join(path.sep)) : path.join(snap.path, item);
    if (!exists(s)) continue;
    totalFiles += countFiles(s);
    if (opt.world) break;
  }
  beginTask('export', inst, totalFiles, '正在导出（' + (opt.world ? '世界 ' + opt.world : (opt.player ? '玩家' : '整份存档')) + '）');
  const cp = (s, d) => {
    const st = stat(s);
    if (!st) return;
    if (st.isFile()) {
      mkdirp(path.dirname(d)); fs.copyFileSync(s, d); n++;
      if (n % 100 === 0 || n === totalFiles) stepTask(n);
      return;
    }
    if (isRoot && opt.dropPlayerData && skipPlayerDirs.has(path.basename(s))) return;
    for (const it of fs.readdirSync(s, { withFileTypes: true })) cp(path.join(s, it.name), path.join(d, it.name));
  };
  for (const item of instInclude(inst)) {
    const s = opt.world ? path.join(snap.path, opt.world.split('/').join(path.sep)) : path.join(snap.path, item);
    if (!exists(s)) continue;
    const d = opt.world ? path.join(dest, opt.world.split('/').join(path.sep)) : path.join(dest, item);
    cp(s, d);
    if (opt.world) break;
  }
  const lines = ['Minecraft 存档导出', `实例: ${inst.name}`, `快照: ${snap.name}（${snap.createdAt}）`,
    `导出时间: ${new Date().toLocaleString('sv-SE')}`,
    `玩家数据: ${opt.dropPlayerData ? '不包含' : (opt.onlyPlayer ? '只包含 ' + opt.onlyPlayer : '包含全部玩家')}`, '',
    '用法：把里面的内容放回服务端实例目录即可。'];
  fs.writeFileSync(path.join(dest, '导出说明.txt'), lines.join(os.EOL), 'utf8');
  endTask('导出完成（' + n + ' 个文件）→ ' + dest);
  log(`  [${inst.name}] 导出完成：${dest}（${n} 个文件）`);
  return dest;
}
function exportServer(inst, clean) {
  const root = cfg.exportRoot;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const tag = clean ? '纯净服务端' : '服务端';
  const dest = path.join(root, `${inst.name}_${tag}_${stamp}`);
  mkdirp(dest);
  // 找出「存档目录」：自己含 level.dat，或下一层含 level.dat
  const saveDirs = [];
  for (const d of fs.readdirSync(inst.dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const p = path.join(inst.dir, d.name);
    if (exists(path.join(p, 'level.dat'))) { saveDirs.push(d.name); continue; }
    for (const sub of fs.readdirSync(p, { withFileTypes: true })) {
      if (sub.isDirectory() && exists(path.join(p, sub.name, 'level.dat'))) saveDirs.push(path.join(d.name, sub.name));
    }
  }
  const skipTop = new Set(['backups', '_backups']);
  const skipClean = new Set([...saveDirs, 'logs', 'crash-reports', 'serverutilities']);
  const skipFiles = clean ? new Set(['ops.json', 'whitelist.json', 'usercache.json', 'usernamecache.json', 'banned-players.json', 'banned-ips.json']) : new Set();
  let n = 0;
  const walk = (srcDir, dstDir, rel) => {
    for (const it of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const relPath = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) {
        if (skipTop.has(it.name)) continue;
        if (clean && skipClean.has(relPath)) continue;
        if (clean && skipClean.has(it.name) && !rel) continue;
        mkdirp(path.join(dstDir, it.name));
        walk(path.join(srcDir, it.name), path.join(dstDir, it.name), relPath);
      } else {
        if (clean && skipFiles.has(it.name)) continue;
        fs.copyFileSync(path.join(srcDir, it.name), path.join(dstDir, it.name)); n++;
        if (n % 100 === 0) stepTask(n);
      }
    }
  };
  beginTask('export', inst, countFiles(inst.dir), clean ? '正在导出纯净服务端…' : '正在导出整个服务端…');
  walk(inst.dir, dest, '');
  endTask((clean ? '纯净服务端' : '整个服务端') + '导出完成（' + n + ' 个文件）');
  const lines = ['Minecraft 服务端导出', `实例: ${inst.name}`, `原目录: ${inst.dir}`,
    `导出时间: ${new Date().toLocaleString('sv-SE')}`];
  if (clean) {
    lines.push('类型: 纯净服务端（不含存档 / 玩家数据）', '已排除:', '  - 存档目录 ' + (saveDirs.join('、') || '（无）'),
      '  - logs / crash-reports（含玩家名字和 IP）', '  - serverutilities（家园/传送点/权限）',
      '  - ops.json / whitelist.json / usercache.json / usernamecache.json / banned-*.json');
  }
  lines.push('', '用法：整份拷到目标机器，装好对应 Java，执行里面的启动脚本即可。');
  fs.writeFileSync(path.join(dest, '导出说明.txt'), lines.join(os.EOL), 'utf8');
  log(`  [${inst.name}] ${tag}导出完成：${dest}（${n} 个文件）`);
  return dest;
}

// ---------------- 状态文件（卡片读它） ----------------
// 当前正在做的事（给面板卡片画进度条）：写到状态文件旁边的 mcbackup-progress.json，卡片直接 fetch
let task = null;
let heartbeat = null;
function progressFile() { return path.join(path.dirname(statusFile()), 'mcbackup-progress.json'); }
function beginTask(kind, inst, total, message) {
  task = { task: kind, instance: inst ? inst.name : '', total: total || 0, done: 0, percent: 0,
    startedAt: Date.now(), updatedAt: Date.now(), message: message || '' };
  // 心跳：大文件复制时可能几十秒才走到下一个 100 文件节点，靠它让卡片的「已用 X 秒」继续走
  if (!heartbeat) {
    // unref：命令行一次性跑（status / snapshot / queue）时别让心跳把进程吊住不退出
    heartbeat = setInterval(() => {
      if (task && task.task !== 'done') { task.updatedAt = Date.now(); writeProgress(); }
    }, 1000);
    if (heartbeat.unref) heartbeat.unref();
  }
  writeProgress();
}
function stepTask(done, message) {
  if (!task) return;
  task.done = done;
  task.percent = task.total > 0 ? Math.min(99, Math.floor(done * 100 / task.total)) : 0;
  task.updatedAt = Date.now();
  if (message) task.message = message;
  writeProgress();
}
function endTask(message) {
  if (!task) return;
  if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
  const t = task;
  // 完成态要跟「空闲」分开写：卡片靠 task 字段判断画不画条，写 idle 的话完成条会被当成空态藏掉
  task = { task: 'done', instance: t.instance, total: t.total, done: t.done, percent: 100,
    startedAt: t.startedAt, updatedAt: Date.now(),
    message: message || ((t.task === 'snapshot' ? '存档完成' : '完成') + '（用时 ' + Math.round((Date.now() - t.startedAt) / 100) / 10 + ' 秒）') };
  writeProgress();
  // 完成状态保留 90 秒，之后清成 idle 空态
  // unref：同上，完成态保留 90 秒只是给面板看的，不该拖住一次性进程的退出
  const clearDone = setTimeout(() => { if (task && task.task === 'done') { task = null; writeProgress(); } }, 90000);
  if (clearDone.unref) clearDone.unref();
}
function writeProgress() {
  try {
    const doc = task
      ? { task: task.task, instance: task.instance, total: task.total, done: task.done, percent: task.percent,
          startedAt: new Date(task.startedAt).toLocaleString('sv-SE'), updatedAt: new Date(task.updatedAt).toLocaleString('sv-SE'),
          seconds: Math.round((task.updatedAt - task.startedAt) / 100) / 10, message: task.message }
      : { task: 'idle' };
    writeJson(progressFile(), doc);
  } catch { }
}

function writeStatus() {
  const list = [];
  for (const inst of cfg.instances) {
    const snaps = snapshotList(inst);
    const newest = snaps.length ? snaps[snaps.length - 1] : null;
    const latestDir = newest ? newest.path : null;
    const worlds = latestDir ? worldList(latestDir, inst).map(w => ({
      world: w.world, kind: w.kind, regions: w.regions, sizeMB: w.sizeMB,
      note: (inst.notes && inst.notes[w.world]) || '',
      snaps: snaps.slice(-12).filter(s => exists(path.join(s.path, w.world.split('/').join(path.sep)))).map(s => s.name)
    })) : [];
    const nameMap = playerNameMap(inst);
    const players = latestDir ? playerList(latestDir, inst, nameMap).map(p => ({
      world: p.world, worldKind: (worlds.find(w => w.world === p.world) || {}).kind || '',
      key: p.key, uuid: p.uuid, name: p.name, legacy: p.legacy, sizeKB: p.sizeKB, mtime: p.mtime, stats: p.stats, adv: p.adv,
      snaps: snaps.slice(-12).filter(s => exists(path.join(s.path, p.world, p.mainRel.split('/').join(path.sep)))).map(s => s.name)
    })) : [];
    const totalMB = snaps.reduce((a, s) => a + (s.deltaMB != null ? s.deltaMB : s.sizeMB), 0);
    const treeMB = snaps.reduce((a, s) => a + s.sizeMB, 0);
    const iv = instInterval(inst);
    const tiersOfInst = instTiers(inst);
    const plan = retentionPlanAll(inst, snaps);
    const tierBase = tiersOfInst.length ? tiersOfInst[tiersOfInst.length - 1].minutes : iv;
    list.push({
      uuid: inst.uuid, name: inst.name, enabled: !!inst.enabled,
      // 类型按「真实类型」统计：full=完整复制，hardlink/inc=增量（都要能独立回档，但卡片上要分清）
      count: snaps.length, fulls: snaps.filter(s => s.type === 'full').length, incs: snaps.filter(s => s.type !== 'full').length,
      latest: newest ? newest.name : '', latestTime: newest ? new Date(newest.createdAt).toLocaleString('sv-SE').slice(5, 19) : '',
      totalMB: Math.round(totalMB * 10) / 10, treeMB: Math.round(treeMB * 10) / 10,
      lastSeconds: newest ? newest.seconds : 0, lastFiles: newest ? newest.files : 0, lastCopied: newest ? newest.copied : 0,
      slow: !!(newest && iv > 0 && newest.seconds >= iv * 30),
      interval: iv, include: instInclude(inst),
      tiers: instTiers(inst).map(t => ({ minutes: t.minutes, keep: t.keep, full: t.full })).reverse(),
      fullKeep: instFullKeep(inst),
      manualKeep: instManualKeep(inst),
      manualCount: snaps.filter(s => s.manual).length,
      // 下一次自动存档的时间（按系统时间对齐到的整刻）
      nextSaveAt: new Date(instNextSaveAt(inst)).toLocaleString('sv-SE').slice(11, 19),
      ownInterval: !!(inst.baseMinutes > 0), ownTiers: !!(inst.tiers && inst.tiers.length), ownInclude: !!(inst.include && inst.include.length),
      ownFullKeep: !!(inst.fullKeep > 0),
      snapshots: snaps.slice().reverse().map(s => ({
        name: s.name, type: s.type, sizeMB: s.sizeMB,
        manual: !!s.manual,                      // 手动保存（面板点出来的）
        refreshedAt: s.refreshedAt ? new Date(s.refreshedAt).toLocaleString('sv-SE').slice(5, 19) : '',
        refreshCount: s.refreshCount || 0,       // 这份手动档被"增量保存"刷新过几次
        deltaMB: s.deltaMB != null ? s.deltaMB : s.sizeMB, time: new Date(s.createdAt).toLocaleString('sv-SE').slice(5, 19),
        // 完整档也按时间段分组（基础档 = 最近的，记 0；粗档 = 被 1 小时/2 小时档钉住的）；
        // 增量的按时间段分组，取最粗那档，另附被哪几档同时钉住
        tier: s.type === 'full' ? (plan.fullTierOf.get(s.name) || 0) : (plan.tierOf.get(s.name) || tierBase),
        tiers: s.type === 'full'
          ? (plan.fullTierOf.has(s.name) ? [plan.fullTierOf.get(s.name)] : [])
          : (plan.tierAll.get(s.name) || []).slice().sort((a, b) => a - b)
      })),
      lastType: newest ? newest.type : '',
      worlds, players
    });
  }
  let pending = 0;
  try { pending = countRequests(queueRoot()); } catch { }
  const doc = {
    generatedAt: new Date().toLocaleString('sv-SE'), serverTime: new Date().toLocaleString('sv-SE'),
    fullSnapshots: cfg.fullSnapshots, pending, instances: list,
    daemonId: cfg.daemonId, backupRoot: cfg.backupRoot, queueRoot: queueRoot(), exportRoot: cfg.exportRoot,
    include: cfg.include, daemonDataDir: cfg.daemonDataDir,
    settings: { baseMinutes: +cfg.baseMinutes, keepSnapshots: sumKeep(instTiers(null)), fullKeep: +cfg.fullKeep,
      manualKeep: +cfg.manualKeep,
      tiers: instTiers(null).map(t => ({ minutes: t.minutes, keep: t.keep, full: t.full })) }
  };
  writeJson(statusFile(), doc);
  return doc;
}
function sumKeep(tiers) { return tiers.reduce((a, t) => a + t.keep, 0); }
function countRequests(root) {
  const known = new Set(cfg.instances.map(i => i.uuid));
  let n = 0;
  if (!exists(root)) return 0;
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === 'done' || d.name === '_orphan') continue;
    if (!known.has(d.name)) continue;          // 不认识的目录不算待处理（避免遗留请求一直堆着）
    for (const f of fs.readdirSync(path.join(root, d.name))) if (f.endsWith('.req')) n++;
  }
  return n;
}

// ---------------- 面板请求队列 ----------------
function setInclude(listText, target) {
  const items = String(listText).split(/[,;\s]+/).map(s => s.trim().replace(/[\\/]+$/, '')).filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i);
  if (!items.length) throw new Error('备份内容至少要填一项');
  for (const i of items) {
    if (/^[A-Za-z]:/.test(i) || i.startsWith('/') || i.startsWith('\\\\')) throw new Error(`必须填实例目录里的相对路径：${i}`);
    if (/[*?]/.test(i)) throw new Error(`不支持通配符：${i}`);
    if (/(^|[\\/])\.\.([\\/]|$)/.test(i)) throw new Error(`不能往上跳目录：${i}`);
    if (['backups', '_backups', 'logs', 'crash-reports', '_state'].includes(i)) throw new Error(`「${i}」不作为备份内容`);
  }
  if (target && target !== 'global') {
    const inst = cfg.instances.find(i => i.uuid === target);
    if (!inst) throw new Error('找不到服务端: ' + target);
    inst.include = items;
    log(`[${inst.name}] 的备份内容已单独设置（${items.length} 项）`);
  } else {
    cfg.include = items;
    log(`全局备份内容已更新（${items.length} 项）`);
  }
  saveConfig();
}
function applySettings(jsonText) {
  const s = JSON.parse(jsonText);
  const target = s.d && s.d !== 'global' ? s.d : '';
  if (target) {
    const inst = cfg.instances.find(i => i.uuid === target);
    if (!inst) throw new Error('找不到服务端: ' + target);
    if (s.x) {
      delete inst.baseMinutes; delete inst.tiers; delete inst.include; delete inst.fullKeep;
      saveConfig();
      log(`[${inst.name}] 的存档设置已改回「跟随全局」（间隔 ${instInterval(inst)} 分钟）`);
      prune(inst);
      return;
    }
    const base = +s.b;
    if (!(base >= 1 && base <= 1440)) throw new Error('存档间隔要在 1~1440 分钟之间');
    const tiers = parseTiers(s.t, base);
    // 老卡片兼容：还带 f 字段的，把它当成「最近那档的完整档份数」
    if (s.f != null && s.f !== '' && tiers.length) {
      const f = +s.f;
      if (!(f >= 0 && f <= 500)) throw new Error('完整档保留份数要在 0~500');
      tiers[tiers.length - 1].full = f;
    }
    inst.baseMinutes = base; inst.tiers = tiers;
    saveConfig();
    log(`[${inst.name}] 的存档设置已单独设置：间隔 ${base} 分钟；`
      + tiers.map(t => `每 ${t.minutes} 分钟 增量 ${t.keep} / 完整 ${t.full} 份`).join('，'));
    prune(inst);
    return;
  }
  // 全局：间隔 / 分档 / 路径
  if (s.r) {
    const nb = String(s.r).replace(/[\\/]+$/, ''), ne = String(s.e || cfg.exportRoot).replace(/[\\/]+$/, '');
    if (!/^([A-Za-z]:[\\/]|\/)/.test(nb) || !/^([A-Za-z]:[\\/]|\/)/.test(ne)) throw new Error('路径要填完整路径');
    if (nb === ne) throw new Error('导出位置不能和存档位置一样');
    if (nb !== cfg.backupRoot) {
      log(`开始把存档位置从 ${cfg.backupRoot} 换成 ${nb}`);
      mkdirp(nb);
      const sameDrive = path.parse(cfg.backupRoot).root === path.parse(nb).root;
      for (const inst of cfg.instances) {
        const from = instBackupDir(inst), to = path.join(nb, inst.name);
        if (!exists(from) || exists(to)) continue;
        const newest = snapshotList(inst).filter(complete).pop();
        if (sameDrive) { fs.renameSync(from, to); log(`  [${inst.name}] 已搬到 ${to}`); }
        else if (newest) {
          mkdirp(to);
          copyTree(newest.path, path.join(to, newest.name));
          log(`  [${inst.name}] 最新快照 ${newest.name} 已复制到新位置（更早的仍在原处）`);
        }
      }
      cfg.backupRoot = nb;
    }
    cfg.exportRoot = ne;
  }
  if (s.b) {
    const base = +s.b;
    if (!(base >= 1 && base <= 1440)) throw new Error('存档间隔要在 1~1440 分钟之间');
    cfg.baseMinutes = base;
    cfg.tiers = parseTiers(s.t, base);
    if (s.f != null && s.f !== '' && cfg.tiers.length) {      // 老卡片兼容
      const f = +s.f;
      if (!(f >= 0 && f <= 500)) throw new Error('完整档保留份数要在 0~500');
      cfg.tiers[cfg.tiers.length - 1].full = f;
    }
    cfg.fullKeep = cfg.tiers.length ? cfg.tiers[cfg.tiers.length - 1].full : 1;
    cfg.keepSnapshots = sumKeep(cfg.tiers);
  }
  saveConfig();
  mkdirp(cfg.backupRoot); mkdirp(queueRoot()); mkdirp(cfg.exportRoot);
  for (const inst of cfg.instances) mkdirp(path.join(queueRoot(), inst.uuid));
  log(`备份设置已更新：存档间隔 ${cfg.baseMinutes} 分钟；`
    + instTiers(null).map(t => `每 ${t.minutes} 分钟 增量 ${t.keep} / 完整 ${t.full} 份`).join('，'));
  log(`  存档位置: ${cfg.backupRoot}；导出位置: ${cfg.exportRoot}`);
  for (const inst of cfg.instances) prune(inst);
}
function parseTiers(arr, base) {
  const tiers = [];
  for (const pair of (arr || [])) {
    const m = +pair[0], k = +pair[1] || 0, f = pair[2] == null ? 0 : +pair[2];
    if (!(m > 0) && !(k > 0) && !(f > 0)) continue;
    if (!(m >= 1)) throw new Error('档位间隔不合法');
    if (!(k >= 0 && k <= 500)) throw new Error('增量保留份数要在 0~500（0 = 这档不存增量）');
    if (!(f >= 0 && f <= 500)) throw new Error('完整档保留份数要在 0~500（0 = 这档不存完整档）');
    if (!(k > 0) && !(f > 0)) throw new Error(`第 ${m} 分钟这一档：增量和完整都填 0 就没意义了，至少留一个`);
    if (m < base) throw new Error(`档位间隔（${m} 分钟）不能小于存档间隔（${base} 分钟）`);
    tiers.push({ minutes: m, keep: k, full: f });
  }
  if (!tiers.length) throw new Error('至少要保留一档');
  const seen = new Set(), uniq = [];
  for (const t of tiers.sort((a, b) => a.minutes - b.minutes)) { if (seen.has(t.minutes)) continue; seen.add(t.minutes); uniq.push(t); }
  return uniq;
}

async function processQueue() {
  const root = queueRoot();
  if (!exists(root)) return 0;
  let handled = 0;
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === 'done') continue;
    const uuid = d.name;
    const inst = cfg.instances.find(i => i.uuid === uuid);
    if (!inst) {
      // 不认识的实例目录：把里面的请求挪到 _orphan，别一直堆在队列里
      const od = path.join(root, '_orphan', uuid);
      mkdirp(od);
      let moved = 0;
      for (const f of fs.readdirSync(path.join(root, uuid))) {
        if (!f.endsWith('.req')) continue;
        try { fs.renameSync(path.join(root, uuid, f), path.join(od, f)); moved++; } catch { }
      }
      if (moved) log(`队列里 ${uuid} 不是已知实例，${moved} 个请求已挪到 _orphan`, 'WARN');
      continue;
    }
    const dir = path.join(root, uuid);
    const reqs = fs.readdirSync(dir).filter(f => f.endsWith('.req')).sort();
    for (const file of reqs) {
      const req = file.replace(/\.req$/, '');
      log(`面板请求: [${inst.name}] ${req}`);
      let ok = true;
      handled++;
      try {
        // 面板上点出来的：标记 manual，自动保存循环会忽略它们
        if (req === 'snapshot') newSnapshot({ ...inst, enabled: true }, false, true);
        else if (req === 'snapshot-full') newSnapshot({ ...inst, enabled: true }, true, true);
        else if (req === 'restore-latest') await restoreAll(inst, 'latest');
        else if (req.startsWith('restore-')) await restoreAll(inst, req.slice('restore-'.length));
        else if (req === 'enable') { inst.enabled = true; saveConfig(); }
        else if (req === 'disable') { inst.enabled = false; saveConfig(); }
        else if (req.startsWith('restoreworld-')) {
          const parts = req.slice('restoreworld-'.length).split('~');
          await restoreWorld(inst, b64uDecode(parts[0]), parts[1] || 'latest', null, false);
        } else if (req.startsWith('restoreplayer-')) {
          const p = req.slice('restoreplayer-'.length).split('~');
          await restorePlayer(inst, b64uDecode(p[0]), b64uDecode(p[1]), p[2] || 'latest', null, false);
        } else if (req.startsWith('restorechunk-')) {
          const p = req.slice('restorechunk-'.length).split('~');
          if (!(p.length >= 3)) throw new Error('区块回档参数不对');
          await restoreChunk(inst, b64uDecode(p[0]), Math.round(+p[1]), Math.round(+p[2]), p[3] || 'latest');
        } else if (req.startsWith('restoreregion-')) {
          const p = req.slice('restoreregion-'.length).split('~');
          if (!(p.length >= 3)) throw new Error('区域回档参数不对');
          await restoreRegion(inst, b64uDecode(p[0]), Math.round(+p[1]), Math.round(+p[2]), p[3] || 'latest');
        } else if (req.startsWith('findchunk-')) {
          const p = req.slice('findchunk-'.length).split('~');
          if (!(p.length >= 3)) throw new Error('区块查询参数不对');
          writeChunkHistory(inst, chunkHistory(inst, b64uDecode(p[0]), Math.round(+p[1]), Math.round(+p[2])));
        } else if (req.startsWith('xferplayer-')) {
          const p = req.slice('xferplayer-'.length).split('~');
          await transferPlayer(inst, b64uDecode(p[0]), b64uDecode(p[1]), b64uDecode(p[2]), p[3] || 'live', null, false);
        } else if (req.startsWith('exportsave-')) {
          const p = req.split('~'); const snapName = p[0].slice('exportsave-'.length);
          await exportInstance(inst, snapName, { dropPlayerData: p[1] === 'none', onlyPlayer: p[2] ? b64uDecode(p[2]) : '' });
        } else if (req.startsWith('exportworld-')) {
          const p = req.split('~');
          await exportInstance(inst, p[1] || 'latest', { world: b64uDecode(p[0].slice('exportworld-'.length)), dropPlayerData: p[2] === 'none' });
        } else if (req.startsWith('exportplayer-')) {
          const p = req.split('~');
          await exportInstance(inst, p[2] || 'latest', { world: b64uDecode(p[0].slice('exportplayer-'.length)), player: b64uDecode(p[1]) });
        } else if (req === 'exportserver') exportServer(inst, false);
        else if (req === 'exportserver-clean') exportServer(inst, true);
        else if (req.startsWith('delsnap-')) {
          const name = req.slice('delsnap-'.length);
          const snaps = snapshotList(inst);
          const t = snaps.find(s => s.name === name);
          if (!t) throw new Error('找不到快照: ' + name);
          if (snaps.some(s => s.parent === t.name)) throw new Error('它是老格式增量链的父快照，不能删');
          rmrf(t.path);
          log(`  [${inst.name}] 已删除快照 ${t.name}`);
        } else if (req.startsWith('note-')) {
          const body = req.slice('note-'.length);
          const i = body.lastIndexOf('~');
          const w = b64uDecode(body.slice(0, i)), n = b64uDecode(body.slice(i + 1));
          inst.notes = inst.notes || {};
          if (n) inst.notes[w] = n; else delete inst.notes[w];
          saveConfig();
          log(`  [${inst.name}] 世界 ${w} 备注: ${n || '(清除)'}`);
        } else if (req.startsWith('settings-')) applySettings(b64uDecode(req.slice('settings-'.length)));
        else if (req.startsWith('setinclude-')) setInclude(b64uDecode(req.slice('setinclude-'.length)), '');
        else if (req.startsWith('setinc-')) {
          const m = req.match(/^setinc-([0-9a-zA-Z\-]+)~(\d+)~(\d+)~([A-Za-z0-9\-_]*)$/);
          if (!m) throw new Error('分片名字不对');
          const who = m[1], idx = +m[2], total = +m[3], chunk = m[4];
          const stage = path.join(cfg.backupRoot, '_incparts', who);
          mkdirp(stage);
          fs.writeFileSync(path.join(stage, idx + '.part'), chunk);
          const have = fs.readdirSync(stage).filter(f => f.endsWith('.part')).length;
          log(`备份内容分片 ${idx + 1}/${total} 已收到（${have}/${total}）`);
          if (have >= total) {
            let all = '';
            for (let i = 0; i < total; i++) { const f = path.join(stage, i + '.part'); if (exists(f)) all += fs.readFileSync(f, 'utf8'); }
            setInclude(b64uDecode(all), who === 'global' ? '' : who);
            rmrf(stage);
          }
        } else { log(`未知请求: ${req}`, 'WARN'); ok = false; }
      } catch (e) { log(`请求执行失败: ${e.message}`, 'ERROR'); ok = false; }
      const doneDir = path.join(dir, 'done');
      mkdirp(doneDir);
      try {
        fs.renameSync(path.join(dir, file), path.join(doneDir, `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}-${req}.${ok ? 'ok' : 'fail'}.done`));
      } catch { }
    }
  }
  return handled;
}
async function restoreAll(inst, which) {
  const snap = targetSnapshot(inst, which);
  log(`  [${inst.name}] 整包回档到 ${snap.name}`);
  return withInstanceStopped(inst, () => {
    filesBackup(inst, '.');
    beginTask('restore', inst, 0, '正在整包还原…');
    for (const item of instInclude(inst)) {
      const s = path.join(snap.path, item), d = path.join(inst.dir, item);
      if (!exists(s)) continue;
      rmrf(d); mkdirp(path.dirname(d));
      copyTreeProgress(s, d, { task: 'restore', inst: inst, message: '正在还原 ' + item, done: '整包回档完成（' + item + '）' });
    }
    log(`  [${inst.name}] 整包回档完成`);
  }, false);
}

// ---------------- 入口 ----------------
function findInstance(key) {
  const hit = cfg.instances.find(i => i.uuid === key || i.name === key);
  if (!hit) throw new Error('找不到服务端: ' + key);
  return hit;
}
function arg(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : ''; }

(async () => {
  const action = (process.argv[2] || 'status').toLowerCase();
  mkdirp(cfg.backupRoot); mkdirp(queueRoot());
  for (const inst of cfg.instances) mkdirp(path.join(queueRoot(), inst.uuid));
  const only = arg('-i') || arg('--instance') || '';
  try {
    switch (action) {
      case 'status': { const d = writeStatus(); log(`状态文件已更新：${statusFile()}（${d.instances.length} 个服务端）`); break; }
      case 'snapshot': {
        const targets = only ? [findInstance(only)] : cfg.instances.filter(i => i.enabled);
        for (const inst of targets) {
          const own = inst.baseMinutes > 0;
          // 只看自动档：手动保存不参与自动保存循环，不能因为它就跳过这一轮
          const snaps = snapshotList(inst).filter(s => !s.manual);
          const newest = snaps.length ? snaps[snaps.length - 1] : null;
          if (own && newest) {
            const ageMin = (Date.now() - new Date(newest.createdAt)) / 60000;
            if (ageMin < Math.max(1, instInterval(inst) - 1)) {
              log(`  [${inst.name}] 单独设置的间隔是 ${instInterval(inst)} 分钟，距上一份才 ${Math.round(ageMin * 10) / 10} 分钟，这一轮跳过`);
              continue;
            }
          }
          newSnapshot(inst);
        }
        writeStatus();
        break;
      }
      case 'queue': await processQueue(); writeStatus(); break;
      case 'watch': {
        log(`常驻模式启动：每 5 秒处理面板请求；自动存档对齐系统整刻（最小间隔 ${minInterval()} 分钟）`);
        let queueBusy = false;
        const nextAt = new Map();   // 每个实例下一次该在哪个整刻存档
        // 面板请求 5 秒一查：点了「保存 / 回档 / 导出」很快就有反应（原来 60 秒一查，卡片上看着像没动静）
        const queueTick = async () => {
          // 上一轮还没跑完就别开新的一轮：回档要停服/开服，可能好几分钟，
          // 否则同一个 .req 会被再执行一遍（请求文件是跑完才改名的）
          if (queueBusy) return;
          queueBusy = true;
          try {
            const handled = await processQueue();
            if (handled) writeStatus();     // 有请求才会重写状态文件，平时不白写盘
          } catch (e) { log('队列处理出错: ' + e.message, 'ERROR'); }
          finally { queueBusy = false; }
        };
        // 自动存档：算好「下一个整刻」，到点才存（启动时如果已经过期就先补一份，别等满一个间隔）
        const planNext = inst => {
          const step = Math.max(1, instInterval(inst)) * 60000;
          // 只看「自动存的」那份新不新：手动保存不参与自动保存循环，不能因为它而推迟下一次自动存档
          const newest = snapshotList(inst).filter(s => !s.manual).slice(-1)[0];
          const stale = !newest || (Date.now() - new Date(newest.createdAt).getTime()) >= step;
          const at = stale ? Date.now() : alignedMark(Date.now(), step);   // 过期 → 立刻补
          nextAt.set(inst.uuid, at);
          return at;
        };
        const snapTick = async () => {
          const now = Date.now();
          let did = false;
          for (const inst of cfg.instances.filter(i => i.enabled)) {
            const at = nextAt.has(inst.uuid) ? nextAt.get(inst.uuid) : planNext(inst);
            if (now < at) continue;
            nextAt.set(inst.uuid, alignedMark(now + 1000, Math.max(1, instInterval(inst)) * 60000));
            try {
              newSnapshot(inst);
              did = true;
              log(`  [${inst.name}] 本轮整刻存档时间：${new Date().toLocaleString('sv-SE')}（下次 ${new Date(nextAt.get(inst.uuid)).toLocaleString('sv-SE')}）`);
            } catch (e) { log('快照失败: ' + e.message, 'ERROR'); }
          }
          if (did) writeStatus();
        };
        // 状态刷新：60 秒一轮（存档本身走上面的整刻调度）
        const fullTick = async () => {
          try { writeStatus(); } catch (e) { }
        };
        for (const inst of cfg.instances.filter(i => i.enabled)) planNext(inst);
        await queueTick(); await snapTick(); await fullTick();
        setInterval(() => { queueTick().catch(() => { }); }, 5000);
        setInterval(() => { snapTick().catch(() => { }); }, 5000);
        setInterval(() => { fullTick().catch(() => { }); }, 60000);
        break;
      }
      case 'prune': for (const inst of cfg.instances) prune(inst); writeStatus(); break;
      case 'list': {
        for (const inst of cfg.instances) {
          const snaps = snapshotList(inst);
          console.log(`=== [${inst.name}] ${inst.enabled ? '备份中' : '已停用'} 快照 ${snaps.length} 份 ===`);
          for (const s of snaps.reverse()) console.log(`   ${s.name}  ${s.sizeMB} MB  ${s.createdAt}`);
        }
        break;
      }
      default: console.log('用法: node mc-backup.js [status|snapshot|queue|watch|prune|list] [-i 实例名]'); break;
    }
  } catch (e) { log('执行失败: ' + (e && e.message ? e.message : e), 'ERROR'); process.exitCode = 1; }
})();
