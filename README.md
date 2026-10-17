# ShopMate-AI

一个包含用户商城和运营后台的中文单店电商项目，覆盖商品选购、订单履约、售后退款及人工客服，可用于学习、演示和后续 AI 客服集成。

**账号认证和数据持久化已实现；支付、物流、退款均为模拟。当前客服使用 FAQ 规则和人工回复，尚未接入大模型或 Agent。**

## 解决什么问题

- 将用户购买与后台发货、售后、库存、财务串成完整业务闭环，双端共享服务端数据。
- 由服务端统一校验身份、价格、优惠、库存和退款，处理重复提交与异常恢复。
- 提供可运行的传统电商基础，便于后续通过现有业务接口接入 AI 客服。

## 主要功能

| 模块 | 功能 |
| --- | --- |
| 用户商城 | 注册登录、分类搜索、商品规格、收藏、购物车、地址、优惠券、下单与模拟支付 |
| 订单与售后 | 订单查询、再次购买、收货评价、按商品数量分批退款、模拟退货与进度查询 |
| 运营后台 | 商品分类、上下架、补货盘点、订单发货、售后处理、优惠券与评价管理、经营概览、财务查询与 CSV 导出 |
| 客服与设置 | FAQ 规则问答、转人工、会话回复与关闭、商城名称和公告设置 |

项目为单店业务演示，不包含真实支付物流或多商家功能。

## 技术栈

| 层次 | 技术与用途 |
| --- | --- |
| 前端 | Vue 3 + TypeScript + Vite；Vue Router 管理路由，Pinia 管理状态，Element Plus 构建后台界面 |
| 后端 | Node.js 24 + Express，Zod 校验接口参数；Cookie 会话认证与服务端权限校验 |
| 数据 | SQLite 持久化账号和业务数据，事务处理订单、库存与流水 |
| 部署 | Docker Compose 编排 API/Web，Nginx 托管前端并代理 API |
| 验证 | Vitest 单元／HTTP 测试、Playwright 浏览器测试、GitHub Actions 自动验证 |

## 运行效果

可体验“领券购买 → 模拟支付 → 后台发货 → 收货评价 → 售后退款”的完整流程，订单、库存和流水随业务操作同步。商城适配桌面和窄屏；后台桌面优先，小屏宽表支持横向滚动。

**商城首页：** 分类切换、商品浏览和搜索入口。截图展示界面布局，实际商品和数据以运行环境为准。

![商城首页运行效果](docs/screenshots/storefront-desktop-fold.jpg)

<details>
<summary>运营后台：经营概览、订单待办与低库存提醒</summary>

![运营后台运行效果](docs/qa/images/dashboard-1440.png)

</details>

<details>
<summary>手机端：用券结算、分批退款及订单进度</summary>

<img src="docs/qa/images/checkout-coupon-phone.png" width="280" alt="手机端用券结算" /> <img src="docs/qa/images/refunded-order-390.png" width="280" alt="手机端退款订单与进度" />

</details>

后台与手机截图来自隔离验收环境，金额、订单及收货资料均为测试数据，新部署不会自动生成这些交易。详细验证结果见 [联合验收报告](docs/joint-acceptance.md)。

## 快速部署

安装 Git 和 Docker（包含 Compose），并启动 Docker。以下命令以 PowerShell 为例。

### 1. 获取项目

```powershell
git clone https://github.com/W205614/ShopMate-AI.git
cd ShopMate-AI
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

### 2. 配置管理员

用编辑器打开 `.env`，填写 `ADMIN_PASSWORD`：10–128 位，至少包含字母和数字。管理员账号默认为 `admin`，可通过 `ADMIN_USERNAME` 修改。

管理员仅在首次启动时创建；已有部署请保留原 `.env`，修改环境变量不会覆盖已有管理员密码。不要提交包含凭据的 `.env`。

### 3. 启动服务

```powershell
docker compose up -d --build --wait
```

启动后访问：

- 商城：<http://localhost:18086/>
- 用户注册：<http://localhost:18086/register>
- 管理端：<http://localhost:18086/admin/login>，使用上面配置的管理员账号登录。

首次启动自带演示商品，普通用户需自行注册，再按上方流程体验购买、履约和售后。本地源码运行方式见 [开发与运维](docs/development.md)。

检查运行状态和启动日志：

```powershell
docker compose ps
docker compose logs --tail 100 api web
```

账号和业务数据保存在 `shopmate-ai_api_data` 数据卷中，重启或重建容器会保留数据。**不要执行 `docker compose down -v`，该命令会删除数据卷。** 默认仅供本机访问；修改端口、配置访问源或维护管理员密码，见开发与运维指南。

## 更多文档

- [开发与运维](docs/development.md)：本地运行、配置、测试、密码维护和数据保存。
- [业务规则与接口](docs/traditional-commerce.md)：报价、优惠券、退款与数据迁移。
- [联合验收与体验报告](docs/joint-acceptance.md)：测试证据、已知限制和后续建议。
- [素材来源与许可](docs/assets.md)：图片署名及使用要求；原创业务代码尚未指定开源许可证。
