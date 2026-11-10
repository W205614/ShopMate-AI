# v0.1.4 安全与工程质量维护

日期：2026-11-10，时区 Asia/Shanghai。保持单店、单 API、SQLite 架构和现有数据格式；没有数据库迁移或新的外部服务。

## 工程修正

- 将前端构建工具链的 minimatch 定向覆盖至 11.0.5，修复 GHSA-g3hv-75wg-m249；锁文件由 npm 重新生成。没有降低 ESLint 或更换业务依赖。
- 增加公开仓库免费的 CodeQL `security-and-quality` 分析，覆盖 JavaScript/TypeScript、Python 和 Actions。启用 Dependabot 告警，依赖审计涵盖开发依赖，API/Web 镜像漏洞门禁涵盖全部严重级别。未启用收费的 GitHub Code Quality。
- 更新并固定官方 Actions 提交，使用 Node.js 24 Action 运行时。
- MFA 挑战 Cookie 固定使用 Secure；确认和验证入口共用按 IP 的 60 次/15 分钟限额，保留单挑战最多五次的约束。生产模式仍要求 HTTPS 和 `COOKIE_SECURE=true`。
- 客服草稿使用 Map 保存，商品筛选从查询条目构造结果；清理未使用导入和隐式字符串拼接，修正测试标识与签名头解析，格式工具通过同一文件句柄读写。
- 拆分 Element Plus 后台脚本，处理原先大于 500 kB 的构建警告，保留原有后台组件和中文语言配置。

## 检查口径

首轮 CodeQL 共报告 31 项。对实际问题修正源码并回归；对 CLI 报告内容、私有临时目录、隔离测试服务及请求身份数据流的误报，逐条保留证据并按明确授权处理。误报关闭与漏洞修补分别计数，不删除原始报告或分析历史。最终数量和对应提交以该版本的 CodeQL 分析、Dependabot 和 Release 交付记录为准；CI 执行中不代表验收通过。

本地定向检查覆盖账号 MFA、支付供应商签名、备份快照、维护与读取路由，以及前端请求恢复和密码不落盘约束。发布候选仍需完成干净 CI、浏览器核心交易与权限流程、实际镜像全级别复扫及匿名拉取运行。

生产 HTTPS 模板仅引用上游固定 Caddy 镜像，本次不构建或重新分发 Caddy。2026-11-10 对该上游摘要的原始扫描仍有 2 HIGH、4 MEDIUM、1 UNKNOWN；现有配置约束和 OpenVEX 评估不等于依赖修补，不计作零漏洞。详见[入口安全评估](security/production-edge-vex.md)。API/Web 自身的扫描与该上游结果分别报告；本次不承诺生产入口安全验收或生产部署。

AI 控制器、工具协议和调用预算沿用 v0.1.3，复用 2026-11-09 隔离合成数据下商品搜索、详情、最终回答的单场景真实证据。本次不新增付费模型请求，不将该证据扩大为所有模型和问题类型的质量保证。真实商户支付、通知和公网部署沿用[外部接入验收边界](integrations.md#本地验证与实网验收)。

## 分发与本机升级

目标为一个正式 [v0.1.4 Release](https://github.com/W205614/ShopMate-AI/releases/tag/v0.1.4) 和既有公开 Linux/amd64 [API](https://github.com/users/W205614/packages/container/package/shopmate-ai-api)、[Web](https://github.com/users/W205614/packages/container/package/shopmate-ai-web) Packages。发布流程推广最终成功 CI 的同一镜像，不重新构建，不覆盖旧标签或更新 latest。Release 随附对应源码材料和 SHA-256 摘要，获取与许可说明见[容器分发](container-distribution.md)。

已有日常环境升级前保留一致快照、配置和恢复资料，使用同一已验收镜像核对健康、页面及数据库，再恢复原来的停止状态。自动备份和副本策略维持原状。实际发布摘要、CI 和升级结果以 Release 及本机交付记录为准，本说明不提前代表发布成功。
