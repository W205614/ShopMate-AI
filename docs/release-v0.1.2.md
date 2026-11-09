# v0.1.2 容器分发维护

日期：2026-11-09，时区 Asia/Shanghai。维持单店、单 API、SQLite 架构；没有新增业务功能、依赖或数据库迁移。

本轮补齐 API/Web 的容器分发入口：日常 Compose 可以通过 `API_IMAGE`、`WEB_IMAGE` 使用已验证镜像，默认源码构建方式继续可用。新增手动发布工作流，要求目标 Tag 与成功验证 CI 的提交一致，推广同一验收镜像，拒绝主动覆盖已有版本。

镜像分发材料包括实际 Alpine 包及构建配方/源文件、Node.js 与 Nginx 源码、sharp-libvips 组件源码和构建脚本、依赖许可与摘要。准备失败会中止发布，不把根项目 MIT 或漏洞扫描结果当成第三方分发许可。获取方式及发布步骤见[容器分发](container-distribution.md)。

目标为公开 [v0.1.2 Release](https://github.com/W205614/ShopMate-AI/releases/tag/v0.1.2) 和 [API](https://github.com/users/W205614/packages/container/package/shopmate-ai-api)、[Web](https://github.com/users/W205614/packages/container/package/shopmate-ai-web) 两个 GHCR Packages，平台为 Linux/amd64。最终发布摘要、CI、本机升级结果在 Release 和本机交付记录中核实；本说明不提前代表发布或验收成功。

本机升级保留原业务数据、配置和账号，自动备份及副本仍关闭，原来停止的容器验收后恢复停止。代表性交易流程使用隔离数据验证；日常实例只读核对。真实模型、支付、通知、物流、云存储和生产部署仍按既有边界另行验收，本轮不声称它们已通过。

本轮另在内存隔离库、合成账号及持久化预算代理中做了一次真实模型验收：现有 `gpt-6-luna` 配置的 3 次请求均返回 HTTP 200 并执行商品查询，但在授权的 3 次上限内未收敛为最终回答，随后被代理阻止继续调用。实际用量合计 5,253 tokens，无待确认业务提案；这项验收未通过，没有据此推断全部模型或正常四次调用预算下的表现。记录保留在本机，不把合成 AI 契约通过写成真实模型质量通过。
