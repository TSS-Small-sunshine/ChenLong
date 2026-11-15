# 12 仓库协作、分支保护与自动审查机器人

> 本章回答：**main 为什么改不动了？PR 必须过哪些检查？机器人审查了什么？别人（Fork/协作方）提 PR 时会发生什么？想换成/再加 AI 审查机器人怎么接？**
> 整理时间：2026-11-15（由维护者在本机通过 `gh api` 实际配置并验证）。

## 1. 当前仓库保护规则（main）

| 项目 | 配置 |
|---|---|
| 合并前置 | **必须 PR**；管理员（enforce_admins）同样不能直接 push |
| 必需检查 | `Test (Node 24)`、`Analyze JavaScript/TypeScript`、`Dependency review`、`PR guard` |
| 分支新鲜度 | strict：PR 分支必须与 main 同步（落后会要求先 update branch） |
| 审批 | 当前 0 个必需批准（单人维护，避免自己无法批准自己）；接入协作者后建议改为 1 + CODEOWNERS |
| 线性历史 | 要求线性历史；仓库只允许 **Squash merge**，合并后自动删分支 |
| 其他 | 禁止 force push / 删除 main；要求对话解决后才能合并；Allow auto-merge 已开启 |
| 安全兜底 | Secret Scanning + Push Protection 已开启；Dependabot security updates 已开启；Dependency graph 已开启（依赖审查依赖它） |

> 常见疑问：单人仓库为什么还要 0 审批？因为「PR + 必需检查」本身就能阻止直接改 main、并强制走 CI 与机器人；以后加协作者时再打开「1 个批准 + CODEOWNERS 强制审核」。

## 2. 自动审查机器人矩阵

| 机器人 | 触发 | 检查内容 | 结果在哪看 | 说明/边界 |
|---|---|---|---|---|
| **PR guard**（本仓库内置，`.github/workflows/pr-guard.yml`） | PR opened/synchronize/reopened/edited | ① 禁止 `data/**.db*`、`.env*`、`node_modules/`、私钥/证书、`.dev-secrets.json` 等路径；② 新增行疑似密钥（`gho_/ghp_/github_pat_/AKIA/sk-/PRIVATE KEY`）；③ PR 规模（S/M/L 标签）；④ 标题是否符合 Conventional Commits；⑤ 描述是否过短 | PR 评论 + Review + 标签（`security-ok`/`security-review`、`size/*`、`review-bot`） | 违规 → PR Guard 检查失败 + Review 请求修改；来自 Fork 的 PR 因 GITHUB_TOKEN 只读**无法评论**（检查仍会跑） |
| **CodeQL**（`.github/workflows/codeql.yml`） | push main / PR / 每周一 / 手动 | JS/TS 代码安全缺陷（注入、路径遍历、原型污染等） | Actions + Security → Code scanning（SARIF） | 公共仓库免费；PR 上会显示 `Analyze JavaScript/TypeScript` 检查 |
| **Dependency review**（`.github/workflows/dependency-review.yml`） | PR | 新增/升级依赖是否引入 **high 及以上**漏洞、许可证风险 | PR 检查 + 失败时评论摘要 | 只对 PR 生效；无依赖变更时也会跑并通过；**需要仓库 Dependency graph 已开启**（新建仓库若未就绪会报错，见 §6） |
| **Dependabot**（`.github/dependabot.yml`） | 每周一 03:00/03:30（Asia/Shanghai） | 自动提 npm 依赖与 GitHub Actions 升级 PR | PR 列表 | 同样走上面所有检查；minor+patch 已分组减少噪音 |
| **GitHub Secret Scanning** | push / PR | 常见密钥 + Push Protection | Security → Secret scanning | 已在仓库设置开启 |

### PR guard 的判定策略

- **阻塞（检查失败 + REQUEST_CHANGES）**：命中禁止路径、疑似密钥/私钥；
- **仅提示（不阻塞）**：标题不规范、描述过短、变更超过 1500 行（建议拆分）；
- 标签：`security-ok` / `security-review` / `size/S|M|L` / `review-bot`；
- 审查意见以「最新一条评论覆盖旧评论」的方式维护（带 `<!-- pr-guard -->` 标记，不刷屏）。

## 3. 别人提 PR 时完整路径

```text
Fork / 分支 → 开 PR
   ├─ CI: Test (Node 24)              （必须绿）
   ├─ CodeQL: Analyze JS/TS           （必须绿，安全告警在 Security 页）
   ├─ Dependency review               （必须绿，无高危依赖变更）
   ├─ PR guard                        （必须绿；Fork PR 只检查不评论）
   ├─ 维护者人工 Review（可对照 CODEOWNERS）
   └─ Squash merge → main（自动删分支、历史保持线性）
```

要点：

1. **main 直推一定失败**（即使管理员）；本地开发也必须建分支 → PR；
2. 分支落后会被 strict 规则拦住，点 **Update branch** 或本地 rebase 后重推；
3. Fork PR 的 `GITHUB_TOKEN` 是只读的，PR guard 无法留言/加标签，但必需检查照常判定；如需对 Fork 也自动评论，可改用 `pull_request_target`，但那会以写权限运行不可信代码，**不推荐**；
4. 涉及 `.github/`、`server/middleware/`、加密与 SSRF 相关文件的 PR 建议额外人工重点看（CODEOWNERS 已列出）。

## 4. 可选的 AI 代码审查机器人

按「接入成本 / 数据边界 / 可维护性」排序，建议按需选择，**不要一次全开**：

### 4.1 GitHub Copilot code review（原生，最省事）

- 适用于已开 Copilot 的维护者；GitHub 已提供**独立的自动审查仓库规则**：启用后新 PR 自动请求 Copilot 审查（可配置为对全部 PR 或仅草稿除外）。参见 GitHub Changelog「Copilot code review: Independent repository rule for automatic reviews」与文档「Configuring code review by GitHub Copilot」；[changelog](https://github.blog/changelog/2025-09-10-copilot-code-review-independent-repository-rule-for-automatic-reviews/)、[文档](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/configure-automatic-review)。
- 配置入口：仓库 **Settings → Rules / Rulesets → New ruleset → 添加 Copilot code review 规则**（需账户具备 Copilot 权限）；
- 优点：无需第三方 App、不接触仓库外数据；缺点：需要 Copilot 订阅，审查意见质量随模型/上下文波动。

### 4.2 CodeRabbit 等 SaaS 审查 App

- 在 GitHub Marketplace 安装 App → 授权本仓库 → 在 PR 中自动生成逐行建议与摘要；[文档](https://docs.coderabbit.ai/faq)；
- 优点：开箱即用、支持增量审查与配置项多；缺点：第三方可读取仓库内容（公共仓库问题不大，私有仓库需评估），免费额度/团队版收费。

### 4.3 CodiumAI PR-Agent（开源，自托管在 Actions）

- 用官方 Action + 大模型 API Key（OpenAI/Anthropic 等），在 PR 事件中调用并评论；项目：[pr-agent](https://github.com/Codium-ai/pr-agent)；
- 优点：开源、可自定义提示词与模型；缺点：需要自己管 `LLM_API_KEY`（放进 GitHub Secrets）、有 token 成本、质量取决于模型；
- 若接入，建议单独 workflow，并放在**可选变量开关**后面（如 `vars.AI_REVIEW_ENABLED == 'true'`），避免 key 未配置时 CI 变红。

### 4.4 GitHub Models（实验方向）

GitHub Actions 可以在具备 `models: read` 权限时调用 GitHub Models 推理接口做审查摘要；该能力仍在演进（模型名/权限可能变化），适合先做实验、不要作为合并阻塞项。

> 无论选哪种 AI 审查：**AI 只作为辅助意见，不替代人工 Review，也不要把它设为 required check**（模型输出不稳定，会把 PR 卡死）。

## 5. 维护者操作手册（调整规则）

```bash
# 查看 main 保护
gh api repos/TSS-Small-sunshine/ChenLong/branches/main/protection

# 改必需检查（job 显示名必须完全一致）
gh api -X PATCH repos/TSS-Small-sunshine/ChenLong/branches/main/protection/required_status_checks \
  -F strict=true \
  -f 'contexts[]=Test (Node 24)' \
  -f 'contexts[]=Analyze JavaScript/TypeScript' \
  -f 'contexts[]=Dependency review' \
  -f 'contexts[]=PR guard'

# 打开「1 个批准 + CODEOWNERS 强制」（有协作者之后）
gh api -X PATCH repos/TSS-Small-sunshine/ChenLong/branches/main/protection/required_pull_request_reviews \
  -F required_approving_review_count=1 -F require_code_owner_reviews=true

# 仓库合并设置（squash-only + 自动删分支 + 自动合并）
gh api -X PATCH repos/TSS-Small-sunshine/ChenLong \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false \
  -F delete_branch_on_merge=true -F allow_auto_merge=true
```

## 6. 排错

| 症状 | 原因 | 处理 |
|---|---|---|
| PR 某个必需检查一直 pending | 检查名与保护规则里的 contexts 不一致，或该 workflow 只在 push 触发 | 对比 PR 上显示名，改 protection contexts；补 `workflow_dispatch` 便于手动触发 |
| PR guard 评论/标签缺失 | Fork PR 的 token 只读 | 预期行为；K 检查仍有效，必要时人工留评 |
| CodeQL 没出现在 PR | 仓库 Actions 被限制、或 workflow 语法错误 | Actions 页看 run；`gh workflow list` 确认状态 |
| Dependabot 一直不提 PR | 仓库 Dependency Graph / Dependabot alerts 未开、或配置语法错误 | Settings → Code security 检查；`gh api repos/...` 查看 `security_and_analysis` |
| Dependency review 报 `Dependency graph is not enabled` | 新建仓库依赖图未就绪或被关闭 | 开启 Dependabot alerts：`gh api -X PUT repos/TSS-Small-sunshine/ChenLong/vulnerability-alerts`，等约 20–60 秒后 rerun 该检查（本仓库首次即踩此坑，已修复） |
| Actions 提示 Node 20 deprecated | `actions/checkout@v4`、`dependency-review-action@v4` 等仍以 Node 20 发布，被强制运行在 Node 24 | 属官方提示，不影响结果；后续跟随 Dependabot 升级到新版本即可 |
| 管理员也推不了 main | enforce_admins 生效（本意） | 走 PR；紧急情况先临时调整保护再改回（不推荐） |

## 7. 后续建议

1. 有第二位协作者后：审批数改 1 + CODEOWNERS 强制；启用 GitHub Teams；
2. Actions 供应链：逐步把 `uses:` 固定到 commit SHA（可让 Dependabot 自动升级 SHA）；
3. 补 lint（ESLint）并加入必需检查；Windows 矩阵在 Linux 稳定后再考虑（当前明确 Linux 优先）；
4. 若启用 AI 审查，先跑 2 周非阻塞模式，评估误报率再考虑是否设为要求；
5. 定期（每季度）复核保护规则、Dependabot 告警与 CodeQL 告警清零情况。
