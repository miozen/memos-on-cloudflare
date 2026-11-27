# 当前架构

本文是当前有效架构的摘要与索引。背景与部署操作见 [README.md](../README.md)，认证状态的完整说明见 [web/docs/auth-architecture.md](../web/docs/auth-architecture.md)；本文不重复复制这些内容。

## 项目定位与技术栈

把 Memos 笔记应用迁移到 Cloudflare 边缘平台：Workers + Hono 提供 API，D1 存结构化数据，R2 存附件，KV 做可选缓存，Workers AI 负责转写与标签建议，Static Assets 托管前端。

- 入口与绑定：[worker/src/index.ts](../worker/src/index.ts)、[wrangler.toml](../wrangler.toml)、[worker/src/types.ts](../worker/src/types.ts)。
- 前端：React 18 + Vite 7 + TypeScript + Tailwind 4 + React Query + i18next；REST JSON 替代原版 gRPC/Connect，兼容层在 [web/src/connect.ts](../web/src/connect.ts) 与 [web/src/shims](../web/src/shims)。
- 运行时：Node 通过 WSL nvm 管理，版本以 [.node-version](../.node-version)（22）为准；详见 [DECISIONS.md](DECISIONS.md) D007。

## 模块地图与职责

| 层 | 路径 | 职责 |
| --- | --- | --- |
| API 入口 | `worker/src/index.ts` | 挂载 11 组 `/api/v1/*` 路由、`/file/*`、分享/`/u/*`、RSS；统一 404/500 响应。 |
| 认证 | `worker/src/middleware/auth.ts`, `worker/src/auth/*` | JWT（HS256，access 15min / refresh 30d）、PAT、OAuth/SSO、bcrypt 密码。 |
| 业务路由 | `worker/src/routes/memos.ts`, `users.ts`, `auth.ts`, `attachments.ts`, `files.ts`, `ai.ts`, `instance.ts`, `idp.ts`, `shortcuts.ts`, `rss.ts`, `sse.ts` | 备忘录 CRUD/评论/反应/分享、用户与设置、附件、下载、AI、实例、身份提供商、快捷方式、RSS、SSE。 |
| 数据访问 | `worker/src/db/*` | D1 裸 SQL 查询与 UPSERT；无 ORM。 |
| 过滤与派生 | `worker/src/filter/memo-filter.ts`, `worker/src/tags.ts`, `worker/src/default-tags.ts`, `worker/src/cache.ts` | 筛选 DSL 编译、标签解析、默认/PKM 标签、KV 缓存。 |
| 副作用 | `worker/src/notification.ts`, `worker/src/webhook.ts` | Inbox/邮件通知与 Webhook 投递，多走 `executionCtx.waitUntil`。 |
| 前端 | `web/src/router/*`, `web/src/contexts/*`, `web/src/hooks/*`, `web/src/components/*`, `web/src/pages/*` | 路由守卫、实例/认证/视图/筛选 Context、查询与编辑器组件。 |

## 核心业务流程

1. **认证**：登录或 SSO → 签发 access/refresh → 前端 `web/src/auth-state.ts` 保存 token，`web/src/api/client.ts` 统一 Bearer、401 刷新重放；PAT 走 `X-API-Key` 等请求头（`worker/src/middleware/auth.ts`）。
2. **备忘录**：`POST/GET/PATCH/DELETE /api/v1/memos` → D1 读写 → 批量补齐附件、关系、反应（`worker/src/routes/memos.ts` 的 `enrichMemos`）→ 失效统计缓存 → 后台投递 Webhook。评论是带 `payload.parent` 的子 memo，并用 `memo_relation(type='COMMENT')` 关联。
3. **附件**：先上传 R2（key 为 `attachments/{uid}/{filename}`）再写 D1，失败做反向删除；下载全部经 `/file/*` Worker 代理并校验可见性，支持 Range（`worker/src/routes/attachments.ts`、`files.ts`）。
4. **AI**：Whisper 转写与标签建议通过 Workers AI；模型白名单与回退在 `worker/src/ai-models.ts`，提示词与结果规范化在 `worker/src/routes/ai.ts`。
5. **前端数据流**：`web/src/main.tsx` 初始化 Instance/Auth → `AuthContext` 作为用户态权威并预填 React Query 缓存 → 页面通过 `web/src/hooks/*` 查询；编辑器本地防抖草稿在 `web/src/components/MemoEditor/hooks/useAutoSave.ts`，真正保存由 `services/memoService.ts` 提交。

## 数据库与持久化

Schema 与索引依次由 [0001_initial.sql](../migrations/0001_initial.sql)、[0002_webhooks.sql](../migrations/0002_webhooks.sql)、[0003_performance_indexes.sql](../migrations/0003_performance_indexes.sql) 定义：用户、设置、memo（含 `payload` JSON）、关系、附件、IdP、inbox、reaction、share、user_identity、webhook。R2 只存二进制；KV 仅缓存实例配置/统计与链接元数据，缺失时可直通。

## 关键架构约束与实现特性

- JWT_SECRET 必配；KV 可选；附件上限 100MB；静态资源经 `run_worker_first` 让 API 路径优先生效（[wrangler.toml](../wrangler.toml)）。
- 认证用户态以 `AuthContext` 为权威，这是有意决策，见 [DECISIONS.md](DECISIONS.md) D003 与 `web/docs/auth-architecture.md`。
- 前端保留 protobuf/Connect 风格调用面，通过 Vite/Vitest alias 指向 shims（[vite.config.mts](../web/vite.config.mts)）；不要误认为项目仍在使用 gRPC 后端。
- 当前 D1 多步写入均为顺序执行，没有 `batch`/事务；新功能不能假设跨语句原子性（例：`worker/src/routes/memos.ts` 删除 memo、附件重绑与标签批量重命名）。
- `/api/v1/sse` 目前仅心跳（`worker/src/routes/sse.ts`），实时刷新主要依赖前端焦点/可见性事件。

## 构建、运行与部署

- 本地：WSL nvm 加载 Node 22 → `npm run db:migrate` → `npm run dev`（Worker 8787）+ `npm run dev:web`（Vite 3001，代理 `/api`、`/file`）。
- 验证：本地以类型检查与单元测试为准（`npm test`、`npx tsc --noEmit`、`npm --prefix web test`、`npm --prefix web exec tsc -- --noEmit --skipLibCheck`），不要求本地执行 Vite 生产构建（详见 [DECISIONS.md](DECISIONS.md) D011）。
- 部署：GitHub Actions 仅校验（[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)）；生产构建与部署由 Cloudflare Workers Git 集成执行 `ci:build` 与 `ci:deploy`，后者先执行远程迁移再用 `--keep-vars` 部署（[scripts/deploy-workers.mjs](../scripts/deploy-workers.mjs)）。真实 Workers AI 效果在实际运行环境中验证；远端推送通道约定见 [DECISIONS.md](DECISIONS.md) D008。
