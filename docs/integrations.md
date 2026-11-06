# 生产外部服务接入

本项目实现明确的供应商适配器；支持范围内通过配置、密钥、域名及平台开通完成接入。商户签约和产品审核、短信签名模板、真实物流订阅、云存储权限均需自己的有效账号。协议或产品发生不兼容变化时仍可能需要更新适配代码。

默认运行 `SHOP_MODE=demo`。生产切换使用[独立生产指南](production.md)，不要直接覆盖本机 `.env`。接口正确、合成协议通过和真实服务验收是不同状态；最终验证报告逐项记录实网未验收内容。

## 微信支付

支持直连商户 Native 扫码和 H5 支付；不包括小程序、公众号 JSAPI、原生 App、服务商模式和分账。手机 H5 适用于微信外的浏览器，微信内置浏览器提示在外部打开，依据[官方产品介绍](https://pay.wechatpay.cn/doc/v3/merchant/4012791832)。

在商户平台开通对应产品，将应用与商户号关联，设置商户私钥、商户证书序列号、APIv3 密钥和微信支付公钥。H5 还需配置平台要求的支付域名及应用资料。`PAYMENT_CHANNELS` 中加入已开通的 `wechat_native`、`wechat_h5`，填写：

| 配置                                             | 值                         |
| ------------------------------------------------ | -------------------------- |
| `WECHAT_APP_ID`、`WECHAT_MCH_ID`                 | 当前应用 ID 和直连商户号   |
| `WECHAT_MERCHANT_SERIAL`                         | 商户签名证书序列号         |
| `WECHAT_PRIVATE_KEY_FILE`                        | 容器内商户私钥路径         |
| `WECHAT_PUBLIC_KEY_ID`、`WECHAT_PUBLIC_KEY_FILE` | 微信支付验签公钥 ID 与文件 |
| `WECHAT_API_V3_KEY_FILE`                         | APIv3 密钥文件             |

模板文件路径均位于 `/run/secrets/`，宿主机放入 `SECRETS_PATH`。通知地址由 `PUBLIC_URL` 生成：`https://你的域名/api/webhooks/wechatpay`。该入口无需浏览器 Cookie，按签名、商户、金额和订单关联校验，并持久化通知后应答。重复通知与主动查单共同收敛，见[官方回调说明](https://pay.wechatpay.cn/doc/v3/merchant/4012791882)。本适配采用微信支付公钥模式；更换公钥应配置匹配 ID 和文件，不通过忽略验签进行过渡。

### H5 支付链接刷新

微信返回的 `h5_url` 有效期为五分钟，超时需要重新请求下单接口，见[官方 H5 下单协议](https://pay.wechatpay.cn/doc/v3/merchant/4012791834)。项目将链接到期时间与订单到期时间中的较早值保存为 `Payment.checkout.expiresAt`；付款页在跳转前调用 `POST /api/payments/:id/refresh` 查单。

仍待支付且链接过期或缺少时效记录时，服务端使用原支付单 ID、原商户单号及原下单参数重新获取链接；正常轮询不会反复重建链接。刷新网络结果不确定时保留待核对状态并清除旧链接，重启后继续查询原单。顾客在订单页查询或重试刷新即可，不需要新建订单、更换支付单或手动关单。已付款、正在关单、订单到期或结果未知时不跳转旧链接。

## 支付宝

开通电脑网站支付及手机网站支付，创建应用、配置加签方式并取得应用私钥、支付宝公钥、应用 ID 和收款商家 ID。`PAYMENT_CHANNELS` 中加入 `alipay_page`、`alipay_wap`，填写 `ALIPAY_APP_ID`、`ALIPAY_SELLER_ID`、`ALIPAY_PRIVATE_KEY_FILE`、`ALIPAY_PUBLIC_KEY_FILE`。默认网关为 `https://openapi.alipay.com/gateway.do`；沙箱配置必须使用沙箱应用、密钥及网关，不能混用。

回调为 `https://你的域名/api/webhooks/alipay`，支付返回页面只用于继续查看订单，不能证明收款成功。实现采用[支付宝官方 Node.js SDK](https://github.com/alipay/alipay-sdk-nodejs-all)，保留签名验证和业务身份核对，不接收客户端自行声明的支付结果。

## 支付、退款与渠道对账怎么操作

顾客从订单支付页创建支付单，手机／电脑展示可用入口。支付单固化原渠道和商户；存在有效支付单时切换渠道前先关闭旧单。订单到期但渠道结果未知时保留待核对状态和资源占用，确认关单才释放；不得通过手工改订单状态解决渠道不确定性。

后台售后审核、必要退货收货完成后提交退款。受理成功只表示处理中，最终渠道结果确认后才累计退款和变更积分、库存。结果未知或处理中先按原退款单查询；渠道已确认关闭时，返回原售后重新发起新退款单，不能用旧退款单重试。异常退款先在渠道平台处理，再查询同步，避免两处重复退款。微信退款语义见[官方开发指引](https://pay.wechatpay.cn/doc/v3/merchant/4013071031)。

历史缺失 `transactionMode` 的流水视为演示流水。生产财务页面默认只汇总 production 流水，可切换查看历史演示记录；生产经营概览不混算旧模拟收退款。采购支出是业务登记，不代表调用了银行转账接口。满减分摊后实付为零的售后明细，仍须完成原审核和必要质检，按零金额本地结案，无资金流转且不计入渠道对账。

“生产接入”可查询支付、退款及渠道账单。账单日期使用北京时间，记录渠道金额、退款和手续费差异；人工复核需写明依据，复核不会伪造资金成功。更换商户号前处理原商户在途支付和退款，不能仅修改商户号让历史交易改走新商户。

| API                                                 | 调用方式                                                       |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `POST /api/payments`                                | 顾客会话，`{orderId,channel,requestId}`                        |
| `GET /api/payments/:id`                             | 本人支付单                                                     |
| `POST /api/payments/:id/refresh`、`close`           | `{requestId}`，查询／申请关闭                                  |
| `POST /api/admin/refunds`                           | 财务会话，`{afterSaleId,requestId}`                            |
| `POST /api/admin/refunds/:id/refresh`、`retry`      | 查询／按原单恢复                                               |
| `POST /api/admin/channel-reconciliation`            | `{provider:"wechatpay"或"alipay",date:"YYYY-MM-DD",requestId}` |
| `GET /api/admin/channel-reconciliation/:id`         | 分页核对具体差异                                               |
| `POST /api/admin/channel-reconciliation/:id/retry`  | `{requestId}`，失败重试或重新下载账单核对；成功前保留原差异    |
| `POST /api/admin/channel-reconciliation/:id/review` | `{note,requestId}`，记录人工复核                               |

浏览器写入继续携带 `X-ShopMate-Request: 1` 和现有 Origin 校验。请求结果未知时用原请求标识重试，不更换参数或商户单号。

## 配置检查与故障定位命令

以下命令从仓库根目录执行，均显式使用独立生产配置。预检检查已启用渠道、密钥文件、目录权限和镜像版本，不会创建交易或发送短信。启动时还会校验密钥格式及具体适配器配置；本地预检通过不能替代平台权限和实网联调。

```sh
node scripts/production-preflight.mjs .env.production
PRODUCTION_ENV_FILE="$PWD/.env.production" docker compose --env-file .env.production -f deploy/compose.production.yaml config --quiet
bash scripts/production-release.sh .env.production
PRODUCTION_ENV_FILE="$PWD/.env.production" docker compose --env-file .env.production -f deploy/compose.production.yaml logs --since 30m --tail 200 api edge
curl --fail --show-error --max-time 15 https://你的域名/api/health
```

先将最后一条命令的域名改为 `PUBLIC_URL`。日志应只包含请求标识和脱敏故障码，排查时不要输出密钥文件或完整环境变量。

| 服务              | 需要在自己的账号上检查                                                                          | 恢复入口                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 微信／支付宝      | 商户与应用归属、已开通产品、签名公钥及 ID、公网 HTTPS 回调；H5 支付域名；原订单在渠道的实际结果 | 后台“生产接入”按原支付／退款单查询；失败回调恢复；账单重新核对。未知结果期间保留原单号，禁止手工改成成功         |
| SMTP／阿里云短信  | SMTP TLS 与认证、发件域名授权；RAM 短信权限、审核通过的签名／模板和变量映射、额度               | 先修正配置再通过发布脚本应用；后台通知列表按原投递任务恢复，未知结果重发需确认可能重复。验证渠道未配置时不会展示 |
| 快递100           | 查询／订阅产品权限、真实承运商编码和单号、回调地址可达及签名盐                                  | 后台运单列表查询最新轨迹、恢复订阅；保持人工收货和质检流程                                                       |
| S3 图片／远端备份 | endpoint、region、桶与前缀读写权限、签名时钟、私有桶；启用远端备份时对应凭据必须完整            | 使用本文 `assets-copy`、`upload`、`download`、`restore-local`／`restore` 命令逐项校验，保留旧对象和原加密密钥    |

平台重发仍失败时保留交易号、请求标识及脱敏故障码，按对应平台控制台诊断；不要跳过验签。恢复配置后若仍有在途交易，先查单核对再恢复业务，数据库恢复不能撤销渠道已经发生的收退款。

## 邮件、短信与账号验证

SMTP 使用 `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_FROM`，需要认证时同时设置 `SMTP_USERNAME`、`SMTP_PASSWORD`。常见 465 端口使用 `SMTP_SECURE=true`；587 使用 `false` 并通过 STARTTLS。生产非隐式 TLS 连接强制 STARTTLS，不关闭证书验证。发件域名的 DNS 授权和实际收件结果需在自己的邮件平台验收。

短信设置 `SMS_ENABLED=true`，填写 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME`，并同时配置验证模板 `ALIYUN_SMS_TEMPLATE_VERIFICATION` 与交易通知模板 `ALIYUN_SMS_TEMPLATE_TRANSACTION`。启用短信覆盖验证与订单通知，两模板缺任一项均预检和启动失败，不静默省略订单通知。使用具有相应短信权限的 RAM 凭据，签名与模板需要平台审核，详见[阿里云官方 SDK 示例](https://help.aliyun.com/zh/sms/developer-reference/using-typescript-openapi-example)。

模板变量配置为“供应商模板变量名 → 项目字段名”。验证码默认 `SMS_TEMPLATE_VARIABLES_VERIFICATION={"code":"code"}`；订单通知默认 `SMS_TEMPLATE_VARIABLES_TRANSACTION={"orderId":"orderId"}`。模板参数更名时调整 JSON 映射，缺失字段会明确失败。不要填写营销短信模板作为验证码模板。

验证码五分钟有效、六十秒发送间隔、最多五次校验；另有 IP、联系方式和全局额度。`EMAIL_DAILY_LIMIT` 默认 500，`SMS_DAILY_LIMIT` 默认 100，是本地发送尝试上限，失败也计数，不代表供应商余额或送达保证。后台通知区分等待、发送中、已提交、送达未知及失败；重试未知结果时需要确认可能重复送达。

生产用户验证邮箱或手机之一后注册，已有账号下单前补绑定；找回密码仅使用已经验证的联系方式。联系方式更换需要当前密码及新联系方式验证。管理登录密码通过后还需 TOTP，首次设置时保存恢复码。遗失全部验证方式时由有部署访问权的维护者停机运行：

```sh
node --import tsx scripts/reset-mfa.ts 管理员账号 --offline
```

命令在 `backend/` 执行，`DATABASE_PATH` 指向已经停止的现有库；`.running` 标记阻止对运行中的库操作。该命令撤销旧管理会话，下一次密码登录重新设置 MFA，不恢复或重置业务数据。

本人可在账号安全页验证密码后导出资料或注销。未完成订单、售后及待核对资金会阻止注销；完成注销会撤销会话、删除联系方式和个人资料，并脱敏订单、物流、支付 IP、客服及旧版迁移原文中的本人信息，保留必要交易金额与匿名关联。旧备份、已导出文件和第三方持有的通知／运单不会随在线账号注销自动改写；维护者须按实际留存政策管理，并在恢复旧备份后重新核对注销记录及渠道在途资金。

## 快递100

开通企业实时查询与订阅推送服务，设置 `KUAIDI100_ENABLED=true`，填写 `KUAIDI100_KEY`、`KUAIDI100_CUSTOMER`、不少于 32 字符的 `KUAIDI100_CALLBACK_SECRET`。`PUBLIC_URL` 必须能被供应商 HTTPS 访问；每张运单由代码生成 `/api/webhooks/kuaidi100/:id` 回调地址及签名盐，按[官方订阅协议](https://api.kuaidi100.com/document/5f0ffa8f2977d50a94e1023c.html)接收轨迹。

仓库自行寄件后录入真实承运商与单号。订单页和“生产接入 → 运单跟踪”读取出库及退货轨迹，失败订阅可恢复。物流签收不自动确认订单收货、完成质检或批准退款。查询可能向供应商发送运单关联的必要联系方式；顾客只能访问本人订单，员工遵循订单权限。电子面单、快递网点账号和打印不在本次范围。

## 图片存储与远端备份

默认 `ASSET_STORAGE=local`、`ASSET_DIR=/app/assets`，对应生产宿主机 `ASSET_PATH`。新上传由后端解码校验、转码并保存元数据，引用使用稳定的 `/api/assets/:id` 路径。历史内置图片和合法数据图片继续可读。

S3 兼容存储设置 `ASSET_STORAGE=s3`，填写 `S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`；AWS S3 可省略 `S3_ENDPOINT`，其他兼容平台使用其 HTTPS endpoint，按平台要求选择 `S3_FORCE_PATH_STYLE`，对象前缀为 `S3_PREFIX`。代码使用 [AWS SDK v3](https://github.com/aws/aws-sdk-js-v3)，所需权限限于业务前缀下的对象读写；桶应私有，按平台要求启用存储加密和访问审计。本项目通过应用读取图片，不需要公开整个桶。

新配置不改写历史对象位置。迁移命令会复制、逐项校验摘要，只有加 `--switch` 才切换元数据；原对象和文件保留，不自动清理：

```sh
# backend/，停机维护窗口或按命令要求操作独立副本
node --import tsx src/production/remote-backup.ts assets-copy /app/data/shopmate.sqlite s3
node --import tsx src/production/remote-backup.ts assets-copy /app/data/shopmate.sqlite s3 --switch
```

跨 S3 endpoint／账号迁移时，通过 `S3_SOURCE_ENDPOINT`、`S3_SOURCE_ACCESS_KEY_ID`、`S3_SOURCE_SECRET_ACCESS_KEY` 保留原端凭据，以当前 `S3_*` 作为目标端。迁移前备份，切换后确认老订单和商品图仍能读取；完成核对后再停用原凭据。

需要将历史内置／data 图片迁入独立文件存储时，停机后显式运行 `assets-import-legacy <离线数据库> <原frontend/public/images目录>`；不要将内置图片目录当成新资产目录。知识文档继续保存在 SQLite，原文件访问仍按客服管理权限控制。

远端备份使用 `BACKUP_S3_BUCKET`（省略时使用 `S3_BUCKET`）、`BACKUP_S3_PREFIX` 和同组 S3 连接配置。`BACKUP_S3_ENABLED=false` 是默认值，设为 `true` 后自动备份在本地验证成功后额外上传；上传失败会保留本地恢复点并报告失败，不伪装成远端成功。手动上传只接受通过原维护校验的快照，包含对应图片和摘要，返回 `bundleKey`；下载必须使用新目录：

```sh
node --import tsx src/production/remote-backup.ts backup-local /app/data/shopmate.sqlite /app/backups/新的快照.sqlite manual
node --import tsx src/production/remote-backup.ts upload /app/backups/已验证快照.sqlite
node --import tsx src/production/remote-backup.ts download backups/返回的目录/bundle.json /app/backups/新的恢复目录
CONFIRM_RESTORE=STOPPED_AND_BACKED_UP node --import tsx src/production/remote-backup.ts restore /app/backups/新的恢复目录 /app/data/新的离线数据库.sqlite /app/新的资产目录
CONFIRM_RESTORE=STOPPED_AND_BACKED_UP node --import tsx src/production/remote-backup.ts restore-local /app/backups/已验证快照.sqlite /app/data/新的离线数据库.sqlite /app/新的资产目录
```

这些是容器内路径示例。确认目标数据库已停机并保留原恢复资产后，显式设置 `CONFIRM_RESTORE=STOPPED_AND_BACKED_UP` 才能执行 restore／restore-local；不能对运行库使用 restore。恢复后先校验数据、图片、支付与退款在途状态、MFA 和幂等结果，再挂载到服务；云端“上传成功”不能替代一次实际恢复。原加密密钥及商户配置也需要保留。

## 本地验证与实网验收

常规测试不会读取实际 `.env` 发起付费服务。确定性协议服务验证 SDK 请求、签名通知、重试和故障状态；Mailpit 接收真实 SMTP，Adobe S3Mock 验证对象与备份恢复。它们不能证明真实商户产品已开通或第三方账号可用。

接入自己的账号后，至少逐项保存以下证据：

1. 电脑和手机各入口下单、真实扣款、异步通知或查单入账、原路退款、渠道账单核对。
2. 验证码和订单通知实际到达测试邮箱／手机，失败投递在后台可见，未泄露验证码和凭据。
3. 真实运单订阅、签名回调、主动查询、归属权限及退货轨迹。
4. 图片上传读取、历史对象迁移、远端快照下载与新路径恢复。
5. HTTPS、真实客户端 IP、监控故障与恢复消息送达，内部路径不能从公网访问。

未完成项应继续标记“实网未验收”，不能通过修改能力状态文案认定已上线。
