# 开发与测试

[文档索引](README.md) · [架构](ARCHITECTURE.md) · [协作约束](../AGENTS.md)

本文维护开发环境与检查方法，不是某个提交的通过报告。所有测试使用隔离数据；真实提供方、客户端安装、邮件到达、收款和生产部署另行授权验证。

## 环境准备与固定版本

命令在仓库根目录执行。CI 和标准本地回归使用 [`.node-version`](../.node-version) 指定的 Node.js 24.18.0；应用仍接受 `package.json` 声明的 Node 24.15+（24.x）。切换 Node 的方式由本机版本管理器决定，不修改全局工具配置。

```powershell
Get-Content .node-version
node --version
npm --version
npm ci --ignore-scripts
```

[`package.json`](../package.json) 与锁文件固定 Playwright 1.64.1 和 YAML 2.9.1 为开发依赖。对应 Chromium revision 由锁定的 `playwright-core` 提供，不跟随系统 Chrome 自动更新。Docker 生产安装使用 `--omit=dev`，这些测试依赖不进入生产运行依赖。

SQLite 使用 Node 内置模块，没有额外数据库服务；浏览器端没有打包步骤。`npm start` 会读取已有 `.env`，不是隔离测试入口。应用启动见[部署指南](DEPLOYMENT.md)。

### 准备浏览器与代理测试工具

安装 npm 依赖不等于下载了浏览器或 Caddy。首次运行或工具版本变更后，显式准备：

```powershell
node node_modules/playwright/cli.js install chromium
node scripts/install-caddy.mjs
```

Linux 缺少浏览器系统库时使用 `node node_modules/playwright/cli.js install --with-deps chromium`；CI 在 Ubuntu 中执行该命令。准备步骤需要网络，测试本身不自动下载安装。

Caddy 版本、平台归档和 SHA-256 固定在 [`tests/tools.json`](../tests/tools.json)。安装脚本只从固定的官方版本下载，校验后用 `tar` 提取指定程序并检查版本，安装到已忽略的 `node_modules/.bin/`；不改全局 PATH。需要系统已有 `tar`，不支持的平台或校验失败会停止，不能静默换成系统 Caddy。重新执行 `npm ci` 后需重新准备该工具。

浏览器和代理套件直接使用项目工具，不再通过外部模块、任意浏览器可执行文件或系统 PATH 的 Caddy 切换测试基线。详细 UI 检查见[浏览器回归](../tests/browser/README.md)。实际生产代理版本若不同，仍需另行验证，不能由这个固定基线推定通过。

## 修改从哪里开始

先查[架构职责表](ARCHITECTURE.md)，再查实现与测试。

| 变更 | 同步关注 |
| --- | --- |
| 客户、账号、设备和权限 | 服务端校验、UI、HTTP/浏览器测试及业务指南 |
| 上游或下级 API | 调用方、响应投影、scope/归属、分页、错误和[接口契约](API-CONTRACT.md) |
| 支付、钱包和交付 | 配置快照、幂等意图、未知结果、查单、迁移及恢复路径 |
| 共享前端规则 | `public/` 的浏览器和 Node 导入方，不只验证界面 |
| 配置、数据或静态资源 | 环境模板、Compose、Docker 白名单、安全测试和运维指南 |
| 测试工具或 CI | 固定版本及校验值、锁文件、调用方、工程约束测试和文档 |

不为少改调用点保留旧名字、只转发包装或重复实现。遵守 [AGENTS.md](../AGENTS.md)，检查工作区并保留其他人的修改和正在使用的数据。

## 测试分层

| 命令 | 前置条件 | 能证明的范围 |
| --- | --- | --- |
| `npm test` | 固定 Node 与锁文件依赖 | 服务端、共享规则、配置透传、文档链接和 CI/工具约束；HTTP/SQLite 使用合成夹具 |
| `npm run test:security` | Gitleaks 8.30.1 在 PATH | 仓库策略、暂存区/历史、构建白名单回归 |
| `npm run check:security` | 完整 Git 历史、Gitleaks 8.30.1 | 可达历史、reflog 和当前暂存区；不覆盖未暂存文件 |
| `npm run test:browser` | 锁定 Playwright 及其 Chromium 已准备 | 实际 UI、隔离应用和合成业务数据 |
| `npm run test:proxy` | 按固定清单安装的项目 Caddy | 本地反向代理 SSE 进度、静态 gzip 与断线取消 |

命令互相独立，`npm test` 不会顺带运行其他行。可以单独运行实际测试文件：

```powershell
node --test tests/server/project-contract.test.js
node --test tests/server/runtime.test.js
```

[`project-contract.test.js`](../tests/server/project-contract.test.js) 验证版本锁定、Compose 配置覆盖、实际配置校验、CI 的分层与权限，以及文档本地链接、代码围栏、JSON 示例和仓库边界。它不检查网络链接可达性，也不证明 GitHub 已经运行过新工作流。

代理测试只启动隔离回环端口，不调用真实提供方；检查多种 Accept-Encoding 下的 SSE 进度、取消和静态 gzip。版本必须匹配清单，否则先重新准备工具，不绕过失败。

## 安全检查与协作

Gitleaks 不由测试自动安装；CI 固定 8.30.1 并校验下载摘要，本地使用同版本。自构建工具若未在 `gitleaks version` 中写入版本，应核对构建来源/模块版本，不猜测版本。

```powershell
git config --local core.hooksPath .githooks
npm run test:security
npm run check:security
```

默认检查读取历史与暂存区，不包含尚未暂存的新文件。只暂存本次审查过的文件再检查，不把历史扫描通过当作整个工作区安全。规则见[仓库安全](SECURITY.md)。

## CI 的实际范围

| 工作流 / 检查 | 触发与环境 | 执行内容 |
| --- | --- | --- |
| [Repository security](../.github/workflows/repository-security.yml) | push、pull request、手动；Ubuntu | 完整历史安全检查及安全回归 |
| [Application checks](../.github/workflows/application.yml) / Server and contracts | main 的 push、pull request、手动；Ubuntu 24.04 与 Windows 2025 | `npm test`；Ubuntu 另校验 Compose 示例 |
| Application checks / Browser regressions | 同上；Ubuntu 24.04 | 安装固定 Chromium 和系统库，执行浏览器回归 |
| Application checks / Proxy regressions | 同上；Ubuntu 24.04 | 校验并安装固定 Caddy，执行代理回归 |

Action 使用完整提交 SHA，Node 从同一版本文件读取。应用工作流只需仓库读取权限、不保留 checkout 凭据、不读取生产秘密、不自动发布或部署。检查项不以缺少工具为由跳过，也不将失败标为允许继续。

**工作流文件已存在不等于对应提交在 GitHub 上已通过。** 发布时核对每一项实际运行结果；本地 Windows 结果不能替代 Linux runner 结果。分支保护需在仓库设置中将所需检查设为必需，本仓库文件不会自动修改保护规则。

## 文档与交付检查

1. 修改负责行为的实现及全部调用方，更新真实回归，不留下临时服务、探针和实验入口。
2. 同步配置、接口、数据及工具文档，新增页面更新[索引](README.md)；指南写现状，发布记录写本次证据。
3. 执行分层测试，记录未执行项。工具准备、隔离测试、真实联调和生产验收不能相互替代。
4. 用 `git diff --check` 和逐文件 diff 检查变更，安全扫描覆盖真正准备提交的版本。
5. 原始日志、备份、客户截图和真实凭据留在仓库外受保护位置；脱敏记录格式见[发布清单](RELEASE-CHECKLIST.md)。
