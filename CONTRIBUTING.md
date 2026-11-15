# 贡献指南（Contributing）

> 本项目采用**受保护的 main 分支 + PR 合并**流程：所有改动（包括维护者自己的）都必须通过 Pull Request，CI 全绿后才能合并。
> 运行环境以 **Linux + Node 24 + PostgreSQL 17** 为 CI 基准（本地 Windows 开发同样支持，但以 CI 结果为准）。
> 第三批起数据库为 PostgreSQL：本地开发/测试需要可达的 PG（推荐 `docker compose up -d db`），不再是 SQLite 文件。

## 1. 分支与提交

- 从 `main` 拉分支，命名如 `feat/xxx`、`fix/xxx`、`ci/xxx`、`docs/xxx`、`chore/xxx`；
- 提交信息使用 Conventional Commits：`type(scope): subject`，type 取 `feat|fix|docs|ci|chore|refactor|test|perf|build|revert`；
- 合并方式为 **Squash merge**（保持 main 线性历史），合并后自动删除分支。

## 2. 本地验证（提交 PR 前）

```bash
cp .env.example .env      # 至少配置 DATABASE_URL；本地可先 docker compose up -d db
npm ci
npm test                  # 83 个用例；需要可达的 PostgreSQL（CI 用 service 容器）
```

- 测试必须使用**独立测试库/schema**，禁止连接生产库；本机没有 PostgreSQL 时 `npm test` 不可用（由 CI 的 `Test (Node 24)` job 用 `postgres:17` service 验证）。
- 只跑单元测试：`npm run test:core`（仍会连接 PG 的用例需数据库就绪）。

## 3. PR 流程

1. 推送分支 → 在 GitHub 打开 PR（模板会自动带上 Summary / Changes / Test plan / Security checklist）；
2. 等待 4 个必需检查全部通过：
   - `Test (Node 24)` — 单元 + 特性/集成测试
   - `Analyze JavaScript/TypeScript` — CodeQL 代码安全扫描
   - `Dependency review` — 依赖变更漏洞审查（high 级别及以上直接阻断）
   - `PR guard` — 仓库审查机器人（敏感文件/密钥扫描、规模与标题检查、自动评论与标签）
3. 维护者审查通过后 Squash merge。分支落后于 main 时 PR 会被要求先更新（strict 模式）。

## 4. 机器人/自动审查

- **PR guard**：每次 PR 打开或更新都会运行，发布一条带 `<!-- pr-guard -->` 标记的评论和 Review，并添加 `security-ok/security-review`、`size/*` 标签；Fork PR 因 GITHUB_TOKEN 只读可能无法评论（检查仍会运行）。
- **CodeQL**：push main、PR、每周一凌晨自动扫描 JS/TS，结果在仓库 Security → Code scanning 查看。
- **Docker image**（非必需检查）：在 Linux runner 构建镜像，用 `docker compose` 起 `db + app` 两个服务做健康检查与首页冒烟；见 [docs/DEPLOY-DOCKER.md](docs/DEPLOY-DOCKER.md)。
- **Dependency review**：PR 中新增/升级依赖引入 high 及以上漏洞时直接失败。
- **Dependabot**：每周一自动提依赖与 GitHub Actions 升级 PR，同样走检查流程。
- 可选 AI 审查：见 `docs/knowledge-base/12-pr-workflow-and-bots.md`（Copilot 自动审查 / CodeRabbit / PR-Agent 的接入方式与取舍）。

## 5. 数据与密钥红线

- **禁止提交**：`.env`、`data/.dev-secrets.json`、`data/backups/`（含 pg_dump 的 `.sql` 备份）、`pgdata/`、`data/*.db*`（历史 SQLite）、私钥、真实 API Key、含密码的 `DATABASE_URL`；
- 仓库已开启 Secret Scanning + Push Protection，命中会被 GitHub 直接拒绝推送；
- 泄露处理：立即轮换对应密钥（`ENCRYPTION_KEY` 一旦更换，旧库中已加密的 API Key 将无法解密），并按 `SECURITY.md` 流程报告。

## 6. 修改保护规则/新增检查（维护者）

```bash
# 查看当前保护
gh api repos/TSS-Small-sunshine/ChenLong/branches/main/protection

# 新增必需检查（把新 job 的显示名加进 contexts）
gh api -X PATCH repos/TSS-Small-sunshine/ChenLong/branches/main/protection/required_status_checks \
  -F strict=true -f 'contexts[]=Test (Node 24)' -f 'contexts[]=Analyze JavaScript/TypeScript' \
  -f 'contexts[]=Dependency review' -f 'contexts[]=PR guard'
```

> 注意：新增的 job 名称必须与 PR 上显示的检查名完全一致，否则会永远 pending。