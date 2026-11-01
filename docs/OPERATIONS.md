# 升级、恢复与排障

[文档索引](README.md) · [部署与配置](DEPLOYMENT.md) · [发布检查清单](RELEASE-CHECKLIST.md)

本文只操作本站，不授权修改直接提供方。以下是操作顺序和检查方法，不能代替本次备份/恢复演练。备份、私有配置和原始验证证据必须位于仓库外受保护位置。

## 升级前确认

1. 记录当前和目标源码提交、Node/容器镜像 ID、配置来源、数据目录或卷身份、数据库 schema 版本。`package.json` 的版本不能替代提交与镜像身份；应用目前不提供部署版本端点。
2. 审查目标版本的代码、配置和数据迁移。检查未完成支付、交付、客户同步及分配批次，记录其原始业务标识和状态。
3. 确认维护窗口、备份位置、恢复负责人和失败后的回退条件；保留旧程序/镜像和匹配的配置备份。
4. 在隔离环境执行目标版本所需测试与恢复验证。没有验证过的提供方或客户端版本不能直接写入“兼容”。

## 成套备份

| 对象 | 要求 |
| --- | --- |
| 完整 `DATA_DIR` | 包括 SQLite、仍存在的 WAL/SHM、配套密钥、身份和未完成业务意图；不要只挑数据库主文件 |
| `payment.key` | 必须与历史订单快照匹配；不能通过生成新密钥修复旧数据 |
| `upstream.key`（存在时） | 页面保存上游配置的配套密钥；不要因环境模式不使用它而删除已有文件 |
| 未消费的 `setup.secret`（存在时） | 随未初始化实例保护；已初始化实例不需要重新生成 |
| 环境及代理配置 | 环境托管的上游/SMTP/Stripe 密钥不由数据卷自动恢复；禁止输出展开配置到公开日志 |
| 代码/镜像与记录 | 固定提交、镜像身份、数据 schema 和备份时间，能找到匹配的恢复版本 |

### 冷备份顺序

当前仓库没有专用在线备份工具。采用停机冷备份时：

1. 暂停本站入口和写入，等待活动请求及后台核对结束。Node 进程正常退出；Compose 示例使用下方命令停止，并确认服务已经停止。
2. 再复制或快照**完整数据目录/卷**到新的受保护备份。保留权限；备份目标不得落在仓库或源数据目录内。不手工删除 WAL/SHM 文件。
3. 单独保护环境与代理配置，以及旧镜像/源码版本；不将秘密内容写入备份清单。
4. 对备份检查完整性并生成摘要记录；从备份再复制一份验证副本，按下一节检查，不直接启动或修改唯一备份。

```powershell
# 使用与启动时完全相同的项目身份、环境文件及覆盖文件参数。
docker compose --env-file .env -f compose.example.yml stop merchant
docker compose --env-file .env -f compose.example.yml ps --all merchant
```

Compose 的 `merchant-data` 是逻辑卷名，实际名称受项目身份影响。先查看目标容器的挂载，确认 `/app/data` 对应的真实卷，再使用已批准的卷备份方式。不能把宿主机仓库下的 `./data` 当作该容器卷备份。不要运行带卷删除选项的清理命令。

## 隔离恢复验证

1. 在独立目录或全新卷中恢复验证副本，配套数据库、密钥和配置来自同一备份；不要覆盖仍在使用的原目录。
2. **先隔离出站网络再启动恢复实例**。真实备份包含待核对任务；仅换端口不能防止实例访问提供方、支付或邮件。`RECONCILE_INTERVAL_MS=0` 不是受支持的部署关闭开关。
3. 在不启动应用的情况下，使用 Node 24 对验证副本进行只读 SQLite 检查。以下命令只输出校验结果及 schema 标识，不输出客户或密钥数据：

```powershell
$env:MERCHANT_RESTORE_DB = Read-Host '验证副本中 merchant.sqlite 的完整路径'
@'
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
const path = process.env.MERCHANT_RESTORE_DB;
if (!path || !statSync(path).isFile()) throw new Error('Select an existing restore-copy database');
const db = new DatabaseSync(path, { readOnly: true });
try {
  const check = db.prepare('PRAGMA quick_check').all();
  const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
  if (!check.length || check.some(row => row.quick_check !== 'ok') || foreignKeys.length) {
    throw new Error('Restore-copy integrity checks failed');
  }
  console.log({
    quick_check: 'ok',
    foreign_key_violations: foreignKeys.length,
    application_id: db.prepare('PRAGMA application_id').get().application_id,
    user_version: db.prepare('PRAGMA user_version').get().user_version,
  });
} finally {
  db.close();
}
'@ | node --input-type=module
if ($LASTEXITCODE -ne 0) { throw '恢复副本检查失败；停止切换。' }
Remove-Item Env:MERCHANT_RESTORE_DB
```

4. 将 schema 标识与目标版本 [`src/store.js`](../src/store.js)、[`src/payment-migration.js`](../src/payment-migration.js) 的准入和迁移规则核对；数据库检查通过不证明密钥匹配或业务状态正确。
5. 在隔离网络和私有配置中启动目标程序，确认没有意外初始化、历史数据可读、管理员权限和订单/批次状态保留。程序启动可能迁移验证副本，不应改变原备份。
6. 记录恢复结果和未覆盖项，关闭验证实例。真实外部行为只在获得授权后单独验证，不让原实例和恢复实例同时操作真实资源。

## 升级与放行

维护窗口内确认备份可恢复后，使用审查过的提交及相同配置/数据位置部署新程序。Compose 按[部署指南](DEPLOYMENT.md)重新构建启动；非容器部署在服务停止后安装锁定依赖并启动。

启动会执行数据库检查和迁移，不能据此推断旧程序能读取新 schema。当前迁移还涉及支付快照、客户/审计字段和批次恢复：

- 进程中断时，分配批次执行中项进入待核对，其他项不会自动全部重跑。
- 支付创建过程可能已在渠道成功，重启后仍需核对，不重复创建交易。
- `RUNTIME_TIMEOUT_MS` 已不使用；部署配置应改为 `RUNTIME_HEADER_TIMEOUT_MS`。它只限制响应头等待，不限制成功响应头后的整个正文时间。

按[发布清单](RELEASE-CHECKLIST.md)检查公开页面、登录、权限、连接、流式进度与取消，以及获授权的邮件/支付验证。未通过前不要开放收款或声明全量验收。

## 回退条件

- 只有确认旧程序兼容当前数据时，才能只切回旧镜像/程序。
- schema 不兼容时，需恢复**匹配的数据库、配套密钥和配置**；保留失败升级后的数据副本，不能直接覆盖后丢失证据。
- 如果升级后已接收真实付款、交付或其他写入，恢复旧备份会丢掉这些新记录。先停止写入并核对外部状态，不能把代码回退当作渠道交易回退。
- 恢复完成后仍需核对未知订单、授权和设备，不更换幂等标识“重试”，不直接改账本，不删除身份绑定。

## 常见问题

| 现象 | 优先核对 | 不要这样处理 |
| --- | --- | --- |
| 启动失败 | Node 版本、成对环境参数、origin、数据权限、数据库/密钥是否匹配 | 清空目录或打印整份配置/异常对象 |
| 初始化被拒绝 | 是否直连服务回环、Host/Origin、是否已初始化 | 从公网提交令牌或放开初始化来源校验 |
| 已有站点再次出现初始化 | 是否切换了数据目录、Compose 项目名或卷 | 在空卷重建管理员后误当恢复完成 |
| `invalid_host` / `invalid_origin` | 代理保留的 Host、浏览器 origin、`PUBLIC_ORIGIN` | 放行任意 Host/Origin |
| 接入身份不匹配/权限不足 | 固定提供方、本站密钥、绑定身份及所需 scope | 删除绑定或借用其他站点密钥 |
| `.env` 改了但容器未生效 | Compose 是否显式传入、是否沿用环境配置锁；见[配置说明](DEPLOYMENT.md) | 将整个私有环境无差别暴露给容器或浏览器 |
| SSE 等到结束才出现 | 代理压缩、刷新、缓存、实际 Caddy 版本 | 仅加大超时或禁用断开取消 |
| `runtime_busy` | 并发、活动请求是否结束及取消是否传递 | 自动重放可能已经执行的模型请求 |
| 支付/交付/分配结果未知 | 原订单或批次、原修订号、服务端核对结果 | 新建另一笔交易、释放未知占用或手工改账 |
| 邮件已发送但未收到 | SMTP 配置、查验实际投递；发送、到达和验证分别记录 | 把发送调用成功等同于收件成功 |

故障记录只保留必要的时间、版本、脱敏错误和业务状态。不要把 Cookie、访问令牌、上游身份资料、支付签名或真实客户截图加入仓库。
