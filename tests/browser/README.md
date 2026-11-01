# 浏览器回归

[文档索引](../../docs/README.md) · [开发与测试](../../docs/DEVELOPMENT.md)

测试使用实际发布的 UI 和隔离 HTTP/SQLite 应用。外部应用请求被阻止，提供方、邮件与支付使用合成数据；不是针对真实店铺或生产环境的验收。

## 固定环境与准备

在仓库根目录使用 [`.node-version`](../../.node-version) 指定的 Node。Playwright 是项目开发依赖，由 [`package.json`](../../package.json) 和锁文件固定为 1.64.1；Chromium revision 随对应 `playwright-core` 固定，不使用系统浏览器。

```powershell
npm ci --ignore-scripts
node node_modules/playwright/cli.js install chromium
npm run test:browser
```

Linux 环境需要浏览器系统库时，将准备命令改为 `node node_modules/playwright/cli.js install --with-deps chromium`。CI 的 Ubuntu 浏览器作业使用该方式。

准备工具需要网络，执行测试不会自动下载。套件直接导入项目 `playwright`，不使用外置模块或可执行文件覆盖入口；工具缺失时明确失败，不静默跳过。更新版本时同步锁文件，重新安装配套 Chromium 并执行回归，不能只替换全局工具。

`npm run test:browser` 将文件并发数设为 1，逐文件运行；仍需记录实际执行范围、浏览器版本和失败项。只有该提交在 GitHub 对应作业中的结果才能作为 CI 通过依据。

## 覆盖与清理

套件覆盖初始化、会话/角色、客户、库存、设备确认和管理、设置、结算及结果未知。每个套件拥有临时数据和浏览器上下文，在结束时关闭。

截图如需保留，放在已忽略的 `tests/browser/artifacts/`，不得包含真实客户或凭据页面。页面能打开或生成了截图不等于交互已验收。

## 手工 UI 检查

```powershell
node tests/browser/fixture-server.mjs
```

使用输出的临时回环地址和合成数据检查页面，结束后 Ctrl+C 停止。夹具不得发布到公网或接入生产提供方。

浏览器结果不证明真实提供方兼容、邮件到达、真实收款、已安装客户端或生产部署。这些结论须另行获得授权、执行验证，并按[发布清单](../../docs/RELEASE-CHECKLIST.md)记录。
