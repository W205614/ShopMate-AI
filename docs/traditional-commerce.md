# 传统电商功能、接口与验收

实施日期：2026-10-17。支付、退款、物流均为业务模拟，不产生真实交易；账号、会话和业务数据由服务端 SQLite 持久化。本期未接入模型或 Agent，原客服规则继续保留。

## 功能与限制

- 账号：昵称维护、校验原密码后改密；撤销该用户所有会话，管理员会话不受影响。无短信、邮件、找回密码、头像上传或多因素认证。
- 选购：立即购买独立结算，下架收藏可移除；购物车批量勾选/删除和清理失效条目。清理保留单纯缺货商品，再次购买按当前价格和库存处理。
- 结算：结算内新增/编辑地址，地址非空时保持唯一默认地址；报价含商品、地址和优惠，5 分钟有效；相关数据变化后重新确认。
- 订单：报价标识和用户请求标识防重复下单，幂等记录 24 小时，同一报价只能创建一笔订单。待付款期限 30 分钟，启动和每分钟处理超时，付款入口再次校验。无库存预占，不承诺待付款期间持续有货。
- 优惠券：全店固定满减，按领取时间、有效期、发行量和每人限领校验；每单一张，不叠加。下单占用、付款核销、取消/超时释放；退款不退券，已领取后只允许启停配置。
- 评价：已收货、有未退款数量、无进行中售后的购买条目可评一次；1–5 星、5–1000 字纯文本。公开昵称脱敏，无用户/订单 ID。用户删除及管理员隐藏影响展示和评分，退款完该行后仅保留历史。
- 售后：按订单行/数量，多次分批申请，但同单同时仅一笔进行中。未寄回前可撤销；退货退款必须提交模拟承运商和单号，再由管理员确认收货后退款。不支持换货、部分发货或真实退货寄件。

## 金额与状态不变量

商品金额以整数分计算。优惠按各行原金额比例使用最大余数法分配，行净额之和等于订单实付。每行的累计可退金额为 `floor(行实付 × 累计退货数量 / 购买数量)`，本次金额取新旧累计值之差，最后一笔补齐尾差。使用 BigInt 中间计算避免分配乘法丢失精度。

付款、退款、库存变动、优惠券状态和流水在 SQLite `BEGIN IMMEDIATE` 内原子提交。重复付款或退款不会重复记账、扣库、回补；退款数量和金额不超过原购买数量及实付。部分退款保留订单履约状态，全量退款才标记已退款。有进行中售后时禁止发货和确认收货。

所有归属取服务端 Cookie 身份，不信任客户端用户 ID、金额、角色或退款金额。公开评价独立投影字段，`/api/state` 中的领取记录、评价、报价只返回当前用户自己的数据，管理操作要求管理员角色。

## 接口

保留固定角色的 `/api/actions/:method` 分发方式，Zod 严格校验参数：

| 接口 | 作用 |
| --- | --- |
| `POST /api/auth/profile` | 修改本人昵称 |
| `POST /api/auth/password` | 原密码验证、更新哈希并撤销所有用户会话 |
| `batchCart`、`clearInvalidCart` | 原子批量操作与失效条目清理 |
| `quoteCheckout({ source, addressId, couponClaimId? })` | `source.type` 为 `cart` 或 `buyNow`，返回服务端报价 |
| `createOrder({ quoteId, requestId })` | 校验报价一致性并幂等创建订单 |
| `reorder(orderId)` | 按现状加购，返回已加入条目数和跳过原因 |
| `saveCoupon`、`toggleCoupon`、`claimCoupon` | 管理员配置与用户领取 |
| `requestAfterSale(orderId, reason, description, lines)` | 行 ID 和数量输入，退款金额由服务端计算 |
| `cancelAfterSale`、`submitReturn`、`processAfterSale` | 撤销、退货信息与审核/收货/退款 |
| `submitReview`、`deleteReview`、`moderateReview` | 验证购买资格、删除与管理员隐藏 |
| `GET /api/products/:id/reviews?page=1` | 每页10条公开评价、可见总数及平均分 |

## v1 → v2 迁移与备份

首次打开旧数据库时事务化升级，新增优惠券、领取、评价、报价和幂等集合，为旧订单增加稳定行 ID、实付/退款数量和已知时间事件。旧待付款订单仅在首次升级时获得 30 分钟窗口；重复启动不延长。历史退款转换为原全部行数量，不重放扣库、回补或流水。不虚构未知的完成/取消时间，不注入示例券或评价。高于当前支持版本的数据库拒绝打开，避免旧代码覆盖新结构。

部署前使用 SQLite 在线备份 API，保留旧镜像及独立备份文件，不能复制运行中的主文件代替完整备份。对数据库副本验证迁移和重复启动，并比对账号、会话、商品、订单金额、库存和流水。日常卷继续是 `shopmate-ai_api_data`，不删除数据卷、不恢复演示数据。

发生发布失败且尚无新业务写入时，可恢复旧镜像与对应数据库备份；已发生新业务写入时以前向修复为先，禁止自动用旧备份覆盖新订单。

## 验证命令与部署边界

```powershell
npm --prefix backend run typecheck
npm --prefix backend test
npm --prefix backend audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm --prefix frontend run typecheck
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org
npm --prefix frontend run build
npm --prefix frontend run test:e2e
```

本地浏览器回归自动启动隔离后端，业务种子只写入 `backend/.e2e/`。新增覆盖账号改密、下架收藏、优惠券、立即购买、批量购物车、订单搜索分页、评价审核与分批退款。既有认证、分类搜索、交易及客服回归继续执行。后端覆盖幂等、跨用户隔离、超时竞争、券时区边界、分币分摊、库存流水守恒、迁移/重复打开与未来版本拒绝。

写入式容器验收只在独立部署运行（示例端口 18087，必须先确认该地址为隔离服务）：

```powershell
$env:PLAYWRIGHT_BASE_URL = 'http://127.0.0.1:18087'
$env:E2E_ADMIN_PASSWORD = '隔离验收管理员密码'
$env:E2E_MUTATIONS_ALLOWED = '1'
npm --prefix frontend run test:e2e -- e2e/auth.spec.ts e2e/traditional-container.spec.ts e2e/catalogue-smoke.spec.ts --output=test-results-container
Remove-Item Env:PLAYWRIGHT_BASE_URL
Remove-Item Env:E2E_ADMIN_PASSWORD
Remove-Item Env:E2E_MUTATIONS_ALLOWED
```

传统交易验收会注册临时用户、创建优惠券、下单、模拟支付、发货、评价和分批退货退款，不能指向日常部署。新增写入式测试对外部地址默认跳过，只有显式设置 `E2E_MUTATIONS_ALLOWED=1` 才运行。日常 18086 部署只执行 `catalogue-smoke.spec.ts` 等只读检查。

GitHub Actions 在最终提交上执行类型、单元/HTTP、审计、构建、完整浏览器回归，并对独立 API/Nginx 容器执行认证、目录和传统电商闭环验收。最终结果以交付消息中的确切提交 SHA 和 CI 链接为准。

## 本次验收记录

2026-10-17 本地验证：前后端类型检查、ESLint、构建通过；后端 45 项单元/HTTP 测试、前端 8 项单元测试及完整 31 项浏览器回归通过，生产依赖审计均为 0 个漏洞。保留原认证、分类搜索、交易和客服断言，新增用券后的非空结算页在 390/768/1440px 下的边界检查。

独立 Compose 项目 `shopmate-traditional-final` 使用 18088 端口和 `shopmate-traditional-final_api_data` 卷，6 项容器验收通过。覆盖真实注册、地址、领取与使用满减券、重复下单/支付、发货收货、评价公开脱敏、填写退货信息、两次部分退款和重复退款，核对实付/退款、库存回补与流水。另对新增页面执行手机、平板、桌面截图复查。

已用日常数据库的在线备份副本验证 v1→v2 迁移、重复打开和备份恢复；账号、会话、商品、库存与流水摘要一致。本次日常数据库原先没有用户订单，历史订单金额、旧售后与旧待付款窗口的兼容性由包含这些数据的迁移测试验证，不以空数据库断言替代。隔离环境重复验收曾触发注册限流，换用新隔离卷后通过，未放宽服务端限流规则。

发布时保留日常卷 `shopmate-ai_api_data`、升级前 SQLite 在线备份和 `before-traditional-20261017` 旧镜像标签。日常部署仅做健康、镜像提交标签、迁移数据守恒和公开目录只读检查，不向日常库写入验收用户、优惠券或订单。
