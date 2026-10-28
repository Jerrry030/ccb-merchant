# 商户公开接口契约

本文仅描述商户对接所需的公开行为，不描述提供方内部实现或运维。当前对接版本为 **v5**。未知字段不得直接传播到浏览器或下游调用方。

## 身份与认证

- 商户以本站专用的服务端密钥调用 `/access/v1`，使用 `Authorization: Bearer <key>`。
- `GET /access/v1/me` 返回 `protocol_version`、`authority_id`、`user` 和 `scopes`；客户端核对版本、身份、状态及实际需要的权限。
- 资源读取使用 `resources.read`，客户管理使用 `customers.read` / `customers.write`。
- 授权、设备、用量权限分别使用 `delegation.grants.*`、`delegation.devices.*`、`delegation.usage.read`；运行请求需要 `runtime`。
- 密钥管理需要单独授权，不应默认赋予普通接入账号。访问令牌不得放入 URL、日志或浏览器持久化存储。
- 所有 ID 都是不透明标识，只在签发方与当前授权范围内有效。

## 商户调用直接提供方

| 操作 | 接口 |
| --- | --- |
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

客户创建使用稳定的 `external_id` 和 `display_name`。授权更新携带所读取的 `expected_revision`。人工账号交付携带所选 `account_lease_id` 与 `expected_account_revision`，有效期不得超过资源允许的期限。

分页、筛选和可选能力以具体接口返回及当前实现为准。参考用量和费用不是商户钱包扣款。客户端只使用已声明字段，不依赖响应中的调试字段、额外身份信息或提供方内部标识。

## 本站管理接口

`/api/admin` 仅面向本站当前管理员会话；修改操作需要同源和 CSRF 校验。不能用服务端接入密钥替代浏览器管理员会话。

- `/api/admin/inventory`：库存与本站客户显示信息。
- `/api/admin/grants`：选择本站客户和账号进行交付；更新已有授权需提交版本。
- `/api/admin/connection`：接入状态与已验证身份，不回显接入密钥。
- `/api/admin/upstream`：`verify` 或 `save`，使用地址、新输入的密钥和配置版本。
- `/api/admin/mail`：独立邮件配置；未保存测试不改变正式配置。
- `/api/admin/payment`：独立支付配置；启用渠道、前台方式和交易规则分别校验。

本站登录、客户管理与财务记录不要求客户访问提供方的管理系统。

## 运行请求

受支持客户端连接本站公开地址。当前仅开放 Code；其他界面不因转发存在而自动可用。

- `/bridge/v1/device/*`、`/bridge/v1/accounts`、`/bridge/v1/bindings` 提供客户端连接与授权操作。
- `/bridge/v1/messages`、`/bridge/v1/messages/count_tokens`、`/bridge/v1/models`、`/bridge/v1/traffic` 仅接受实现中允许的方法、参数和目标。
- 设备 bearer 与站点服务密钥不同。服务间转发使用本站上游密钥作为 `X-CCB-Access-Key`，不继续传播调用方的服务密钥。
- 商户转发到配置的固定提供方，不开放任意 URL 代理。保留目标策略、体积限制、并发限制、超时和断线取消。
- 成功模型响应可流式返回；请求失败不会触发自动重放。不能将“不记录正文”解释为服务运营者无法读取经过进程的内容。

客户端专用载荷由受支持客户端生成。商户业务文档不规定供应商认证、账号访问或专属响应加工方式。

## 支付与未知结果

- 金额使用币种的整数最小单位；订单创建后保留其金额和配置快照。
- 浏览器支付回跳只触发查询，不直接标记收款。通知必须验签，并由服务端核验订单、商户身份、金额、币种和收款状态。
- 收款确认、账号交付和退款是不同状态，不能互相推断。仅未交付订单在取消确认后才可能退回本站钱包；不承诺原路退款或自动退还已交付服务。
- 超时、连接中断和部分服务端错误可能代表结果未知。使用原客户、账号版本或订单标识核对，不创建另一笔请求来“重试”。
- `400/401/403/404/409/429` 等明确拒绝按接口处理；版本冲突应重新读取后由调用方确认，不能盲目覆盖。

## 变更边界

对外契约变更必须同时更新调用方和回归测试，不保留重复入口或只为旧调用方式存在的转发兼容层。仅移除内部文档，不代表本次修改了上述运行行为。


## 设备管理与用量筛选

设备页现为独立导航入口。管理员从“客户管理 → 管理设备”进入，使用本站 `/api/admin/users/:id/devices`，其中 `id` 是本站用户 ID；服务端解析其提供方客户映射，浏览器不能指定其他提供方客户。

本站个人与管理端使用同一套校验：读取设备返回 `devices/accounts`；设备子路径 `PATCH` 修改 `{name,expected_name}`，`PUT .../selection` 提交 `{surface:"code",grant_id,expected_selection_version}`，`DELETE` 撤销。`grant_id:null` 清空所选账号但保留登录，成功变更返回 `{device}`。版本冲突显示 `device_stale`，不自动取新版本覆盖；未知结果关闭编辑并刷新核对。管理员变更会写本站审计，提供方响应前后重新检查权限。

对直接提供方和 API 客户，设备修改使用公开的 `/access/v1/customers/:id/devices/:device_id` 与 `/selection`；设备、客户、授权 ID 逐跳映射。设备选择的嵌套响应同样建立映射，不再依赖额外的首次状态轮询。本站 API 客户的设备名称留在本站，不将经营资料传播给更上游。Desktop 仍未开放。

本站 `/api/me/usage` 与管理员 `/api/admin/users/:id/usage` 支持时间、分页、`device_id/grant_id/model/result/session_id/view`。`result` 为 `success/error`，`view` 为 `requests/sessions`。提供方返回的 `timeline` 必须是完整筛选范围的聚合，不能使用本页数据替代；缺少聚合时页面明确显示不可用。图表展示返回的实际范围和 UTC 分桶，未知 Token 与已知用量区分。调用下级接口时筛选 ID 同样先校验归属再映射，不泄露更上游 ID。
