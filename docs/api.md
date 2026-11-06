# HTTP 接口总览

本文按调用方整理接口入口。准确输入、返回值及状态取 `shared/domain/`、服务端路由与对应测试为准；前端调用见 `frontend/src/services/`。[认证](authentication.md)、[经营规则](commerce-v4.md)、[AI 接入](ai-support.md)和[供应商指南](integrations.md)包含专项说明。

## 通用约定

- 浏览器使用 Cookie 会话。除供应商专用回调外，写请求携带 `X-ShopMate-Request: 1` 并满足现有 Origin 校验；生产源为配置的 HTTPS `PUBLIC_URL`。
- 权限由服务端校验，包括本人数据归属和员工领域权限。前端隐藏入口不是权限控制。
- 可恢复业务写入使用 `requestId`。同一业务尝试重用标识和原参数，参数改变时不能复用；未知结果先查询原请求或交易，不通过换单号规避冲突。
- 常见错误为非 2xx JSON，包含 `message`，适用时包含 `code`；调用方同时使用 HTTP 状态和错误码，不匹配中文文案进行业务判断。401 表示未认证，403 表示不允许，409 表示冲突，429 表示额度或限流。
- 分页集合通常返回 `{items,total,page,pageSize,pages}`，特定读取有额外投影字段。分页参数与筛选按对应路由契约，不假设所有集合具有同一最大页大小。
- `X-Request-ID` 用于请求追踪，业务 `requestId` 用于写入幂等，两者职责不同。日志和错误报告不得附带凭据、验证码或完整个人资料。

## 公共与商城读取

| 接口组                                                                | 调用方与用途                                           | 源码入口                                          |
| --------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------- |
| `GET /api/live`、`/api/health`                                        | 进程存活及数据库就绪；排空时 health 返回 503           | `backend/src/app.ts`                              |
| `GET /api/production/config`、`/api/auth/production`、`/api/merchant` | 当前可用产品、验证方式、商家与已发布协议               | `backend/src/production/routes.ts`、`accounts.ts` |
| 分领域公共／本人／后台读取                                            | 商品分类、购物车、地址、订单、通知及管理集合的分页投影 | `backend/src/read-routes.ts`                      |
| `GET /api/products/:id/reviews`                                       | 可见评价分页及汇总                                     | `backend/src/app.ts`                              |
| `GET /api/order-requests/:requestId?quoteId=...`                      | 本人下单响应丢失后的归属安全查询                       | `backend/src/app.ts`                              |

`GET /api/state` 返回 410，不用于新接入。分领域路径、筛选及返回投影从 `read-routes.ts` 和 `frontend/src/services/repository.ts` 对照定位。

## 身份、安全与隐私

| 接口                                                                                               | 用途                                            |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `POST /api/auth/register`、`login`、`logout`                                                       | 注册、登录及退出；生产管理登录可能返回 MFA 挑战 |
| `POST /api/auth/verification/send`、`verify`                                                       | 发送并校验注册／绑定／找回挑战                  |
| `GET /api/auth/contacts`、`POST /api/auth/contacts`                                                | 本人联系方式及已验证绑定／更换                  |
| `POST /api/auth/recover`、`password`、`profile`                                                    | 找回密码、本人改密及昵称                        |
| `GET /api/auth/mfa/status`；`POST /api/auth/mfa/enroll`、`confirm`、`verify`、`recovery`、`cancel` | 管理员 TOTP 设置、确认、恢复码及取消未完成挑战  |
| `GET /api/auth/sessions`；`POST /api/auth/sessions/revoke`                                         | 本人会话列表与撤销                              |
| `POST /api/auth/consents`、`export`、`close`                                                       | 协议版本同意、本人数据导出与受约束注销          |

普通账号接口在 `backend/src/app.ts`，生产安全扩展在 `backend/src/production/accounts.ts`。验证码、MFA、恢复码和会话令牌只用于对应流程，不作为通用业务权限。

## 商城命令与管理操作

现有商城命令使用 `POST /api/actions/:method`，正文 `{args,requestId}`，允许的方法与输入校验在 `backend/src/validation.ts`、`app.ts`，共享方法签名在 `shared/domain/api.ts`。涵盖报价下单、购物车、地址、收货售后、商品、库存、营销、采购与员工等领域。生产禁用演示付款、演示退款和演示数据初始化；真实资金调用下表专用支付接口。

| 接口组                                                                                   | 用途与权限                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST /api/payments`；`GET /api/payments/:id`；`POST /api/payments/:id/refresh`、`close` | 本人创建、查询、刷新或关闭支付；金额及归属由服务端决定 |
| `GET /api/orders/:id/payments`                                                           | 按订单权限读取关联支付单                               |
| `/api/admin/payments`、`/api/admin/refunds`                                              | 财务支付／退款列表、申请退款及原单查询恢复             |
| `/api/admin/channel-reconciliation`                                                      | 渠道账单创建、差异明细、重跑及复核；财务权限           |
| `GET /api/admin/reconciliation`                                                          | 既有内部账务守恒检查，与渠道账单接口分开               |
| `/api/admin/webhooks`                                                                    | 回调收件异常及受限重试                                 |
| `/api/orders/:id/shipment`                                                               | 按订单权限读出库／退货轨迹及刷新                       |
| `/api/admin/notifications`、`/api/admin/shipments/:id/retry`                             | 通知、物流投递失败恢复；送达未知的通知需确认可能重发   |
| `POST /api/assets`；`GET /api/assets/:id`                                                | 服务端验证后的图片上传与读取                           |
| `POST /api/admin/merchant`                                                               | 经营主体、客服、退货地址、协议内容和版本；设置权限     |
| `GET /api/admin/production/status`、`/api/admin/integrations/external`                   | 已配置能力、运行计数和异常状态；实网结果另行验收       |

真实支付退款的字段、退款关闭后的新单规则、H5 链接有效期与查询恢复见[资金操作说明](integrations.md#支付退款与渠道对账怎么操作)。

## 回调、AI 与内部监控

`POST /api/webhooks/wechatpay`、`alipay`、`kuaidi100` 使用独立解析及供应商认证，不要求浏览器写入头。不能用浏览器会话代替签名，不能根据前端跳转或客户端金额自行入账。各平台控制台设置和回调地址见[接入指南](integrations.md)。

AI 会话、提案确认与知识文档接口见[AI 客服指南](ai-support.md)，实现位于 `backend/src/ai/`。模型只返回受约束的建议，最终操作仍走业务权限与状态校验。

`GET /api/internal/metrics`、`/api/internal/diagnostics` 使用独立 `Authorization: Bearer ...` 监控凭据，只读且不公开到生产入口。旧后台诊断仍按员工权限保护。监控配置、告警和排障见[生产监控](production.md#监控与告警)。
