# 当前开发计划

本文只保留阶段级视角。详细功能清单与验收用例以仓库源码、测试和 CI 为准（[README.md](../README.md)、[worker/tests](../worker/tests)、[web/tests](../web/tests)、[.github/workflows/deploy.yml](../.github/workflows/deploy.yml)），避免形成第二套冲突计划。

## Current Phase

AI 二级标签建议与 PKM 标签预设、D1 `batch` 原子化（D010）、SSRF 校验复用、401 刷新重试豁免及核心协作文档均已完成本地验证并准备提交推送，进入“推送至 GitHub、交由 Cloudflare Workers Builds 完成生产构建与实际环境验证”阶段。

## Goal

保持现有架构与依赖配置稳定，完成本轮修复与文档的提交推送，形成可跨电脑恢复的远端检查点；生产构建交由 Cloudflare Workers Builds，真实 Workers AI 效果在实际运行环境中验证。

## Completed

- 已推送基线：`origin/main` = `c4d3542`（PKM 增强、稳定性修复与严格标签边界解析）。
- 本地待推送内容：
  - AI 二级标签建议与 PKM 预设提交：`abee0a5`、`d2be2b7`、`cf9c27a`、`153507e`。
  - 稳定性与一致性修复：D1 `batch` 原子收敛与回滚测试（`worker/src/db/batch.ts`、`worker/src/routes/memos.ts`、`worker/src/routes/users.ts`、`worker/src/db/relation.ts`、`worker/tests/api-fixes.test.mjs`、`worker/tests/pkm-enhancements.test.mjs`）；SSRF URL 校验复用（`worker/src/validation.ts`、`worker/src/webhook.ts`、`worker/src/routes/memos.ts`）；AI 模型白名单一致性测试（`worker/tests/secondary-tags-ai.test.mjs`）；Auth 端点 401 刷新重试豁免与单测（`web/src/api/client.ts`、`web/tests/api-client.test.ts`）。
  - 核心规范文档与验证策略更新（`AGENTS.md`、`docs/ARCHITECTURE.md`、`docs/DECISIONS.md` D001–D011、`docs/CURRENT_PLAN.md`、`docs/HANDOFF.md`）。

## In Progress

- 提交上述文档与修复并推送至 `origin/main`。

## Remaining

1. 推送后由 Cloudflare Workers Git 集成执行生产构建与部署（D006 / D011），并在实际运行环境中验证真实 Workers AI 效果。
2. 后续可选改进（如 `personal_access_tokens` / `shortcuts` 并发保护、SSE 事件广播评估等）按需再议。

## Acceptance Criteria

- 五类核心文件存在，职责清晰，引用路径有效，无同一事实双份维护。
- `git diff --check` 无错误；不修改项目依赖、锁文件或构建配置以适配本地环境。
- 本地轻量验证通过：`npx tsc --noEmit`、`npm test`（51/51）、`npm --prefix web exec tsc -- --noEmit --skipLibCheck`、`npm --prefix web test`（30 文件 172/172）、改动文件 Biome 检查（不要求本地运行 `npm run build:web` / `npm run ci:build`）。
- 提交并推送至 `origin/main` 后，HANDOFF 的 Cross-machine Ready 才允许改为 YES。

## Validation

- Performed：在 WSL Node v22.23.4 下完成 `npx tsc --noEmit`、`npm test`（51/51）、`npm --prefix web exec tsc -- --noEmit --skipLibCheck`、`npm --prefix web test`（30 文件 / 172 用例）、改动文件 `biome check` 与 `git diff --check`；此前一并运行过的 `npm run build:web` 亦已通过（后续遵循 D011 不再要求本地构建）。
- Pending：推送至 `origin/main` 后核对本地 HEAD 与远端同步状态；Cloudflare Workers Builds 生产构建与线上 Workers AI 实测。

## Blockers

- 无环境阻塞；仅待完成本轮 Commit 与 Push 同步。

## Next Action

完成提交并推送 `main` 至 `origin/main` → 核对工作区 CLEAN 且与远端同步 → 在 Cloudflare Workers 运行环境中验证线上构建与 Workers AI 效果。
