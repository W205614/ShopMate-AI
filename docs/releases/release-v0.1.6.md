# v0.1.6 商城、售后与运营体验更新

日期为 2026-11-22，时区为 Asia/Shanghai。此版本沿用单店、单 API 和 SQLite，复用现有业务卷。没有新增数据库表、迁移、运行服务或应用依赖。

## 主要变化

- 商品列表按同一个规格组合筛选库存和价格，并显示匹配的规格。商品和结算页可按省份查看配送范围、运费与包邮条件，结算以实际地址和优惠后的金额为准。
- 支付页说明结果核对与继续付款的条件。售后和人工客服把需要顾客处理的消息排到前面，并提供直达对应申请或会话的入口。会员页展示当前权益与可用优惠。
- 运营后台可配置发货、售后审核和人工接待的等待时限。首页显示临近超时、已超时和最早等待时间，支持进入相应队列继续处理。
- AI 客服可追问预算和使用场景，按查询得到的库存与预算展示具体规格。预算内无匹配时，可让顾客选择调整条件。加购及其他业务操作继续要求顾客确认。
- Web 镜像使用 Nginx 1.30.7。生产 HTTPS 入口的源码构建升级 Alpine `libcrypto3` 和 `libssl3` 至 3.5.9-r1 或更新的兼容版本，并包含 OpenTelemetry `sdk/log` v1.47.0 和 `klauspost/compress` v1.20.4 的安全修复。

## 镜像与验证范围

公开 Linux/amd64 镜像为 `ghcr.io/w205614/shopmate-ai-api:v0.1.6` 和 `ghcr.io/w205614/shopmate-ai-web:v0.1.6`。发布流程使用应用 CI 已验收的两个镜像及对应源码材料。摘要和附件以 [GitHub Release](https://github.com/W205614/ShopMate-AI/releases/tag/v0.1.6) 为准。部署和许可说明见[容器分发](https://github.com/W205614/ShopMate-AI/blob/v0.1.6/docs/container-distribution.md)。升级前按[生产指南](https://github.com/W205614/ShopMate-AI/blob/v0.1.6/docs/production.md)准备一致的恢复资料，保留现有配置和业务卷。

交易和 AI 验证使用隔离数据、模拟支付和合成模型响应。真实商户、通知物流、模型质量及公网部署需要各自的运行环境和验收。生产 Caddy 入口可按[入口安全说明](https://github.com/W205614/ShopMate-AI/blob/v0.1.6/docs/security/production-edge-security.md)从本版本源码构建；本次分发的两个应用镜像用于现有 API/Web 编排。
