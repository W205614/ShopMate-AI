# 项目结构与阅读顺序

项目由 Vue 前端、Express 后端和共享 TypeScript 契约组成，前后端分别管理依赖，没有根目录 npm 工作区。业务数据和权限由后端负责；前端缓存用于页面展示与请求恢复。AI 客服通过后端业务方法执行已确认的操作。

## 目录职责

```text
ShopMate-AI/
├── README.md                 首次部署、能力边界和主要入口
├── .env.example              配置模板；实际凭据放在被忽略的 .env
├── compose.yaml              日常 API/Web 编排
├── Dockerfile                前端构建及 Nginx 镜像
├── backend/
│   ├── Dockerfile            API 镜像及 PDF 工具
│   ├── src/                  HTTP、业务事务、SQLite、AI 与维护逻辑
│   ├── scripts/              监控、隔离验收、造数和数据核验工具
│   ├── test/                 单元/HTTP 测试及合成 AI 文档样例
│   └── package*.json         后端依赖、锁文件与 npm 命令
├── frontend/
│   ├── src/                  页面、组件、状态、请求恢复和样式
│   ├── public/               商品图片、来源元数据和字体许可
│   ├── e2e/                  Playwright 浏览器测试与辅助代码
│   ├── scripts/              截图及页面测量工具
│   └── package*.json         前端依赖、锁文件与 npm 命令
├── shared/
│   ├── domain/               两端共享类型、API 契约、规则辅助和演示种子
│   └── testing/              通过受限公开 API 组装验收快照的辅助代码
├── deploy/                   Nginx 配置与独立验收 Compose 覆盖文件
├── scripts/                  仓库维护检查（当前为文档链接校验）
├── docs/
│   ├── README.md             当前文档、验收报告与历史记录导航
│   ├── archive/              已完成阶段的交付和设计记录
│   ├── qa/                   报告引用的原始证据与代表截图
│   └── screenshots/          README/报告引用的界面图片
└── .github/workflows/        GitHub Actions 验证
```

前端与后端的 `package-lock.json` 都应保留并随依赖改动提交。`frontend/src/domain/api.ts`、`types.ts` 是共享契约的转出入口，不是多余副本。`shared/testing/` 被后端测试和浏览器验收共同使用。

## 前端源码阅读顺序

1. 从 `frontend/src/main.ts` 和 `App.vue` 看应用初始化，再读 `router.ts`，了解商城、后台、登录与路由权限入口。
2. 读 `shared/domain/types.ts`、`api.ts`，掌握两端约定；`shared/domain/seed.ts` 是演示商品和业务初始数据。
3. 读 `frontend/src/services/repository.ts`、`api.ts`，理解分领域数据获取、身份与路由范围、缓存同步、请求标识及未知结果恢复。`checkoutRecovery.ts`、`stockRecovery.ts` 处理具体流程恢复，`support.ts` 和 `supportDocuments.ts` 对接客服与知识文档。
4. 读 `frontend/src/stores/shop.ts`，看页面如何订阅数据与会话。业务页面分别在 `views/shop/` 和 `views/admin/`，通用商城组件在 `components/shop/`，后台图片编辑在 `components/admin/`。经营工作台的员工与采购表格分别由 `StaffManagementPanel.vue` 和 `PurchaseOrdersPanel.vue` 展示，表单、权限及请求恢复仍由父页面管理。
5. `frontend/src/domain/` 除契约入口外还包含金额、优惠券、财务、售后和评价等界面计算。公共样式从 `style.css` 进入，商城、后台及业务流程样式在 `styles/`。

追一个购买流程可从 `CheckoutView.vue` 跟到前端 `services/api.ts`，再到后端 `app.ts` 与 `commerce.ts`；服务端校验和事务结果决定最终状态。

## 后端源码阅读顺序

1. `backend/src/index.ts`：打开数据库、初始化管理员、启动 HTTP 服务、定时任务、AI 工作器和自动备份，并处理退出。
2. `app.ts`、`read-routes.ts`：请求来源、认证、权限、参数校验、分领域读取及业务操作入口。相关规则在 `auth.ts`、`permissions.ts`、`validation.ts`。
3. `repository.ts`、`database.ts`、`storage.ts`、`migration.ts`：请求上下文、事务、数据读写、关系存储与迁移；版本常量在 `versions.ts`。
4. `commerce.ts`、`commerce-rules.ts`、`stock-availability.ts`：订单、库存及售后；`catalog.ts` 管商品分类，`marketing.ts` 管营销与会员，`operations.ts` 管采购、仓储及经营管理，`dashboard.ts` 汇总经营概览，`support.ts` 管规则与人工客服。
5. `ai-support.ts`、`ai-knowledge.ts`、`ai-provider.ts`、`ai-schema.ts`：AI 会话、提案与确认、文档检索、供应商调用和结构校验；文档工作进程入口为 `ai-document-worker.ts`。`ai-answer.ts` 从服务端证据生成事实文案，`ai-budget.ts` 管理北京时间每日配额及工作进程额度协议。
6. `runtime.ts`、`jobs.ts` 管审计、命令结果和持久化任务；`diagnostics.ts` 管受限诊断；`maintenance.ts`、`automatic-backup.ts`、`backup-worker.ts`、`backup-state.ts` 管备份、恢复、子进程和备份状态。`admin.ts` 是管理员密码维护入口。

沿一个功能定位相关测试即可：后端在 `backend/test/`，前端逻辑测试与源码同目录，页面流程在 `frontend/e2e/`。日常验证命令见[开发与运维](development.md#验证命令)。

## 后端脚本索引

下表列出 `backend/scripts/` 的全部脚本。带造数、业务写入或故障注入的工具只用于其文档要求的独立验收环境；不因脚本存在就默认执行。

| 脚本 | 用途与前提 |
| --- | --- |
| `monitor.ts` | 宿主机健康、容器、磁盘、任务和备份观测，可单次或持续运行；配置告警与维护静默见[运行观测](monitoring.md) |
| `verify-security-headers.mjs` | 用 `SECURITY_BASE_URL` 指定独立本机验收入口，检查页面／资源／API／404安全头、压缩请求拒绝与后续健康；不使用账号凭据或写入业务数据 |
| `ai-acceptance.mjs` | 真实供应商 AI 验收，上传合成文档并创建账号/交易，产生模型费用；要求显式开启及独立本机端口，见[AI 验收](ai-acceptance.md) |
| `generate-ai-fixtures.py` | 重新生成 `backend/test/fixtures/ai/` 合成样例；依赖 Pillow、python-docx、ReportLab 和脚本指定的中文字体 |
| `fault-acceptance.ts` | 独立容器的破坏性故障验收；校验端口、容器标签及写入开关，见[v4 验收](reliability-acceptance.md) |
| `load.ts` | 固定并发的读取/购物车混合负载，可结合独立容器记录资源与备份窗口；见[默认配置验收](default-config-acceptance.md) |
| `load-observation.ts` | 负载驱动共用的有界采样、延迟和备份窗口计算模块，无独立 I/O 或定时器 |
| `production-load-observer.ts` | 负载驱动共用的 Docker 资源、日志和备份观测模块，用于核对探测请求标识与备份窗口 |
| `seed-load.ts` | 在新隔离数据库生成负载账号及 0/10000 笔历史订单数据；拒绝复用已有负载账号 |
| `prepare-load-backups.ts` | 在隔离服务停机、新备份目录为空时预置 7 份备份，用于保留清理和负载验证 |
| `verify-load-invariants.mjs` | 对负载合成数据执行只读守恒核对；仅适用于规定的 0/10000 历史订单数据集 |
| `compare-database-snapshots.mjs` | 使用只读连接和快照事务比较数据库的账户、业务及关系数据，可用于备份/恢复或迁移对照 |
| `migration-rehearsal.ts` | 输入显式离线快照和新演练目录，只迁移新副本并验证备份、恢复及数据一致性 |
| `seed-stability.ts` | 复用历史负载种子，补充独立用户及工作集，供交易混合稳定性专项验收 |
| `stability-load.ts` | 有思考时间的多用户交易负载与耐久验收，校验独立 Compose 项目和端口，见[稳定性专项](stability-hardening.md) |
| `stability-provider.ts` | 隔离网络中的故障供应商，轮换返回 429、无效 JSON、超时和 503，用于故障隔离验证 |
| `ai-quality.mjs`、`ai-quality-cases.mjs` | 40条协议契约与12条真实模型合成场景，分类统计检索、事实、引用及降级，见[2026-10-21验收](final-acceptance-20261021.md) |
| `ai-quality-provider.mjs`、`ai-acceptance-provider.mjs` | 确定性假服务及认证预算代理；真实代理持久限制100次／20分钟，不用于日常客服服务 |
| `seed-role-maintenance.ts` | 只为显式允许且没有普通用户／订单的新隔离库生成25条失败通知夹具，不是修复工具 |
| `verify-stability.ts` | 对隔离验收数据库捕获基线和只读核验，不迁移、不关闭过期订单、不修复数据 |

`docs/qa/stability-20261020/force-backup-due.mjs` 是专项证据附带的备份到期模拟工具，保留在报告目录以便回溯；其修改行为和隔离限制见[专项复跑说明](stability-hardening.md#复跑)。常规密码与数据库维护使用 `backend/package.json` 的 `admin:password`、`maintenance` 命令，入口位于 `backend/src/`。

## 前端脚本索引

| 脚本 | 用途与输出 |
| --- | --- |
| `frontend/scripts/capture.mjs` | 拍摄商城、商品和已登录后台截图，要求管理员凭据；写入已跟踪的 `docs/screenshots/`，运行后需要检查图片差异 |
| `frontend/scripts/capture-auth.mjs` | 拍摄用户登录、后台登录和手机注册页面；写入 `docs/screenshots/` |
| `frontend/scripts/audit-pages.mjs` | `before`/`after` 页面截图与布局测量，输出到被忽略的 `.taste-skill/page-audit/`；会操作账号、订单、咨询等流程，应使用独立验收部署及测试账号 |

这些工具使用 Playwright，Windows 默认启动 Edge。目标地址可由 `PLAYWRIGHT_BASE_URL` 指定，参数与凭据要求以脚本为准；界面复审的历史操作入口见[归档报告](archive/ui-review.md)。

根目录的 `scripts/check-docs.mjs` 是文档维护脚本：执行 `node scripts/check-docs.mjs`，检查 Git 跟踪和未忽略 Markdown 中本地 Markdown 链接及 HTML 图片/链接的目标文件是否存在，发现缺失则返回失败。它不检查锚点或外部网站可访问性。

## 部署文件如何组合

| 文件 | 职责与组合 |
| --- | --- |
| `compose.yaml` | 日常 API/Web、业务数据卷、备份绑定目录、资源限制和本机入口；首次部署见[README](../README.md) |
| `Dockerfile` | 多阶段构建前端，用 `deploy/nginx.conf` 托管产物 |
| `backend/Dockerfile` | API 运行镜像，包含后端脚本、共享代码及 PDF 解析工具 |
| `deploy/nginx.conf` | 静态资源、前端路由回退、API 代理与 Web 健康入口 |
| `deploy/compose.acceptance.yaml` | 叠加日常编排用于独立功能/故障验收，隔离镜像标签与备份卷，关闭请求日志和自动备份；可选开启历史命令兼容 |
| `deploy/compose.production-load.yaml` | 叠加日常编排用于保留日志和自动备份的独立负载验收，要求专用备份目录；不与 `compose.acceptance.yaml` 叠加 |
| `deploy/compose.stability.yaml` | 在日常编排与 `compose.production-load.yaml` 后叠加，加入故障供应商及独立备份副本目录 |
| `deploy/compose.quality.yaml`、`deploy/compose.quality-live.yaml` | 分别在独立功能验收上叠加协议假服务或有持久预算的真实模型代理；真实模式消耗模型额度 |

覆盖文件仍需显式独立项目名、端口、访问源、镜像标签、数据卷和备份路径；具体命令保留在对应验收报告，不以文件名推断部署安全。`.github/workflows/validation.yml` 执行文档链接、后端、前端、依赖审计及隔离容器验证。

## 本地生成文件与受保护路径

| 路径 | 处理方式 |
| --- | --- |
| `.env`、其他实际环境配置 | 凭据与运行设置，保留且不提交；仓库只提交 `.env.example` |
| `backend/data/` | 源码运行的 SQLite、WAL 等业务数据，已忽略；不得当作缓存清理 |
| `backups/`、自定义 `BACKUP_PATH`/副本目录 | 恢复资产，保留并按备份维护流程管理 |
| Docker 卷 `shopmate-ai_api_data` | 日常容器数据库；项目文件整理不删除卷、不执行 `down -v` |
| `frontend/node_modules/`、`backend/node_modules/` | 可从各自锁文件重新安装的本地依赖，已忽略 |
| `frontend/dist/`、`*.tsbuildinfo` | 可重建的构建产物，已忽略 |
| `backend/.e2e/` | 隔离浏览器测试数据，已忽略，与日常数据库分开 |
| 前后端 `test-results/`、前端 `test-results-container/`、`test-results-operations/`、`playwright-report/` | 自动测试输出，已忽略；有失败需先保留定位证据 |
| `.taste-skill/` | 历史视觉工作流的本地目录，整体忽略，包含 `inspect/`、`page-audit/`、`assets/` 等输出；设计方向源记录已归入 `docs/archive/` |
| `.delivery/` | 本地交付过程材料，已忽略；其中备份、回滚和失败证据需核对后分别处理 |
| `docs/qa/`、`docs/screenshots/`、`backend/test/fixtures/ai/` | 已跟踪的报告证据、界面图片和合成测试输入，继续保留 |

“未被 Git 跟踪”或“名称像临时文件”不等于可删除。优先清理确认可重建的构建/测试输出；数据库、环境配置、备份、回滚材料和报告引用文件需要先核对用途与引用。后续新增当前说明放在 `docs/`，已完成阶段的记录放在 `docs/archive/`，并更新[文档导航](README.md)。

2026-10-20 结构整理时，清理了本地 `frontend/dist/`、`test-results/`、`test-results-container/`、`test-results-operations/` 四个生成目录，共 139 个文件、17,389,289 字节。清理前已打包 ZIP 并逐文件验证 SHA-256；归档和结果保存在被忽略的 `.delivery/structure-cleanup-20261020/`，其中 `result.json` 记录归档摘要、删除范围、受保护文件哈希及运行状态。该本地凭证不随仓库分发。
