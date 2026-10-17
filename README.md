# ShopMate-AI

一个包含用户商城和运营后台的中文单店电商项目，覆盖商品选购、订单履约、售后退款及人工客服，可用于学习、演示和后续 AI 客服集成。

前端采用 Vue 3、TypeScript、Vite 和 Element Plus；后端采用 Node.js、Express 和 SQLite，通过 Docker Compose 部署。

**账号认证和数据持久化已实现；支付、物流、退款均为模拟。当前客服使用 FAQ 规则和人工回复，尚未接入大模型或 Agent。**

![商城首页](docs/screenshots/storefront-desktop-fold.jpg)

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

管理端预览见 [后台截图](docs/screenshots/admin-desktop.png)。项目为单店业务演示，不包含真实支付物流或多商家功能。

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

首次启动自带演示商品，普通用户需自行注册。可以先完成一次购买，再到后台发货，回到用户端收货、评价或申请售后。

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
