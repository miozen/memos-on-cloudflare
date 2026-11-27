# 已确认决策

状态：Proposed（待确认）、Accepted（已确认）、Superseded（已替代）。Accepted 决策不得由 AI 擅自推翻；需要变更时先请求用户确认，并把旧条目标记为 Superseded。

仓库此前没有正式决策编号，本表自 D001 起编号；已有文档（如 `web/docs/auth-architecture.md`）继续作为详细依据，不重新编号、不复制全文。

| 编号 | 状态 | 决策内容 | 主要理由 | 依据 |
| --- | --- | --- | --- | --- |
| D001 | Accepted | 采用 Cloudflare Workers + Hono + D1 + R2 + KV + Workers AI + Static Assets 承载 Memos。 | 替代 Go/SQLite/本地存储，实现无服务器部署。 | [README.md](../README.md)、[wrangler.toml](../wrangler.toml)、[worker/src/index.ts](../worker/src/index.ts)。 |
| D002 | Accepted | 前端用 REST JSON 替代 Connect RPC/protobuf，但保留 service 风格调用面与 shims 兼容层。 | 降低边缘运行时依赖，同时保留原 Memos 前端结构的迁移路径。 | [README.md](../README.md)、[web/src/connect.ts](../web/src/connect.ts)、[web/src/shims](../web/src/shims)、[web/vite.config.mts](../web/vite.config.mts)。 |
| D003 | Accepted | 认证状态以 `AuthContext` 为单一来源，React Query 只缓存服务端数据并由 AuthContext 预填。 | 同步初始化、避免各组件重复处理 loading 与竞态。 | [web/docs/auth-architecture.md](../web/docs/auth-architecture.md)、`web/src/contexts/AuthContext.tsx`。 |
| D004 | Accepted | 首个注册用户自动成为 ADMIN，并幂等初始化默认标签/颜色规则。 | 保证新实例可自举，重复部署不产生重复数据。 | `worker/src/routes/auth.ts`、`worker/src/routes/users.ts`、`worker/src/default-tags.ts`、`worker/tests/default-tags.test.mjs`。 |
| D005 | Accepted | 附件二进制存 R2，元信息存 D1，下载统一经 `/file/*` Worker 代理并做可见性校验。 | 避免私有文件直连公开 URL，支持 Range 与统一鉴权。 | `worker/src/routes/attachments.ts`、`worker/src/routes/files.ts`、`migrations/0001_initial.sql`。 |
| D006 | Accepted | GitHub Actions 只做校验；生产部署由 Cloudflare Workers Git 集成执行 `ci:build` / `ci:deploy`，部署前先跑远程迁移。 | 避免在 GitHub 侧保存 Cloudflare Secrets，统一部署入口。 | [README.md](../README.md)、[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)、[scripts/deploy-workers.mjs](../scripts/deploy-workers.mjs)。 |
| D007 | Accepted | Node 在 WSL 中通过 nvm 安装，版本遵循 [.node-version](../.node-version)（22）；`npm` / `npx` / `wrangler` 使用前需加载 nvm 环境。 | 多电脑开发环境一致性；2026-11-27 用户提供并核实 WSL `~/.nvm` 已安装 v22.23.4。 | [.node-version](../.node-version)、[package.json](../package.json)、WSL `~/.nvm`（仓库外环境）。 |
| D008 | Accepted | 远端推送通过 WSL 的 SSH 443 通道：WSL `~/.ssh/config` 将 `github.com` 指向 `ssh.github.com:443`。 | 用户约定的多电脑推送方式；2026-11-27 用户提供并核实该配置存在。 | WSL `~/.ssh/config`（仓库外环境）；待确认项见下方说明。 |
| D009 | Accepted | 采用五个核心文件作为统一入口，同一事实只在一处维护；已有有效文档通过引用保留。 | 支持新会话、上下文压缩、多电脑接力，避免双份维护。 | [AGENTS.md](../AGENTS.md)、本文件、[ARCHITECTURE.md](ARCHITECTURE.md)、[CURRENT_PLAN.md](CURRENT_PLAN.md)、[HANDOFF.md](HANDOFF.md)。 |
| D010 | Accepted | 对 memo 删除、附件重绑、批量标签重命名、关系重置与用户删除等多步写入路径使用 D1 `batch` 原子收敛，并在单测 mock 中验证回滚。 | 防止顺序写入中途失败留下部分完成状态；2026-11-28 经用户确认后实施。 | `worker/src/db/batch.ts`、`worker/src/routes/memos.ts`、`worker/src/routes/users.ts`、`worker/src/db/relation.ts`、`worker/tests/api-fixes.test.mjs`。 |
| D011 | Accepted | 本地验证以类型检查、单元测试与轻量静态检查为准，不要求在本地完成 Vite 生产构建；不为适配本地环境修改依赖、锁文件或构建配置。 | 项目采用 Cloudflare Workers 原生 Git 集成完成生产构建与部署（D006），真实 Workers AI 效果在实际运行环境中验证；2026-11-28 用户明确要求写入规则。 | [AGENTS.md](../AGENTS.md)、[package.json](../package.json)、[CURRENT_PLAN.md](CURRENT_PLAN.md)。 |

## D008 的待确认项（不改变决策）

仓库当前 `origin` URL 是 `https://github.com/miozen/memos-on-cloudflare.git`（`.git/config`），且未发现 `url.*.insteadOf` 重写规则；SSH 443 通道来自 WSL 用户级 `~/.ssh/config`。推送前必须在 WSL 中核实实际生效的 remote/认证方式，不自动改写 remote，也不把 HTTPS remote 当成 SSH 已配置完成的证明。
