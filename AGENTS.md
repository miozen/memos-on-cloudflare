# AGENTS.md — Codex 工作规范与执行协议

本文件是 AI 参与本项目的稳定入口，只定义协作协议，不承载业务细节。

事实优先级：可验证的仓库事实（源码 / 配置 / 测试 / Git） > 本文件与 `docs/` 中的已确认决策 > 历史对话与记忆。

核心文档入口：

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：当前有效架构与约束。
- [docs/DECISIONS.md](docs/DECISIONS.md)：已确认业务与架构决策；Accepted 决策不得擅自推翻。
- [docs/CURRENT_PLAN.md](docs/CURRENT_PLAN.md)：当前阶段、目标与验收口径。
- [docs/HANDOFF.md](docs/HANDOFF.md)：恢复开发所需的最小接力状态。

已有文档继续有效，不因文件名不同而废弃：[README.md](README.md)、[web/docs/auth-architecture.md](web/docs/auth-architecture.md) 及 `web/src/components/**/README.md`。详细事实优先引用，不在多处复制。

## Session Start Protocol

每次新对话、新电脑或上下文恢复时：

1. 读取本文件。
2. 读取 `docs/ARCHITECTURE.md`。
3. 读取 `docs/DECISIONS.md` 中与当前任务相关的决策。
4. 读取 `docs/CURRENT_PLAN.md`。
5. 读取 `docs/HANDOFF.md`。
6. 检查 Git 分支、HEAD、`status`、diff 与最近提交。
7. 对照源码、测试与文档验证当前状态；不依赖聊天记录恢复项目事实。
8. 文档与仓库事实冲突时先查明原因，不盲目覆盖文档或代码。
9. 状态一致且任务已确认时，从 `docs/HANDOFF.md` 的 Exact Next Action 继续。

## Session Handoff Protocol

完成实质性开发、阶段检查点，或准备切换电脑/会话时：

1. 检查代码修改与 Git diff。
2. 执行相关测试、构建与静态检查；未运行的验证不得标记为通过。
3. 按真实进度更新 `docs/CURRENT_PLAN.md`（阶段级视角）。
4. 更新 `docs/HANDOFF.md`（最小状态）。
5. 准确记录完成项、未完成项、验证结果和下一动作；未提交、未验证或未同步的工作不得标记为完成。
6. 明确是否存在未提交修改和未同步提交。
7. 普通讨论或无实质进度变化时，无需反复更新文档。

## 默认执行模式

已确认的开发任务默认进入执行模式：

**恢复状态 → 检查现状 → 实施修改 → 补充测试 → 执行验证 → 检查 Diff → 更新文档 → 汇报结果。**

普通实现细节自主处理；不重复询问已冻结的业务或架构决策；不因切换会话而重新设计已完成的工作。

仅在以下情况暂停并请求确认：

- 业务规则存在真实歧义；
- 需要改变已确认的架构决策；
- 存在重大实现方案分歧；
- 涉及破坏性或不可逆操作；
- 关键环境或依赖缺失，无法安全继续。

未确认的新需求先做设计讨论，确认后再实施。

## 代码修改、测试与验收

- 修改范围以当前任务与 `docs/CURRENT_PLAN.md` 为界；不因发现技术债顺手启动重构。
- 本地轻量验证入口（依据 [docs/DECISIONS.md](docs/DECISIONS.md) D006 / D011）：后端 `npm test`、`npx tsc --noEmit`；前端 `npm --prefix web test`、`npm --prefix web exec tsc -- --noEmit --skipLibCheck`（及按需 Biome 静态检查）。不要求在本地完成 Vite 生产构建（`npm run build:web` / `npm run ci:build`），生产构建交由 Cloudflare Workers Builds 完成，真实 Workers AI 效果在实际运行环境中验证。
- 不为适配本地环境（依赖安装、UNC 路径、WSL 环境或本地构建问题）修改项目依赖、锁文件或构建配置。
- 验收以实际运行结果、diff 与仓库内测试为准；不得把"应该能通过"写成"已通过"。
- 新增或修改功能时同步补充/调整测试；仅文档变更时至少执行 `git diff --check`。

## Git 与多电脑接力

标准流程：电脑 A 开发 → 验证 → 更新 `docs/CURRENT_PLAN.md` / `docs/HANDOFF.md` → Commit → Push；电脑 B Fetch/Pull → 检查 Git 状态 → 执行 Session Start → 恢复 Next Action。

- Git 是代码同步的可靠依据；Handoff 不能替代 Git。
- DIRTY 工作区不能作为已同步的跨电脑接力点；不丢弃、覆盖或清理未提交修改；不自动执行危险 Git 操作。
- 跨电脑接力优先使用已提交、已推送、已验证的检查点；必须核对本地 HEAD 与远端同步状态。
- 提交与推送只在用户明确要求或已确认的接力检查点执行，默认不自动提交、不自动推送，不随意切换分支。

本机环境约定（依据 [docs/DECISIONS.md](docs/DECISIONS.md) D007 / D008）：

- 开发命令在 WSL 中执行；Node 通过 WSL 的 nvm 安装，版本以 [.node-version](.node-version)（22）为准。使用 `npm` / `npx` / `wrangler` 前先确认 nvm 环境已加载。
- 远端推送通过 WSL 的 SSH 443 通道：WSL `~/.ssh/config` 将 `github.com` 映射到 `ssh.github.com:443`。仓库当前 `origin` URL 仍为 HTTPS，推送前必须核实实际通道；不擅自改写 remote 配置。

## 文档维护

- 五个核心文件是统一入口；其他已有文档保留并作为详细依据引用。
- 同一事实只在一处维护；发现重复时明确权威来源并改为引用。
- `docs/DECISIONS.md` 状态使用 Proposed / Accepted / Superseded；Accepted 决策的变更必须先获得用户确认。
- `docs/HANDOFF.md` 只保留恢复开发所需的最小状态，不复制架构、决策或完整实施计划。
