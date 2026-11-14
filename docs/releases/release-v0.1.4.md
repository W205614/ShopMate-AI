# v0.1.4 安全与工程质量维护

日期：2026-11-10，时区 Asia/Shanghai。保持单店、单 API、SQLite 架构和现有数据格式；没有数据库迁移或新的外部服务。

## 工程修正

- 将前端构建工具链的 minimatch 定向覆盖至 11.0.5，修复 GHSA-g3hv-75wg-m249；锁文件由 npm 重新生成。没有降低 ESLint 或更换业务依赖。
- 增加公开仓库免费的 CodeQL `security-and-quality` 分析，覆盖 JavaScript/TypeScript、Python 和 Actions。启用 Dependabot 告警，依赖审计涵盖开发依赖，API/Web 镜像漏洞门禁涵盖全部严重级别。未启用收费的 GitHub Code Quality。
- 更新并固定官方 Actions 提交，使用 Node.js 24 Action 运行时。
- 固定 Trivy 0.76.2，识别当前 Alpine 生命周期；逐版本审查 npm 安装脚本，仅允许 esbuild 的本机工具校验，禁用在 Node.js 24 无需执行的旧 Node.js 版本选择脚本。
- 支付宝 SDK 保留上游 4.14.0 的签名、HTTP 和证书实现，仅以 Node 内置 crypto 替换停止维护的 crypto-js AES 辅助函数。原 SDK 的互操作向量覆盖两种模块格式、三种密钥长度及空文本、中文和整块输入；许可、源补丁与确定的本地构建输入随源码提供。
- MFA 挑战 Cookie 固定使用 Secure；确认和验证入口共用按 IP 的 60 次/15 分钟限额，保留单挑战最多五次的约束。生产模式仍要求 HTTPS 和 `COOKIE_SECURE=true`。
- 客服草稿使用 Map 保存，商品筛选从查询条目构造结果；清理未使用导入和隐式字符串拼接，修正测试标识与签名头解析，格式工具通过同一文件句柄读写。
- 拆分 Element Plus 后台脚本，处理原先大于 500 kB 的构建警告，保留模块副作用的执行顺序、原有后台组件和中文语言配置。

## 检查口径

首轮 CodeQL 共报告 31 项。对实际问题修正源码并回归；对 CLI 报告内容、私有临时目录、隔离测试服务及请求身份数据流的误报，逐条保留证据并按明确授权处理。误报关闭与漏洞修补分别计数，不删除原始报告或分析历史。最终数量和对应提交以该版本的 CodeQL 分析、Dependabot 和 Release 交付记录为准；CI 执行中不代表验收通过。

本地定向检查覆盖账号 MFA、支付供应商签名、备份快照、维护与读取路由，以及前端请求恢复和密码不落盘约束。最终成功 CI 已完成干净构建、核心交易与权限浏览器流程、API/Web 全级别扫描。2026-11-10 已从公开 GHCR 匿名拉取同一制品，在无 node_modules 的新克隆目录中通过 `pull`、`up --no-build --wait` 启动；健康、首页、后台和两个许可入口 HTTP 200，只读目录浏览器 1/1 通过。

生产 HTTPS 模板仅引用上游固定 Caddy 镜像，本次不构建或重新分发 Caddy。2026-11-10 对该上游摘要的原始扫描仍有 2 HIGH、4 MEDIUM、1 UNKNOWN；现有配置约束和 OpenVEX 评估不等于依赖修补，不计作零漏洞。详见[入口安全评估](../security/production-edge-vex.md)。API/Web 自身的扫描与该上游结果分别报告；本次不承诺生产入口安全验收或生产部署。

AI 控制器、工具协议和调用预算沿用 v0.1.3，复用 2026-11-09 隔离合成数据下商品搜索、详情、最终回答的单场景真实证据。本次不新增付费模型请求，不将该证据扩大为所有模型和问题类型的质量保证。真实商户支付、通知和公网部署沿用[外部接入验收边界](../integrations.md#本地验证与实网验收)。

## 分发与本机升级

已发布一个正式 [v0.1.4 Release](https://github.com/W205614/ShopMate-AI/releases/tag/v0.1.4) 和既有公开 Linux/amd64 [API](https://github.com/users/W205614/packages/container/package/shopmate-ai-api)、[Web](https://github.com/users/W205614/packages/container/package/shopmate-ai-web) Packages。发布流程推广最终成功 CI 的同一镜像，不重新构建，不覆盖旧标签或更新 latest。Release 随附对应源码材料和 SHA-256 摘要，获取与许可说明见[容器分发](../container-distribution.md)。

已有日常环境升级前保留一致快照、配置和恢复资料，使用同一已验收镜像核对健康、页面及数据库，再恢复原来的停止状态。自动备份和副本策略维持原状。本机日常环境已升级到同一 v0.1.4 镜像，两个服务 healthy，五个 HTTP 入口及只读目录浏览器 1/1 通过。停止后数据库完整性 `ok`、外键错误 0，78 表中 77 表摘要一致，仅后台调度表 `job_queue` 变化；原配置、挂载、禁用自动备份策略不变，验收后恢复停止。升级前后完整数据副本、手动备份与配置恢复材料保留在本机。

## 版本与最终验证对照

| 对象                   | 身份与结果                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| 源码与 Tag             | `v0.1.4` → `355ba72d8dbe1ad1e7a6e3210114663e602eb7a0`                                                      |
| Application validation | [42784300849](https://github.com/W205614/ShopMate-AI/actions/runs/42784300849)，第 1 次运行成功            |
| CodeQL                 | [42784300806](https://github.com/W205614/ShopMate-AI/actions/runs/42784300806)，三个语言分析成功，未解决 0 |
| 发布                   | [42787912640](https://github.com/W205614/ShopMate-AI/actions/runs/42787912640)，推广同一 CI 镜像，成功     |
| API Registry digest    | `sha256:7860e2603da9b4d457e14fa3c88d099528babeb3fe2a1819ebe90c6834e9d872`                                  |
| Web Registry digest    | `sha256:32156053b0a5bda9cbade13f9f7938e1b290b7147e4df7251de705dcf4ac973d`                                  |

API/Web 均为公开 Linux/amd64 镜像，config digest 与有序解压层 diff IDs 和最终 CI 归档一致。对应源码归档的 519 个 Git blob 均匹配该 Tag，未包含本机配置、凭据和业务数据库。后续 README 或 CI 报告留存修正提交可领先这个 Tag，不重建或覆盖已发布镜像。

最终 CI：后端 419、前端 57，主浏览器 134 通过、1 个条件夹具测试跳过（该任务另在 AI 隔离部署中通过）；HTTPS 7、容器交易 7、运营 8、恢复与角色 4、合成 AI 40 + 12、AI 任务浏览器 1、Python 脚本 6 项通过。CodeQL 20 项经源码修正、13 项按明确授权逐条确认为误报后关闭，原始结果仍为 13，不能称作 13 项漏洞修补。完整 npm 审计、Dependabot、Secret scanning 未解决均为 0，API/Web 原始漏洞扫描所有严重级别均为 0。检查中保留的 Ubuntu runner 迁移通知属于信息提示。

本次文档在隔离合成实例中实际执行镜像内的 Node/tsx 管理员改密、备份、检查与恢复到单独测试文件；镜像不包含 npm，运维命令已据此修正。文档用新截图没有真实业务数据。另修复 CI 对 `.delivery` 中两个明确报告路径的上传遗漏，仅允许这些指定 JSON/摘要文件；原发布的业务验收日志与镜像身份不变，不以新分支 CI 替换该版本证据。
