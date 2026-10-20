# 运行观测与备份副本

监控从主机经过 Web 代理访问 API，同时检查 Docker 容器和主机磁盘。它只报告故障，不自动重启、恢复数据库或修改业务数据。进程需要由操作系统或现有运维工具持续托管；关闭终端会停止监控。

## 首次运行

使用 Node.js 24、Docker CLI 和已安装依赖的 `backend/`。在根目录被 Git 忽略的 `.env` 中填写：

```dotenv
MONITOR_BASE_URL=http://127.0.0.1:18086
MONITOR_COMPOSE_PROJECT=shopmate-ai
MONITOR_ADMIN_USERNAME=admin
MONITOR_ADMIN_PASSWORD=填写当前管理员密码
MONITOR_MAINTENANCE_FILE=../.delivery/monitor-maintenance.json
```

填写当前具有 `settings` 权限的管理员凭据；首次初始化的 `ADMIN_PASSWORD` 可能已过时。密码只用于换取内存中的会话，失效后重新登录。也可单独设置 `MONITOR_ADMIN_COOKIE`，但其过期后必须人工更换；该项优先于密码登录。凭据、Cookie 和 webhook URL 不应出现在命令行参数、截图、日志或 Git 中。

```powershell
Set-Location backend
node --env-file-if-exists=../.env --import tsx scripts/monitor.ts --once
node --env-file-if-exists=../.env --import tsx scripts/monitor.ts
```

`--once` 输出当前问题，有问题返回退出码 1；它只做一次检查，不代表完成三次故障确认或长期稳定性验收。持续模式每分钟开始一轮检查，单轮不重叠。HTTP 只允许回环地址，远程地址必须使用 HTTPS，所有请求拒绝重定向。

默认容器名为 `<MONITOR_COMPOSE_PROJECT>-api-1` 和 `…-web-1`；有自定义容器名时设置 `MONITOR_API_CONTAINER`、`MONITOR_WEB_CONTAINER`。设置 `MONITOR_DISK_PATHS` 为逗号分隔的实际主机目录，至少覆盖数据库卷所在磁盘和备份目标所在磁盘。默认检查启动目录所在磁盘，不能因此认定 Docker 数据盘也已检查。Windows 的 Docker 数据卷可能在另一个磁盘上的虚拟磁盘文件中，应检查其实际宿主目录。

## 告警和维护

以下问题分别连续出现三次才产生告警；相同状态不会每分钟重复发送，故障恢复产生恢复事件：

| 检查             | 默认门槛                                                                         |
| ---------------- | -------------------------------------------------------------------------------- |
| 代理后的健康状态 | 请求失败、非成功状态或健康内容异常                                               |
| 健康响应耗时     | 超过 2 秒；单次请求超时 5 秒                                                     |
| API／Web 容器    | 未运行、OOM 标记或已配置的健康检查不健康                                         |
| 磁盘             | 任一配置目录可用空间低于 20%，或目录无法读取                                     |
| 后台任务         | 有失败任务，或到期任务已等待超过 5 分钟                                          |
| 自动备份         | 未启用、没有成功恢复点、最近成功快照超过 23 小时或当前备份／副本失败             |
| 已配置的备份副本 | 接收端恢复点缺失、时间无效或未来时间、快照超过 23 小时，独立报告 `REPLICA_STALE` |
| 诊断权限／可用性 | 管理会话失效、权限不足或诊断接口请求失败                                         |

配置 `MONITOR_WEBHOOK_URL` 后发送固定事件名、问题代码和时间，不发送请求正文、客户资料、SQL、凭据或目标 URL。webhook 必须使用 HTTPS；发送失败每分钟重试，直到成功、状态变化或进入维护。启动显示 `告警未接通` 时只有本地输出，不能认为外部接收渠道已经接通。配置完成后需要实际制造并恢复一个受控故障，核对接收端的告警和恢复消息。

计划停机前，从项目根目录使用 PowerShell 7 写入有截止时间的维护文件：

```powershell
New-Item -ItemType Directory -Force .delivery | Out-Null
@{ until = (Get-Date).AddMinutes(30).ToUniversalTime().ToString('o') } |
  ConvertTo-Json | Set-Content -LiteralPath .delivery/monitor-maintenance.json -Encoding utf8
```

维护期间停止探测和 webhook 投递，并重置故障确认次数。截止后自动恢复检查；提前结束时删除该文件。也可使用 `MONITOR_MAINTENANCE_UNTIL`；读取到可解析的维护文件时，使用文件中的 `until` 覆盖环境变量，最终时间无效或已过期均不启用静默。监控不执行任何重启动作，维护标记不控制 API 本身。

## 管理诊断接口

`GET /api/admin/diagnostics` 需要有效管理会话及 `settings` 权限，普通用户或客服员工无法访问。返回进程内在途／完成／过载请求数、HTTP 数据库繁忙次数、到期任务等待时间、失败任务数、AI 活动状态数、备份状态及版本引用。

幂等结果、任务和报价的记录数、保留正文 UTF-8 字节数每 60 秒采样并缓存；增长量相对上一采样，首次为 `null`。字节数不是 SQLite 文件占用，进程内计数和采样基线在重启后重置。统计不返回正文；数据量较大时聚合仍会产生读负载，因此不要高频轮询管理接口。首次采样会等待聚合完成。

## 配置独立备份副本

默认 `BACKUP_PATH` 是主机本地备份目录。可增加一份未跟踪的 Compose 覆盖文件，例如 `.delivery/compose.replica.yaml`：

```yaml
services:
  api:
    environment:
      BACKUP_REPLICA_DIR: /app/replica
    volumes:
      - ${REPLICA_PATH:?Set an independent host destination}:/app/replica
```

在 `.env` 中设置 `REPLICA_PATH` 为独立、可写的目标目录。计划维护窗口使用覆盖文件启动：

```powershell
docker compose -f compose.yaml -f .delivery/compose.replica.yaml up -d --wait
```

后续所有该部署的 Compose 命令应继续携带相同覆盖文件。单独修改 `.env` 的 `BACKUP_REPLICA_DIR` 不会给默认 Compose 添加挂载或环境变量。启动前核实 Docker 已映射到预期目标，保留现有数据卷、手动备份和升级前备份。

API 的备份子进程成对复制数据库和清单，在目标端重新校验后记录副本恢复点；失败会保留本地成功恢复点并记录安全错误代码。副本不参与本地自动备份的 7 份保留清理，需按自身容量和恢复要求管理。不能把目标设置为源目录。

诊断中的 `replicaConfigured` 表示 API 已设置接收目录；监控按 `lastReplicaSnapshotAt` 独立判断副本年龄，本地备份成功或错误标记清除不会消除副本过期告警。复制失败后不会为重试生成新的本地备份，自动复制要等到下一次备份；处理接收端故障后，应使用维护命令对最新完整备份执行 `replicate` 并在接收端执行 `verify-replica`。手动命令不修改在线诊断标记，下一次自动复制成功后标记才更新。更换接收目标时也应先完成该复制和校验，不能把旧目标的历史状态当作新目标的恢复证据。

诊断中的 `replicaKind: filesystem-copy` 和 `offhostVerified: false` 有明确含义：目录挂载或同机另一文件夹无法证明物理异机容灾。实际异机存储、复制链路和恢复演练仍需落实并保存证据；本机复制通过不能认定整机损坏后的 RPO 已达标。
