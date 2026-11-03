# 商户公开接口契约

[文档索引](README.md) · [架构](ARCHITECTURE.md) · [账号交付](ACCOUNT-ALLOCATION.md)

本文描述商户对接所需的公开行为，不描述提供方内部实现或运维。只维护当前接口，不用历史协议代号保留兼容分支；未知字段不得直接传播到浏览器或下游。

## 接口面与认证

同名路径出现在不同站点时，不代表能力、身份或错误格式完全相同。

| 接口面 | 请求方与目标 | 认证及边界 |
| --- | --- | --- |
| 直接提供方 `/access/v1` | 本商户服务端 → 固定提供方 | 本站上游密钥；核对提供方身份及 scope |
| 本站 `/api` | 浏览器 → 本商户 | 本站会话；修改校验同源与 CSRF；公开配置、初始化和通知各有独立规则 |
| 本站 `/access/v1` | 获授权的下级服务端 → 本商户 | 本站签发的 API 密钥；拒绝浏览器 Origin、Cookie 和 Sec-Fetch-Site |
| 本站 `/bridge/v1` | Code 客户端或获授权的下级服务端 → 本商户 | 设备 bearer 与适用的服务接入认证；不接受浏览器 Origin |

## 兼容范围与验证依据

| 对象 | 当前要求或支持范围 | 验证边界 |
| --- | --- | --- |
| 直接提供方 | 身份、权限、资源/账号、客户、授权、设备及用量满足下文契约；运行请求另需 `runtime` | [上游回归](../tests/server/upstream.test.js)和合成夹具不是某个真实提供方版本的兼容认证 |
| 本站浏览器 | 与同一部署提供的 `/api` 配合使用 | 以对应服务端/浏览器回归为依据，不将另一站点的管理 API 直接替代 |
| 下级 API 客户 | 本站公开能力子集及本地 ID | 见[接入回归](../tests/server/access.test.js)，不默认获得提供方的全部接口 |
| Code 客户端 | 设备连接、账号选择与允许的运行路由 | [运行回归](../tests/server/runtime.test.js)不代替实际安装版本验收 |
| Desktop 等其他界面 | 当前未开放 | 不能因存在通用转发代码就宣布支持 |

本文不列未经验证的提供方/客户端版本。接入验收记录必须包含本站提交或镜像、直接提供方版本/能力声明、实际客户端版本、场景及未覆盖项；格式见[发布清单](RELEASE-CHECKLIST.md)。上游项目同名、文档相似或使用最新版都不构成兼容证明。

## 商户调用直接提供方

### 身份与权限

- 商户以本站专用的服务端密钥调用 `/access/v1`，使用 `Authorization: Bearer <key>`。
- `GET /access/v1/me` 返回 `authority_id`、`user` 和 `scopes`；客户端核对直接提供方身份、状态及实际需要的权限。
- 资源读取使用 `resources.read`，客户管理使用 `customers.read` / `customers.write`。
- 授权、设备、用量权限分别使用 `delegation.grants.*`、`delegation.devices.*`、`delegation.usage.read`；运行请求需要 `runtime`。
- 密钥管理需要单独授权，不应默认赋予普通接入账号。访问令牌不得放入 URL、日志或浏览器持久化存储。
- 所有 ID 都是不透明标识，只在签发方与当前授权范围内有效。

### 提供方操作

| 操作 | 接口 |
| --- | --- |
| 读取接入环境 | `GET /access/v1/account-intake` |
| 发起/查询/取消授权 | `PUT/GET/DELETE /access/v1/account-authorizations/:id` |
| 提交回调 | `POST /access/v1/account-authorizations/:id/complete` |
| 查询授权任务 | `GET /access/v1/account-authorizations` |
| 管理自有账号 | `GET /access/v1/managed-accounts`，`GET/PATCH/DELETE /access/v1/managed-accounts/:id` |
| 具体账号库存 | `GET /access/v1/accounts` |
| 读取获授权资源 | `GET /access/v1/resources` |
| 读取获分配账号 | `GET /access/v1/accounts` |
| 查询、创建客户 | `GET /access/v1/customers`、`POST /access/v1/customers` |
| 更新客户 | `PATCH /access/v1/customers/:id` |
| 查询、创建授权 | `GET /access/v1/grants`、`POST /access/v1/grants` |
| 更新、撤销授权 | `PATCH /access/v1/grants/:id` |
| 按订单交付或取消 | `PUT /access/v1/fulfillments/:order_id` |
| 查询客户设备 | `GET /access/v1/customers/:id/devices` |
| 预览、确认设备连接 | `POST /access/v1/customers/:id/devices/preview`、`POST /access/v1/customers/:id/devices/approve` |
| 撤销设备 | `DELETE /access/v1/customers/:id/devices/:device_id` |
| 查询参考用量 | `GET /access/v1/customers/:id/usage` |

上游创建客户/手工交付时发送稳定的 `Idempotency-Key`，请求重放不能重新执行业务；本站服务保留并核对自己的原始意图。客户创建使用稳定的 `external_id` 和 `display_name`。授权更新携带所读取的 `expected_revision`。人工账号交付携带所选 `account_lease_id` 与 `expected_account_revision`，有效期不得超过资源允许的期限。

分页、筛选和可选能力以具体接口返回及当前实现为准。参考用量和费用不是商户钱包扣款。客户端只使用已声明字段，不依赖响应中的调试字段、额外身份信息或提供方内部标识。

### 分页、幂等与错误解析

提供方集合使用 `limit/cursor`，响应须包含字符串 `next_cursor`；无后续页时为空字符串。本站上游客户端跟随游标，在自己的界面需要时转换本地分页，不把本站浏览器的 `offset` 原样发送上游。分页中途失败、游标异常或超过预算均显式失败，不返回伪完整集合。

提供方业务错误按顶层 `code` 解析，并经过安全映射后返回本站调用方，不透传任意上游正文。本站出站创建请求使用稳定的 `Idempotency-Key`；幂等回执仍须核对当前状态，历史接受不代表当前授权仍有效。这不意味着本站下级入站实现了相同的通用幂等头协议。

## 本站浏览器接口

`GET /api/public` 返回公开站点设置、功能开关和 `setup_required`，不验证真实上游可用性。`POST /api/setup` 只允许服务看到的直连回环来源和本地 Host，且一次性令牌未消费；操作方式见[部署指南](DEPLOYMENT.md)。

`GET /api/auth/session` 返回当前用户与 `csrf_token`；已登录的修改请求需在 `X-CSRF-Token` 中携带该值，同时满足同源校验。不得把浏览器会话或 CSRF 令牌传给提供方。

### 管理与服务配置

`/api/admin` 仅面向本站当前管理员会话；修改操作需要同源和 CSRF 校验。不能用服务端接入密钥替代浏览器管理员会话。

- `/api/admin/inventory`：库存与本站客户显示信息。
- `/api/admin/grants`：选择本站客户和账号进行交付；更新已有授权需提交版本。
- `/api/admin/connection`：接入状态与已验证身份，不回显接入密钥。
- `/api/admin/upstream`：`verify` 或 `save`，使用地址、新输入的密钥和配置版本。
- `/api/admin/mail`：独立邮件配置；未保存测试不改变正式配置。
- `/api/admin/payment`：独立支付配置；启用渠道、前台方式和交易规则分别校验。

本站登录、客户管理与财务记录不要求客户访问提供方的管理系统。

### 管理员维护

- `PATCH /api/admin/users/:id`：编辑必须带 `expected_revision`；允许名称、状态、角色、管理权限、备注、标签和受确认的邮箱纠错。未知字段拒绝。邮箱变更额外要求 `admin_password` 和 `reason`。同步核对的空 PATCH 不改变此编辑合同。
- `POST /api/admin/users/:id/credentials`：`action` 为 `reset_password/email_reset/revoke_sessions`，必须带 `expected_revision/admin_password/reason`；临时密码设置额外带 `new_password`。返回更新后的用户状态，不返回密码或重置令牌。
- `GET /api/admin/users`：支持 `limit/offset/q/status/role/tag/assignment/due`；`assignment` 为 `assigned/unassigned/sync_pending`，`due` 为 7 或 30。库存读取失败时不声称准确知道无账号客户集合。
- `GET /api/admin/inventory`：返回本店 `account_code`、公开资源 `resource_name`、占用原因 `hold_reason` 及本地订单/批次关联。`details.name` 使用本店编号，不回显提供方账号名称。
- `POST /api/admin/allocation-batches`：批次协调入口，携带 `id/action/items`。action 为 `preview/execute/reconcile/cancel`；新批次 items 为 1–100 个 `{user_id,resource_id,account_lease_id,expected_account_revision,expires_at}`。已保存批次可省略 items；提供时必须与原意图完全一致。返回 `{batch}`，每项状态必须单独读取，HTTP 成功不代表全部已分配。
- `GET /api/admin/allocation-batches`：`id` 可选；支持 `limit/offset`，返回批次列表与总数。读取不会执行分配。

单条交付入口与批次协调共同使用同一交付实现，不另写一套分配规则；批次的持久化、逐项调度和只读核对是其独立职责。

公开用户会话包含临时密码强制变更标志和管理权限配置；内部备注/标签只在管理接口返回。密码变更前除会话读取、改密、退出外的浏览器 API 返回 `password_change_required`。

### 设备管理与用量筛选

个人导航公开「我的设备」入口，使用卡片展示设备名、平台、所选 Code 账号、最近活动和授权到期时间。已授权不代表实时在线，不根据最近活动推断在线/离线或固定续期天数；授权截止时间已到的设备显示已到期。连接新设备回到「开始使用」，改名、清空或切换账号、撤销连接仍使用已有个人接口。

管理端侧栏提供全局「设备」菜单，同时保留客户内部的设备分区。客户内管理使用本站 `/api/admin/users/:id/devices`，其中 `id` 是本站用户 ID；服务端解析其提供方客户映射，浏览器不能指定其他提供方客户。全局列表只聚合本站已映射客户，不枚举下级 API 客户或无本地归属的设备。

`GET /api/admin/devices` 支持 `q/status/limit/offset`：`q` 搜索设备名、设备 ID、平台、账号显示名、客户姓名或邮箱；`status` 为 `approved/pending/expired/revoked/cancelled/unknown`，其中过期状态按实际授权截止时间判定。默认每页 50、最大 200，筛选后分页，结果按本站用户 ID 和设备 ID 稳定排序。每台设备携带 `user_id/customer_name/customer_email/customer_status`，归属标识必须与设备 ID 一起使用。

全局读取最多并行处理 4 位客户；单次扫描预算为 500 个客户映射、10000 台设备，全局读取最多 15 秒，超时取消未完成的上游请求并停止开始新客户读取。超出容量返回 `device_read_limit`，可进入客户范围继续核对，不默默截断为完整列表。同步待确认或读取失败的客户列入 `unavailable_customers`，`incomplete=true`、`total=null`，`matched_total` 仅指已读取部分的匹配数量。身份失效或管理权限丢失则整个请求失败。所有修改仍走已有客户范围内的接口，全局列表没有无归属的写入入口；只读角色仍不可修改。

本站个人与单客户管理端使用同一套校验：读取设备返回 `devices/accounts`；设备子路径 `PATCH` 修改 `{name,expected_name}`，`PUT .../selection` 提交 `{surface:"code",grant_id,expected_selection_version}`，`DELETE` 撤销。`grant_id:null` 清空所选账号但保留登录，成功变更返回 `{device}`。版本冲突显示 `device_stale`，不自动取新版本覆盖；未知结果关闭编辑并刷新核对。管理员变更会写本站审计，提供方响应前后重新检查权限。

对直接提供方和 API 客户，设备修改使用公开的 `/access/v1/customers/:id/devices/:device_id` 与 `/selection`；设备、客户、授权 ID 逐跳映射。设备选择的嵌套响应同样建立映射，不再依赖额外的首次状态轮询。本站 API 客户的设备名称留在本站，不将经营资料传播给更上游。Desktop 仍未开放。

本站 `/api/me/usage` 与管理员 `/api/admin/users/:id/usage` 支持时间、分页、`device_id/grant_id/model/result/session_id/view`。`result` 为 `success/error`，`view` 为 `requests/sessions`。提供方返回的 `timeline` 必须是完整筛选范围的聚合，不能使用本页数据替代；缺少聚合且筛选范围内已有记录时，页面明确显示不可用；没有提供方客户映射时返回空用量和 total=0，不把它当成版本冲突。已有映射时，待确认的资料变更不阻止读取；映射在读取期间变化仍返回冲突。图表展示返回的实际范围和 UTC 分桶，未知 Token 与已知用量区分。调用下级接口时筛选 ID 同样先校验归属再映射，不泄露更上游 ID。

### 当前账号与回收记录

个人账号页、首页账号摘要和设备页的账号选项按当前客户授权确定归属，不直接展示提供方返回的全部历史卡片。已撤销、待确认、不属于当前客户或无法对应当前授权的卡片不会返回；卡片必须匹配当前授权 ID，双方提供的账号租约 ID 也必须一致。额度耗尽、临时不可用或到期提示不等于回收：授权仍在的账号保留其原有状态，不能仅按卡片是否可用来判断归属。

账号读取核对完整分页的当前授权；授权读取失败或元数据无效时明确报错，首页标记授权不可用，不以历史卡片或无账号提示替代。本站对外客户账号接口也实时核对提供方授权，再应用本地授权、资源状态和期限约束，不依赖先访问授权列表来发现提供方回收。

资源撤销、移除或过期后，其套餐退出客户目录；管理端保留本地套餐记录但不计为可售库存。资源期限和账号期限都必须覆盖购买或续期的完整时长，下单时重新校验，不能凭旧目录开始收款。重新获授权后可复用保留的本地套餐，不重写零售价或历史订单。

管理端库存历史、授权记录、订单、审计、用量以及已撤销的设备和密钥记录不因此删除；保留记录不代表仍可使用或重新分配。

## 本站提供给下级的 API

本站公开的是本地能力子集：身份、资源、客户、共享组授权、履约、客户账号、设备和用量。实现见 [`src/access.js`](../src/access.js)。不能把提供方的库存或子密钥管理能力视为本地也存在；例如，本站的客户账号读取不是顶层 `/access/v1/accounts` 库存接口。

密钥仅在服务端通过 `Authorization: Bearer <本站签发的密钥>` 使用，权限以 `/access/v1/me` 返回为准。每次读取/修改都验证本地归属，转发前后重新验证权限；不能把更上游 ID 当作本站 ID。

### 读取示例

下面只示意协议形状，不包含可用凭据。`limit` 对普通集合默认为 100，允许 1–500；游标绑定 API 客户、路径及筛选，不能跨查询复用，不接受 `offset`。

```http
GET /access/v1/resources?limit=20 HTTP/1.1
Host: merchant.example.com
Authorization: Bearer <本站签发的密钥>
Accept: application/json
```

当该 API 客户没有获分配资源时，返回形状为：

```json
{
  "resources": [],
  "limit": 20,
  "next_cursor": ""
}
```

空集合是成功读取的结果；身份失效或读取失败返回错误，不能替换成空集合。取得非空 `next_cursor` 时保留原筛选继续读取；用量查询的 `requests/sessions` 和聚合规则单独处理，不能当作通用库存分页。

### 写入与核对

- 创建客户使用稳定的 `external_id` 与 `display_name`；相同业务标识不能为了绕过未知结果而换一个值。
- 更新客户或授权使用所读取的 `expected_revision`；设备改名使用 `expected_name`，选择账号使用 `expected_selection_version`。
- 履约使用原 `order_id` 和原始意图；不能把 HTTP 超时直接解释为未执行。
- 本站没有通用的入站 `Idempotency-Key` 回执保证。调用方应遵循对应操作的业务标识、修订号和核对流程，而不是把出站提供方契约机械复制过来。

例如清空已读取设备的账号选择，请求正文为（修订号必须换成实际读取值）：

```json
{
  "surface": "code",
  "grant_id": null,
  "expected_selection_version": 4
}
```

该正文用于 `PUT /access/v1/customers/:id/devices/:device_id/selection`，成功返回 `{device}`；清空选择保留设备登录，不自动撤销其他设备。

## 本站错误格式

当前本站由 HTTP 服务产生的普通 JSON 错误使用 `application/json`，代码位于 `error.code`，说明位于 `error.message`。例如缺少下级接入凭据时：

```json
{
  "error": {
    "code": "access_key_required",
    "message": "One credential is required."
  }
}
```

**本站目前不承诺 `application/problem+json`、顶层 `code` 或统一 `request_id`。** 不要把提供方的错误合同套在本站响应上。运行响应已发送头部后发生中断时可能直接关闭连接，不能要求尾部再有上述 JSON；支付渠道通知使用该渠道约定的响应。

| 情况 | 调用方处理 |
| --- | --- |
| `400` 输入/分页问题 | 校验字段、枚举和游标，不盲目重放 |
| `401` 无效身份 | 检查当前凭据或重新登录，不借用其他身份 |
| `403` 权限、来源或 CSRF | 检查对应接口面的认证，不能放宽服务器校验 |
| `404` 不存在或不属于当前范围 | 核对本地归属，不尝试枚举上游标识 |
| `409` 修订冲突或原意图冲突 | 重新读取，由操作者确认后提交新意图 |
| `429` 频率或认证并发限制 | 降低请求频率，不据此推定交易状态 |
| `503` 不可用、并发限制或结果未知 | 根据安全错误代码区分；写操作先核对原意图，不自动创建替代请求 |

不是每个上游状态码都原样返回；错误映射以 [`src/upstream.js`](../src/upstream.js) 和本站路由实现为准。
## 运行请求

受支持客户端连接本站公开地址。当前仅开放 Code；其他界面不因转发存在而自动可用。

- `/bridge/v1/device/*`、`/bridge/v1/accounts`、`/bridge/v1/bindings` 提供客户端连接与授权操作。
- `/bridge/v1/messages`、`/bridge/v1/messages/count_tokens`、`/bridge/v1/models`、`/bridge/v1/traffic` 仅接受实现中允许的方法、参数和目标。
- 设备 bearer 与站点服务密钥不同。服务间转发使用本站上游密钥作为 `X-CCB-Access-Key`，不继续传播调用方的服务密钥。
- 商户转发到配置的固定提供方，不开放任意 URL 代理。保留目标策略、体积限制、并发限制、超时和断线取消。
- 成功模型响应可流式返回；请求失败不会触发自动重放。不能将“不记录正文”解释为服务运营者无法读取经过进程的内容。

客户端专用载荷由受支持客户端生成。商户业务文档不规定供应商认证、账号访问或专属响应加工方式。

## 多级部署决策与实现边界

2026-11-01 选定逐级服务模式。客户终端连接末级站点，每个站点只连接自己的固定直接提供方，运行请求依次经过所有中间站点。不得因为提供方拒绝、超时或不可用而跳级、改连最终提供方、自动换账号或重放模型请求；不规划绕过中间站点的运行旁路。

各站独立验证直接调用方、映射客户/授权/设备 ID，并换用本站服务密钥向上请求。下级长期密钥不向上继续传播，不收集整条密钥链；设备令牌仍与服务密钥分开处理。各站客户名称、邮箱、售价和账本不作为跨层身份依据。

**已存在的运行转发不等于完整多级账号业务已开放。** 托管额度、环境、期限策略已实现；商户自带账号的授权托管、稳定资产归属、具体账号库存逐级转授及相应恢复任务仍待实现，不能用现有客户授权或 API 密钥签发来代替。后续增加能力时同步替换负责实现、实际调用方、测试和当前合同，不保留单级/多级两套协议。

目标业务边界是：自带账号只向提供方托管，不因经过上级而变成上级可转售库存；资产来源、托管服务期限和客户使用授权分别管理。账号占用或来源未确认时不得显示可分配。停用服务路径不转移下级资产归属，密钥轮换不改变已确认映射。更换提供方必须显式迁移，不能删除已有绑定来绕过身份核对。

`tests/server/multi-hop-runtime.test.js` 是本模式的离线运行基线：同一测试进程内启动三个真实 Merchant HTTP 服务，各自使用隔离 SQLite，最终提供方为合成服务。覆盖相邻 ID 映射、逐跳服务密钥、载荷/SSE 保持、越级拒绝、上层拒绝不绕行、流中撤销、断线取消和中间服务关闭重建后的映射恢复。服务重建不等于操作系统进程崩溃恢复验收；它不证明真实提供方、供应商账号授权或具体账号逐级库存已经验收。

## 支付与未知结果

- 金额使用币种的整数最小单位；订单创建后保留其金额和配置快照。
- 浏览器支付回跳只触发查询，不直接标记收款。通知必须验签，并由服务端核验订单、商户身份、金额、币种和收款状态。
- 收款确认、账号交付和退款是不同状态，不能互相推断。仅未交付订单在取消确认后才可能退回本站钱包；不承诺原路退款或自动退还已交付服务。
- 超时、连接中断和部分服务端错误可能代表结果未知。使用原客户、账号版本或订单标识核对，不创建另一笔请求来“重试”。
- `400/401/403/404/409/429` 等明确拒绝按接口处理；版本冲突应重新读取后由调用方确认，不能盲目覆盖。

## 变更约束

对外契约变更必须同时更新调用方和回归测试，不保留重复入口或只为旧调用方式存在的转发兼容层。上游调用和响应投影须与当前身份、错误、幂等和分页合同一致。上游集合中途失败或超过读取预算会显式报错，不返回伪完整结果。


## 自有账号接入与具体交付

本站只调用直接提供方；下层业务与本站管理入口复用同一个账号接入实现。读取需要 `managed_accounts.read`，写入需要 `managed_accounts.write`；不自动扩展现存密钥。

- 管理入口为「库存 → 管理自有账号」；会话/CSRF 保护下使用 `/api/admin/account-intake`、`/api/admin/account-authorizations[/id[/complete]]`、`/api/admin/managed-accounts[/id]`。没有额度或独立托管到期表单。
- 先生成稳定 UUID，以 PUT 提交新接入 `{name,environment_id,platform}`，或重新授权 `{managed_account_id,expected_revision}`。发送前保存无秘密意图及上游操作 ID；未知结果查原 ID，不能新造操作或重新兑换回调。
- complete 使用 POST `{callback_url}`。回调只即时转交，不保存至 SQLite、审计、队列或浏览器持久化存储。`auth_url` 只在待授权的实时单项读取中返回，不进入本地快照。列表最多展示最近 100 项；单个 ID 可长期核对。
- 阶段为 `pending/queued/exchanging/provisioning/success/error/review/cancelled/expired`。结果未知明确展示 review；只在真实提供方回执确认后宣告成功。已发布任务不能伪称取消，要从资产执行退出。
- 商户 API 每跳验证 `X-CCB-Origin`，用“认证直接账户 + 收到的来源”生成本站上游命名空间。没有此头时为该直接客户的空来源；本站自己的操作使用独立来源。`X-CCB-Access-Hops` 为 0–8 工作预算，耗尽拒绝，不改为直达最终提供方。两头不透传到模型流量。
- 源头资源可以逐级转交，但上级普通库存不能出售下级自有账号。托管账号、资源、客户、具体占用和修订分别映射；不信任浏览器 owner 或直接复用上游对象 ID。
- GET accounts 返回 `source`，仅 `owned` 且 `expires_at=null` 表示无固定持有期限。上级供给和历史未知期限保持原有限/待核对语义。客户交付必须填写未来的明确日期。
- POST grants 支持 `account_lease_id,expected_account_revision`，记录原始上游具体占用、修订及客户意图。回执按“客户 + 资源 + 具体占用”核对，不按资源任选账号；一个客户可拥有多个不同账号。未知和已撤销结果不自动恢复，不静默改派。
- PATCH managed-accounts 提交 `{expected_revision,status:"paused"|"active"}`，DELETE 带 `{expected_revision}`。暂停保留客户合同，恢复后需重新选择设备；退出停止托管并保留历史，不声称供应商侧远程授权已撤销。

运行仍经过全部直接提供方。技术预算、真实占用、设备限制和权限保持；没有商业托管名额。更换直接提供方、跨来源转让以及真实供应商验收另行安排。

## ACCB 公共下载清单

同源静态 `GET /accb-releases.json` 返回 `product: "ACCB"`、版本、来源提交和文件列表；每项只包含固定 target、精确文件名、字节大小和 SHA-256。当前 target 仅为 `windows-x64-setup`、`mac-arm64`、`mac-x64`、`linux-x64`；已撤销的 Windows 便携目标 `win-x64` 不被接受。前端只构造 `/downloads/accb/{version}/{name}` 同源地址，不接受远端 URL。空清单不产生下载链接；坏版本、非法文件名、重复 target 和无效校验值整份拒绝。此分发没有账号/API Key 副作用，不属于 `/bridge/v1/*` 运行时协议；包文件由 Caddy 提供，不经过模型代理。

## 条件切号能力与逐级转发

`GET /bridge/v1/accounts` 只保留直接上级实际返回的布尔 `conditional_selection`，不由本站强制设为 true；中间任一层未实现该合同，客户端不能据此开启自动切号。`POST /bridge/v1/device/account` 仅接受非空 `grant_id` 和必填非负安全整数 `expected_selection_version`。本站及每级 Merchant 只映射相邻授权 ID，必须原样传递观察到的修订号，不读取新版本替换旧请求、不去掉前置条件，也不自动重放。

Core 的 409 `device_stale`、`account_unavailable`、`account_device_limit`、`grant_stale` 以固定安全说明转发；内部诊断和上级账号身份不透传。401、其他状态或未确认响应不应伪装为已确认的账号不可用。该能力只表示服务端条件写入合同，不能代替客户端进程树和连接清理证明。
