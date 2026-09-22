# AGENTS.md — 给 AI 编码助手看的项目说明

这份文件是给 AI（Codex / Claude Code / Cursor 等）读的：**改这个仓库之前先看这里**。
人类请先看 [README.md](README.md)。

## 这是什么

MCSManager（面板 + 节点）用的 **Minecraft 多服务端滚动备份组件**。只有两个运行文件：

| 文件 | 作用 |
| --- | --- |
| [`src/mc-backup.js`](src/mc-backup.js) | 备份引擎（快照 / 回档 / 导出 / 保留策略 / 一键安装），Windows + Linux 通用，只依赖 Node，无第三方依赖 |
| [`web/card-backup.html`](web/card-backup.html) | MCSManager 面板卡片（插件卡片），读状态 JSON、往队列写请求文件 |

## 目录结构

```
src/mc-backup.js         引擎（含一键安装 install）
web/card-backup.html     面板卡片
docs/安装说明.md          面向使用者的安装 / 配置 / 常见问题（随发布包一起发）
docs/索引.md              ★ 文件 / 函数 / 数据格式 / 请求类型 全索引（改代码先查这里）
examples/mc-backup-config.example.json   配置样例
tests/*.js               自动化测试（沙盒 + 卡片 + 链路 + 保留策略）
.github/workflows/test.yml   CI：Linux 上跑测试
```

## 数据流（改代码前必须理解）

```
面板卡片 (card-backup.html)
   │  ① 读状态：GET /upload_files/mcbackup-status.json      （引擎每 60 秒 / 每次请求后写）
   │  ② 下指令：往队列写空文件  <backupRoot>/_queue/<实例uuid>/<命令>.req
   ▼
引擎常驻进程 (node mc-backup.js watch)
   │  每 5 秒扫队列 → 执行请求 → 改名为 <时间戳>-<命令>.ok.done / .fail.done
   │  自动存档按「系统整刻」触发（10 分钟档 = 12:00/12:10/…）
   │  任务进度写 <状态文件同目录>/mcbackup-progress.json
   ▼
备份目录 <backupRoot>/<实例名>/<YYYYMMDD-HHMMSS>_<full|inc|hardlink>/
```

## 硬性约定（改之前务必遵守）

1. **JSON 一律 UTF-8 无 BOM**（`writeJson()` 已封装）。Windows 上带 BOM 会让卡片 `fetch().json()` 失败。
2. **队列文件名里不要出现中文**：中文会让完整路径顶到 Windows 260 上限（实测 258 能建、260 静默失败）。文字一律 base64url 编码，格式见 `docs/索引.md`。
3. **改了 `web/card-backup.html` 必须顶版本号**：面板对 `/upload_files/` 下的文件发 `Cache-Control: max-age=86400`（缓存 24 小时），浏览器只认 URL 上的 `?v=`。做法是把 `面板目录/web/data/layout.json` 里 `card-backup.html?v=...` 的数字改成新的（Unix 秒即可）。
4. **快照复制后要 `utimesSync` 对齐 mtime**：否则下一轮增量会把"刚复制的文件"全当成变化文件，增量退化成全量。
5. **节点/面板的敏感信息不要提交**：`panelUser` / `panelPass` / `daemonId` / 节点 key / 实例 uuid 只应存在于运行目录的配置文件和你自己的密码目录里，仓库里只放 `examples/` 样例。卡片里的 `DAEMON_ID_FALLBACK` / `QUEUE_ROOT_FALLBACK` 必须是空串。
6. **一次性运行的进程不能被子定时器吊住**：`setInterval` / `setTimeout` 用在命令行路径上时要 `.unref()`（历史 bug：完成态定时器没 unref，`node mc-backup.js status` 要空等 90 秒才退出）。

## 保留策略（最容易改错的地方）

档位表：`tiers: [{ minutes, keep, full }]`

- `minutes` 档位跨度，`keep` 该档保留的**增量**份数，`full` 该档保留的**完整档**份数；**0 = 这档不存**
- 最小那档按"最新 N 份"滚动；更粗的档按**自然时间段**各钉一份（1 小时档 = 每个整点那一小时留最早的一份，2 小时档 = 每 2 小时一段），时间段一过锚点就固定 → 10 分钟档转多少圈都挤不掉粗档
- **手动档**（面板点"立刻保存 / 全部保存"产生，`meta.manual = true`）不参与上面这套：单独按 `manualKeep`（默认 20）留最新几份
- **手动 / 自动分开**：自动存档每轮新建一份、只在自动档之间增量；手动档则是「一份可刷新的档 + 若干历史」：
  - `newSnapshot(inst, false, true)`（立刻保存）= **刷新最近那份手动档**（`refreshSnapshot()`：变化的文件覆盖进快照、
    没变的保持、源里删掉的从快照里删掉），**不新建目录**；还没有手动档时才新建一份（接着最新那份做增量）
  - `newSnapshot(inst, true, true)`（全部保存）= 另起一份独立的完整复制（`forceFull`），之后的手动增量刷新它
  - `meta.refreshedAt` / `meta.refreshCount` 记录刷新；`meta.baseName` 只在新建时记录基准
- 兜底：自动档里"最新那份"一定留（否则"完整留 0"时第一份完整复制会被清掉 → 永远没有基准 → 实例存不下东西）

相关函数：`planRetention()` / `planFullKeep()` / `retentionPlanAll()` / `prune()`，都在 `src/mc-backup.js`，`docs/索引.md` 里有逐条说明。

## 改完必须跑的测试

```bash
node tests/sandbox-test.js     # 全功能沙盒（真实引擎 + 假 GTNH 服务端，跑全部面板请求）
node tests/chain-test.js       # 手动/自动两条链、保留策略
node tests/card-test.js        # 卡片脚本（假 DOM）
node tests/retention-test.js   # 时间段锚点 vs 旧算法对比
```

四个脚本都用相对路径（可用环境变量 `MC_BACKUP_ENGINE` / `MC_BACKUP_CARD` / `MC_BACKUP_TMP` 覆盖），Linux 上同样能跑，CI 见 `.github/workflows/test.yml`。

## 版本与发布

- 用户侧版本号写在 `docs/安装说明.md` 顶部（现在是 `版本 1.0`），加了功能或修了 bug 就 +0.1，并往 `CHANGELOG.md` 顶部加一节
- 发布包 = `src/mc-backup.js` + `web/card-backup.html` + `docs/安装说明.md` 三个文件（用户只要这三个）
