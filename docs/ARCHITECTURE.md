# 架构与数据边界

[文档索引](README.md) · [接口契约](API-CONTRACT.md) · [开发与测试](DEVELOPMENT.md)

本文描述商户自身的实现，不规定直接提供方的内部架构。运行单元是一个 Node.js HTTP 进程、SQLite 数据目录和浏览器静态资源；无需独立前端构建服务或外部 SQLite 服务。

## 身份与系统边界

| 身份 | 作用 | 不应混用的内容 |
| --- | --- | --- |
| 本站管理员/成员 | 浏览器登录、客户业务和管理权限 | 不是提供方管理员，也不是服务接入密钥 |
| 本站上游身份 | 以本站专用密钥访问直接提供方 | 密钥不发送到浏览器或下游 |
| 本站 API 客户 | 用本站签发的密钥访问分配给它的能力 | 不继承本站全部库存或更上游管理能力 |
| 运行设备 | 经确认后选择获授权的 Code 账号 | 设备 bearer、网页登录会话和 API 密钥相互独立 |

直接提供方可以是支持当前公开契约的服务或上一层商户。每一跳只保存和验证直接关系，不能用上游 ID 代替本地归属检查。兼容性条件见[接口契约](API-CONTRACT.md)。

## 代码职责

| 实现 | 职责 |
| --- | --- |
| [`src/main.js`](../src/main.js)、[`src/config.js`](../src/config.js) | 配置校验、监听、信号处理与停机 |
| [`src/server.js`](../src/server.js) | 组装服务、静态资源、HTTP 路由和响应边界 |
| [`src/security.js`](../src/security.js)、[`src/auth.js`](../src/auth.js) | Host/Origin、输入、密码、会话、CSRF、初始化和登录安全 |
| [`src/customers.js`](../src/customers.js)、[`src/devices.js`](../src/devices.js) | 本站客户同步、设备归属和跨客户设备查询 |
| [`src/inventory.js`](../src/inventory.js)、[`src/admin-queries.js`](../src/admin-queries.js) | 账号交付、持久化编号、批次协调及管理查询 |
| [`src/commerce.js`](../src/commerce.js) | 套餐、钱包、交付订单和取消核对 |
| [`src/payments.js`](../src/payments.js)、[`src/payment-providers.js`](../src/payment-providers.js)、[`src/payment-settings.js`](../src/payment-settings.js) | 渠道配置、支付创建、通知核验和查单 |
| [`src/integrations.js`](../src/integrations.js)、[`src/mail.js`](../src/mail.js) | 站点/邮件设置、配置来源与邮件传输 |
| [`src/upstream.js`](../src/upstream.js)、[`src/upstream-network.js`](../src/upstream-network.js) | 提供方身份、服务端配置、响应投影、分页与出站目标策略 |
| [`src/access.js`](../src/access.js) | 本站 API 客户、密钥、资源分配及逐跳 ID 映射 |
| [`src/runtime.js`](../src/runtime.js) | Code 请求授权、受限转发、流式返回和取消 |
| [`src/store.js`](../src/store.js)、`src/*schema.sql`、[`src/payment-migration.js`](../src/payment-migration.js) | SQLite 事务、启动迁移、配套密钥与审计 |
| [`src/reconciler.js`](../src/reconciler.js) | 按数据库中的意图调度客户同步、支付查单及交付核对 |

这是职责地图，不是声称代码已经严格分层。部分规则位于 `public/`，由 Node 与浏览器直接共用；新增规则应修改负责它的实现及全部调用方，不增加只转发的包装入口。

## 主要请求流

1. **浏览器业务**：同源请求进入 HTTP 边界，验证会话、CSRF 和管理权限，再执行客户、库存或财务操作。界面隐藏按钮不能代替服务端授权。
2. **账号交付**：读取可交付资源及修订号，保存客户、账号、期限和批次意图，再调用直接提供方。成功、冲突和结果未知分开持久化；批次 HTTP 成功不表示每项成功。
3. **支付交付**：创建订单并保存渠道配置快照；通知验签及查单确认付款后，交付仍有自己的状态。网页回跳不能确认收款，钱包退回不等于渠道原路退款。
4. **运行请求**：核对调用方、设备和资源，转发到固定提供方；仅允许声明的方法、路径和载荷。响应头等待、控制接口总超时、并发及体积限制分别生效。
5. **下级 API**：核对本站 API 密钥和 scope，解析本地资源/客户/授权归属，再映射到直接提供方。响应只返回声明字段和本地可见标识。

后台核对不等于任意请求重试：它调度已保存的客户同步、支付查询和交付意图，不重放运行请求。管理员分配批次中断后，执行中项转为待核对；未执行项仍需管理员显式继续。恢复实例连接真实网络前须考虑后台任务会产生外部作用。

设备状态的本站用户名由 `src/devices.js` 核对本地用户→直接提供方客户→设备的唯一归属，再由 `src/runtime.js` 仅注入本站终端响应。该读取不以当前账号为身份依据，不透传上级用户名；有界进程内缓存不持久化邮箱或新增数据库结构。核对失败保留原有设备状态并省略用户名，具体预算见[接口契约](API-CONTRACT.md#终端状态中的本站登录用户名)。

## 持久化与运行模型

- `DATA_DIR/merchant.sqlite`：本站身份、会话、客户映射、钱包、订单、批次、审计、设置及 API 接入状态。使用 WAL；运行中可能存在 `-wal`、`-shm` 文件，不能只复制主文件宣称获得完整备份。
- `DATA_DIR/payment.key`：加密历史支付配置/结算数据快照，必须与数据库匹配。
- `DATA_DIR/upstream.key`：使用页面保存上游配置时的配套加密密钥；环境托管模式不据此要求创建一个新密钥。
- `DATA_DIR/setup.secret`：尚未初始化时的一次性令牌；管理员创建后被消费，不是长期恢复凭据。
- `.env` 或外部配置系统：环境托管的提供方、邮件和支付配置，不能从数据卷备份中假定恢复。

当前实现使用进程内并发计数、锁和单实例核对任务。**不要将多个商户进程挂到同一数据目录来扩容**，也不要把提高并发参数当成已完成容量验收。备份、恢复及回退见[运维指南](OPERATIONS.md)。

## 浏览器代码与视觉约定

浏览器直接加载原生 ES 模块：

- `app.js`：页面入口、渲染调度和启动；路由与导航定义见 `router.js`。
- `dom.js`、`state.js`、`api.js`、`format.js`、`layout.js`：DOM、状态、同源接口、格式化和页面外框。
- `ui*.js`：共享表格、表单、对话框、弹出说明和用量图表；`view-*.js` 对应业务页面。
- `admin-workflow.js`、`payment-catalog.js`、`registration-policy.js`、`inventory-status.js`、`usage-detail.js`、`management-policy.js` 等包含前后端共享规则，修改时同时检查 Node 导入方。

样式按 `fonts.css → base.css → layout.css → components.css → pages.css` 加载。`base.css` 定义主题变量；同一媒体条件下不重复定义同一选择器，响应式规则放在所属分区末尾。

浅色「瓷」、深色「石墨」共用语义变量。颜色用于状态，按钮、选中态和图表使用墨色；品牌主色 `--brand` 只用于品牌标志。标题和大数字用衬线体，界面使用无衬线体，命令使用等宽字体。

字体自托管：Source Serif 4、思源宋体 Noto Serif SC、Instrument Sans 和 JetBrains Mono。`@font-face` 使用 `font-display: optional`。页面在露出标题前等待本次文字所需的字体；若未能及时就绪，则保持系统回退字体，避免加载过程中再切换字形。版权与 SIL Open Font License 1.1 全文在 [`fonts.css`](../public/fonts.css) 头部；它不替代整个项目的授权说明。只打包所需拉丁/中文子集，更新字体时同步样式和版权声明。

## 构建边界

[`Dockerfile`](../Dockerfile) 安装生产依赖并复制源码和静态资源；输入受 [`.dockerignore`](../.dockerignore) 白名单约束：

- 根级构建清单；`src/` 顶层 JS、SQL。
- `public/` 顶层 HTML、JS、CSS、SVG；单独批准的 `auth-mist-lake.webp`。
- `public/fonts/` 的 WOFF2 字体，其他子目录不自动纳入。

支付页面需要的 Airwallex 模块由服务端从已安装依赖提供，不是放开任意静态子目录。增加文件类型或目录时同时审查白名单、安全测试和部署产物；不把真实配置、预览数据、日志或备份加入镜像。
