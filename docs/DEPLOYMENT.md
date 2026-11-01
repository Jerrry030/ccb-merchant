# 部署与配置

[文档索引](README.md) · [升级、恢复与排障](OPERATIONS.md) · [发布检查清单](RELEASE-CHECKLIST.md)

本文只部署本站。提供方地址与本站专用接入密钥由提供方交付；不要求访问其管理系统。命令在仓库根目录执行，交互示例使用 PowerShell 7。执行部署前另行获得部署授权；文档中的命令不是已经完成的验收记录。

## 选择运行方式

| 方式 | 前置条件 | 配置与数据 |
| --- | --- | --- |
| 本地 Node | Node.js 24.15+（仅 24.x）、npm | `npm start` 读取已有 `.env`；默认数据在 `./data` |
| Docker Compose | Docker 与 Compose 插件、域名及 HTTPS 反向代理 | 显式环境变量、命名卷 `merchant-data`，容器内数据目录 `/app/data` |

当前按单实例维护数据和后台核对。不要复制同一数据卷并让两个实例同时处理真实业务。Docker 基础镜像是 `node:24-bookworm-slim`，不是不可变镜像摘要；正式发布需记录实际构建镜像 ID/摘要。

## 本地 Node 启动

```powershell
node --version
npm ci
if (!(Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
npm start
```

首次使用保留模板的 `HOST=127.0.0.1`、`PORT=8787`、`PUBLIC_ORIGIN=http://localhost:8787` 和 `ALLOW_REMOTE=false`。打开本地地址，在初始化页面输入 `DATA_DIR/setup.secret` 中的令牌，创建管理员。只在本机读取令牌，勿复制到工单、日志或聊天。

若 `.env` 已存在，先核对而非覆盖。`DATA_DIR` 位于静态目录之外；应只有运行账号和获授权备份人员能够访问。退出前用 Ctrl+C 等待服务停止，不以删除数据目录代替重启。

## Docker Compose 启动

1. 选择经过审查的源码提交，检查工作区无未审查的运行代码。构建使用工作区内容，不会自动只取 Git HEAD。
2. 准备受保护的 `.env`，将 `PUBLIC_ORIGIN` 改为本站真实 HTTPS origin，例如 `https://merchant.example.com`，不能附带路径、查询参数或凭据。
3. 配置同一主机上的 HTTPS 代理；示例只将应用端口发布到宿主机 `127.0.0.1:8787`。
4. 验证配置语法并启动：

```powershell
# --quiet 仅校验，不把展开后的环境密钥打印到终端。
docker compose --env-file .env -f compose.example.yml config --quiet
# 上一步成功后执行；构建/启动成功不等于上游或支付验收。
docker compose --env-file .env -f compose.example.yml up -d --build merchant
docker compose --env-file .env -f compose.example.yml ps merchant
```

[`compose.example.yml`](../compose.example.yml) 设置容器监听 `0.0.0.0:8787`、`ALLOW_REMOTE=true`、只读根文件系统、临时 `/tmp` 和独立可写数据卷。不要为了修复启动问题删除卷；改变 Compose 项目名/工作目录可能选中另一命名卷，出现初始化页时先核对挂载。

### 容器首次初始化

`POST /api/setup` 同时要求服务看到回环来源和本地 Host。公网 HTTPS、普通反向代理或宿主机端口映射不等于容器内直连回环。**不要为初始化放宽安全校验，也不要把 setup 令牌发送到公网接口。**

首次创建管理员可以在容器内部读取一次性令牌并向本进程发送回环请求。以下代码不回显令牌、密码、Cookie 或响应正文；邮箱和密码在本机交互输入，经标准输入传给容器，不作为命令行参数或环境变量保存。执行前确认当前 Compose 指向需要初始化的本站实例。

```powershell
$setupEmail = Read-Host '管理员邮箱'
$setupName = Read-Host '管理员显示名'
$setupPassword = Read-Host '管理员密码（至少 6 个字符，建议使用长随机密码）' -AsSecureString
$bootstrap = @'
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from './src/config.js';
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
  const config = loadConfig();
  body.setup_token = (await readFile(join(config.dataDir, 'setup.secret'), 'utf8')).trim();
  const origin = `http://127.0.0.1:${config.port}`;
  const response = await fetch(origin + '/api/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  await response.body?.cancel();
  if (response.status !== 201) throw new Error('Setup rejected');
  console.log('Administrator created. Sign in through the configured HTTPS origin.');
} catch {
  console.error('Setup failed or outcome unknown. Check the instance and initialization state locally; do not print credentials.');
  process.exitCode = 1;
}
'@
try {
    @{
        email = $setupEmail
        display_name = $setupName
        password = [Net.NetworkCredential]::new('', $setupPassword).Password
    } | ConvertTo-Json -Compress |
        docker compose --env-file .env -f compose.example.yml exec -T merchant node --input-type=module -e $bootstrap
    if ($LASTEXITCODE -ne 0) { throw '初始化未确认成功；先核对状态，不自动重复执行。' }
} finally {
    $setupPassword.Dispose()
    Remove-Variable setupPassword, setupEmail, setupName, bootstrap -ErrorAction SilentlyContinue
}
```

成功后在配置的 HTTPS 地址登录。初始化返回的会话不被保存；令牌消费后不能再次创建管理员。若执行结果不明，先检查公开设置中的 `setup_required` 和本站管理员状态，不重新生成令牌或删除数据库。

## HTTPS 与上线检查

使用 [`Caddyfile.example`](../Caddyfile.example) 时替换域名，并确保代理能到达宿主机回环端口。代理部署在其他容器/主机时不能原样使用 `127.0.0.1`，需单独设计受限网络和来源策略。

- 保留浏览器请求的正确 Host/Origin；本站公开地址必须与 `PUBLIC_ORIGIN` 一致。
- `/bridge/v1/*` 排除响应压缩，静态资源保留 gzip；代理须及时刷新 SSE 并传递断开取消，不配置负值 `flush_interval`。
- Caddy 行为有独立[代理回归](../tests/proxy/caddy.test.js)，仍需按部署版本验证，不能只检查网页能打开。

可在本机手工执行以下无凭据读取，将示例域名替换为本站地址：

```powershell
Invoke-RestMethod -Uri 'https://merchant.example.com/api/public'
```

它检查公开设置路由、HTTP 可达性和初始化状态，**不是全链路健康检查**。当前项目没有专门的 `/healthz` 或部署版本查询端点。还须分别检查登录、权限、上游连接、真实获授权账号和运行取消；邮件到达与真实支付需独立授权验收。

## 配置来源与优先级

配置实现见 [`src/config.js`](../src/config.js)，模板见 [`.env.example`](../.env.example)。

- `npm start` 使用 Node 的 `--env-file-if-exists=.env`；已有进程环境优先于文件。直接运行 `node src/main.js` 不自动读取 `.env`。
- 镜像启动的是 `node src/main.js`，只收到容器环境；Compose 的 `.env` 用于替换 Compose 中显式引用的值，不会把所有字段自动注入容器。
- 上游 URL/密钥、SMTP 主机/发件人、Stripe 密钥/通知密钥各自成对配置。环境托管时对应页面配置受限；全留空才使用页面保存的配置。
- `SITE_NAME` 和支付金额范围是新数据/新配置的初始值；已有站点名称及支付配置由保存的设置决定，重设环境默认值不等于覆盖已有设置。

### 环境变量

下表为 Node 进程的默认值；Compose 对监听地址、远程许可、数据目录作了上述显式覆盖。毫秒、字节和最小货币单位不能混用。

| 参数 | 默认值 / 约束 | 作用 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `8787`；1–65535 | 监听端口 |
| `PUBLIC_ORIGIN` | 缺省为 `http://localhost:${PORT}` | 公开 origin；模板固定为本地 8787，改端口时同步核对 |
| `ALLOW_REMOTE` | 未设置不允许；启用必须是 `true` | 非回环监听或公开地址需同时提供显式 origin；远程地址必须 HTTPS |
| `DATA_DIR` | `./data` | 相对启动工作目录解析，禁止位于 `public/` 内 |
| `SITE_NAME` | `CCB Merchant` | 新站点名称初始值 |
| `UPSTREAM_URL`、`UPSTREAM_API_KEY` | 均为空；必须同时设置或同时留空 | 直接提供方及本站专用密钥，不能使用提供方管理员或其他站点的密钥 |
| `UPSTREAM_ALLOWED_ORIGINS` | 空；逗号分隔的精确 origin | 页面配置私网/HTTP 目标前的显式批准；不绕过元数据地址等禁用策略 |
| `UPSTREAM_TIMEOUT_MS` | `15000`；100–120000 | 控制接口完整响应期限 |
| `RUNTIME_HEADER_TIMEOUT_MS` | `600000`；100–3600000 | 模型/透传请求等待响应头的期限，不是整段流总时长 |
| `RUNTIME_BODY_LIMIT` | `33554432`；4096–33554432 | 运行请求正文上限，字节 |
| `RUNTIME_MAX_IN_FLIGHT` | `8`；1–128 | 单进程运行请求并发上限，不是可销售的客户数 |
| `RECONCILE_INTERVAL_MS` | `10000`；1000–300000 | 后台核对间隔；部署配置不接受 0 作为停用开关 |
| `SMTP_HOST`、`SMTP_FROM` | 均为空；成对配置 | 环境托管邮件服务，覆盖页面配置 |
| `SMTP_PORT` | `587`；1–65535 | 465 使用 TLS，其余端口要求 STARTTLS |
| `SMTP_USER`、`SMTP_PASSWORD` | 均为空；成对配置 | 可信 TLS 中继允许同时不提供认证 |
| `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET` | 均为空；成对配置 | 环境托管 Stripe，须匹配测试/正式环境 |
| `PAYMENT_MIN_MINOR` | `100`；1–1000000 | 新支付配置的最小金额 |
| `PAYMENT_MAX_MINOR` | `1000000`；1–100000000 | 新支付配置的最大金额；实际交易仍按保存的渠道规则校验 |
| `HOME_PREVIEW_SAMPLE` | `false` | 仅本地首页预览，真实站点不得启用 |

环境中的 `UPSTREAM_URL` 本身构成对该精确 origin 的显式批准；页面向导不会从空环境推定同样的授权。只有所需目标获批准才能使用私网/HTTP，不要扩大为任意地址代理。

### Compose 参数传递

示例已显式传入 `UPSTREAM_ALLOWED_ORIGINS`、`RUNTIME_MAX_IN_FLIGHT`、`RECONCILE_INTERVAL_MS`，默认值分别为空、8 和 10000。需要调整时，在受保护的部署环境中设置对应值，校验 Compose 配置后重新创建服务；只编辑文件、不更新容器，不会改变正在运行的进程。

当前示例覆盖生产环境参数；本地预览开关 `HOME_PREVIEW_SAMPLE` 刻意不传入。监听地址、端口、数据目录及远程许可使用容器所需的固定值，不能假定改同名 `.env` 字段就覆盖这些设置。

使用部署方覆盖文件时，配置验证、启动、初始化、停止和恢复命令保持同一组 `-f` 参数及项目身份。不要把展开后的私有配置提交到仓库。配置覆盖与默认值有[工程约束回归](../tests/server/project-contract.test.js)，但该回归不代替实际部署验证。

## 接入和收款前

在管理页面核对提供方身份、状态、实际权限和获分配资源。未知、未配置和不可达不能解释为无库存或接入成功。真实兼容范围见[接口契约](API-CONTRACT.md)，上线放行见[发布检查清单](RELEASE-CHECKLIST.md)。

支付渠道与前台支付方式的配置入口在站点设置；各渠道资格、币种、通知地址和真实查单分别核验。不要使用用户真实支付来替代开发测试，也不要把配置保存成功写成收款验收。
