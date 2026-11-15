# 安全政策（Security Policy）

## 支持的版本

当前仅维护 `main` 分支（最新提交）。历史提交不单独修复。

## 报告漏洞

- 首选：仓库 **Security → Report a vulnerability**（GitHub Private Vulnerability Reporting），仅维护者可见；
- 备用：邮件 `small_sunshine@tssplus.top`（请勿在公开 Issue 中披露可利用细节）；
- 请在报告中提供：影响版本、复现步骤、影响面（是否可未授权访问/越权/解密 Key 等），我们会尽快确认。

## 密钥与数据政策

- 真实密钥只存在于部署环境的 `.env` / `data/.dev-secrets.json`，**任何情况下不进入 Git**；
- 仓库已开启 **Secret Scanning + Push Protection**，GitHub 会在推送阶段拦截常见密钥；
- 若 `ENCRYPTION_KEY` 泄露或丢失：数据库里 `api_providers.api_key_encrypted` 将无法解密，需要轮换该密钥并在后台重新录入所有上游 API Key；
- 数据库备份（`data/backups/`）只保留在部署机，已加入 `.gitignore`。

## 自动化安全措施

| 措施 | 说明 |
|---|---|
| Branch protection | main 必须经 PR + 4 项检查，管理员同样受约束，禁止 force push |
| CodeQL | PR / push / 每周扫描 JS/TS 代码安全缺陷 |
| Dependency review | PR 中依赖变更引入 high 及以上漏洞直接阻断 |
| Dependabot | 依赖与 Actions 的每周升级 PR |
| Secret Scanning | 含 Push Protection，阻止密钥入库 |
| PR guard | 扫描 PR 中的敏感文件与疑似密钥，必要时请求修改 |

## 已知安全边界

详见 `docs/knowledge-base/07-security.md` 与 `09-status-and-gaps.md`：SSRF 的 DNS 重绑定窗口、限流为单进程内存态、无审计日志等。
