# 合成大奶龙：Netlify 全局排行榜上线说明

网站继续部署在 Netlify。新增的 Netlify Functions 负责游客身份和成绩，Netlify Database（PostgreSQL）负责永久保存。首页内嵌游戏与 `sixth.html` 共用同一榜单。

## 1. 将代码更新到 GitHub

把本次代码提交、推送到 Netlify 绑定的生产分支（通常是 `main`）。需要包含 `package.json`、`package-lock.json`、`netlify.toml`、`netlify/`、`server/`、`scripts/`、排行榜 JS/CSS 和两个 HTML 页面的修改。

不要上传 `node_modules/`、`dist/`、`.env` 或 `.netlify/`；这些已在 `.gitignore` 中排除。本文档应一并提交，方便以后维护。若代码仍在 `codex/dragon-leaderboard` 分支，先测试预览，再合并到生产分支。

## 2. 检查 Netlify 构建设置

打开 Netlify 中现有站点，在 **Project configuration → Build & deploy → Continuous deployment → Build settings** 检查：

| 项目 | 值 |
| --- | --- |
| Base directory | 留空（仓库根目录） |
| Build command | `npm run build` |
| Publish directory | `dist` |
| Functions directory | `netlify/functions` |
| Node.js | `24` |

这些已写入 `netlify.toml`，通常无需重复填写。若控制台中保留了其他配置，确认最终构建日志使用的是上面的配置。`dist` 只包含页面和公共资源，不能把仓库根目录作为发布目录，否则可能公开服务端文件。

如曾设置 `NODE_ENV=production` 或 `NPM_FLAGS=--omit=dev`，本地验证依赖可能不会安装；线上构建本身只使用 Node 标准库，不依赖开发测试包。

## 3. 启用数据库

在站点的 **Data & Storage → Database** 选择 **Create a database manually**（如果已有数据库，不要重复创建）。数据库区域优先与 Functions 保持一致。

当前 Netlify Database 仅适用于 credit-based 套餐，数据库运行和流量消耗账户额度；请在控制台确认自己的套餐支持和可用额度。没有 Database 入口时，不要用 Blobs 或本地文件临时替代，也不用把任何密钥写到 HTML：应先确认套餐，或后续调整为外部 PostgreSQL。

代码使用 `@netlify/database`，连接信息由 Netlify 注入，无需手动复制数据库密码，也无需创建游客登录服务或配置前端 API Key。Netlify 官方也支持在检测到依赖和迁移后于部署时自动创建数据库；提前在控制台创建可以更明确地确认账户是否支持。

## 4. 重新部署

在 **Deploys** 触发最新生产分支的部署。依赖安装后执行 `npm run build`，Netlify 打包两个函数，并在发布前自动执行：

`netlify/database/migrations/202610040001_dragon_leaderboard.sql`

成功后数据库中应出现 `dragon_players`、`dragon_runs`、`dragon_rate_limits` 三张表。迁移文件无需手工运行，也不要重复粘贴执行；若迁移失败，先查看部署日志再重试。

函数包括：

- `dragon`：提供 `/api/dragon/*` 接口。
- `dragon-cleanup`：每天 03:17 UTC（北京时间 11:17）清理超过 30 天的对局和过期限流记录，保留玩家最高分。

## 5. 验证线上结果

1. 打开 `https://你的站点域名/api/dragon/leaderboard`，应返回 JSON，首次为 `entries: []`。
2. 打开首页的合成大奶龙，确认出现游客昵称和“全球排行榜”；修改昵称并保存。
3. 完成一局，确认结算显示“已上传”及个人最高分。
4. 用另一个浏览器或手机打开同一正式域名，排行榜应看到刚才的玩家。
5. 同一个游客再打出更低成绩，最高分应保持不变；`/sixth.html` 和首页应显示相同的游客与榜单。
6. 开启手机浏览器，检查榜单能滚动查看前 20 名，滚动时不会切换到其他游戏。

请始终使用同一个正式域名。自定义域名与 `netlify.app` 子域名的 Cookie 不互通，会被识别为不同游客。Deploy Preview 通常使用独立数据库分支，预览成绩不会写入正式榜单。

## 常见问题

| 现象 | 排查 |
| --- | --- |
| `/api/dragon/leaderboard` 返回 404 | 确认通过 Git 构建部署，存在 `dragon` 函数；不要只拖拽上传静态文件；检查 Functions directory。 |
| 接口返回 503 | 确认数据库已经创建、迁移成功、账户额度可用；数据库开通后重新部署；查看函数日志。 |
| 页面没有排行榜按钮 | 确认生产分支包含两个 HTML 改动，最新部署已发布，刷新页面缓存。 |
| 本局“未联网登记” | 开局时接口连接失败；本局仍能游玩，但无法补建对局上榜。恢复网络后开始新的一局。 |
| 成绩“未上传” | 若对局已登记，点击“重试上传”；同标签页刷新后会尝试补交。开始后超过 24 小时未提交的对局失效。 |
| 操作太频繁 | 等待限流窗口结束；所有操作同 IP 每分钟 180 次，新游客同 IP 每小时 20 个，每位游客每小时 120 次开局请求。共享网络用户也共享 IP 限额，可在 `server/api.mjs` 调整。 |
| 换设备/清除浏览器数据后纪录不见 | 游客身份按浏览器 Cookie 保存，不是实名账号；旧成绩仍在榜单，个人身份不能自动恢复。 |

## 本地验证

使用 Node.js 24：

```sh
npm ci
npm test
npm run build
npm run dev
```

打开 `http://localhost:8888` 或 `/sixth.html`。本地使用 PGlite 执行真实 PostgreSQL 表结构和事务；数据库存在内存中，服务停止就清空，绝不会连接生产数据库。这适合完整验证登录、改名、结算和排行榜。它不验证 Netlify 云端账户、网络和数据库实际开通情况。

## 排名与数据约定

- 历史最高分排行，一位游客最多占一个位置，公开前 20 名。
- 同分时按服务器记录的达成时间先后排序，再按玩家 ID 稳定排序；重打同分不会改变原达成时间。
- Cookie 为 HttpOnly、HTTPS 下为 Secure；数据库仅存会话凭据的 SHA-256 摘要，不向前端公开摘要或原始凭据。
- 开局请求有幂等编号，提交只能对应自己的对局；重复提交相同成绩返回原结果，修改已提交成绩会被拒绝。
- 当前规则版本 `dragon-v1`，分数接受 0–10,000,000 范围内的 10 的整数倍。以后改变计分方式，应同时设计新赛季/版本榜单，不直接混用不可比较的成绩。
- 离线已登记成绩保存在当前标签页的 sessionStorage，刷新后可重试；关闭标签页可能丢失未上传成绩。
- 对局 24 小时内可首次结算；已结算对局保留 30 天用于幂等重试。自动清理不删除个人最高分。
- 前端仍负责计分。格式检查、身份校验、限流与幂等不是强防作弊；本版本定位为娱乐榜，不适合作为有奖比赛的唯一评判依据。

官方参考：[Functions](https://docs.netlify.com/build/functions/overview/)、[Database 开通](https://docs.netlify.com/build/data-and-storage/netlify-database/getting-started/)、[自动迁移](https://docs.netlify.com/build/data-and-storage/netlify-database/migrations/)、[套餐与额度](https://docs.netlify.com/build/data-and-storage/netlify-database/billing-and-usage/)。
