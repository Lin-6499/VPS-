# RayGate / XrayManagement

本地优先的多 VPS 设备凭证与历史流量管理工具。Node.js 后端通过 SSH 读取 Xray，MySQL 保存设备、独立节点 UUID、状态和历史流量。页面：<http://127.0.0.1:8787>。

## 启动

需要 Node.js 22、MySQL 8.0.16+ 或 8.4、OpenSSH。将 `.env.example` 中的数据库参数填入项目根目录 `.env`（不要提交密码）。

```powershell
cd D:\XrayManagement
npm install
npm run db:migrate
npm run db:import
npm run admin:create -- --username admin
npm start
```

## 登录与公网访问

RayGate 使用单一管理员账号、MySQL 会话和 CSRF 校验保护全部管理页面、API 与二维码。首次启动前必须在本机交互式终端创建管理员；密码只保存为带随机盐的 scrypt 哈希，输入过程不会回显。

```powershell
npm run admin:create -- --username admin
npm run admin:reset-password -- --username admin
```

如果终端无法交互输入密码，可在数据库尚无管理员时启动服务，打开控制台输出的“首次设置管理员”一次性链接，在浏览器中完成创建。创建成功后链接立即失效。

本地测试时将 `PUBLIC_ORIGIN` 设置为 `http://127.0.0.1:8787`。公网部署时应用仍应只监听 `127.0.0.1`，由同机 HTTPS 反向代理转发，并把 `PUBLIC_ORIGIN` 改为完整 HTTPS 域名；此时登录 Cookie 自动启用 `Secure`。只有同机反向代理场景才设置 `TRUST_PROXY=loopback`。

默认登录会话最长 12 小时；勾选“记住我”后为 7 天。账户菜单支持修改密码、查看最近安全记录、注销其他会话和退出登录。登录与安全审计保留 90 天，不记录密码、Cookie 或 CSRF Token。

建表文件：`sql/001_initial.sql`，共 11 张业务表。重复建表和导入均幂等。首次只初始化既有 8443 测试服务，不把正式 443 服务加入写入管理。`data/registry.json` 只用于合并原来的名称和备注，正常运行时不再写入它；迁移后可保留该文件作为备份。

VPS 资料扩展由 `sql/002_vps_resources.sql` 提供，运行 `npm run db:migrate` 时逐列检查并补齐，支持重复运行及部分升级恢复：`memory_gb`（内存，GB，保留两位小数）、`system_disk_gb`（系统盘，GB）、`traffic_quota_gb`（套餐流量额度，GB）、`official_url`（VPS 服务商官方链接）。四项默认 NULL，不用虚拟值填充已有 VPS。GB 按十进制单位理解；旧 `memory_mib` 按 MiB × 1048576 ÷ 1000000000 换算、四舍五入到两位小数后移除，空值保留，重复执行不会再次换算，有冲突则停止并保留旧列。套餐额度不等于已用流量，也不触发限流或自动重置，本次仅扩展表结构，不增加表单/API 写入功能。

## 数据与刷新

VPS 卡片的“更多操作 → 配置 KiwiVM”可填写 VEID 和 API Key。保存时后端立即调用 KiwiVM `getServiceInfo` 验证凭证并更新已用流量、套餐额度、计费倍率和下次重置时间；之后后台每 15 分钟自动同步，也可点击“立即同步流量”。API Key 仅保存为 `storage/provider-secrets` 受控文件，数据库只保存相对引用，列表和详情接口只返回“已配置”布尔值，不返回密钥或路径。`sql/005_kiwivm_bandwidth.sql` 保存同步状态和最近成功时间。

“手动校准流量”保留为 API 故障时的兜底：录入的是当前计费周期总量（非追加量），不会修改 Xray 设备流量历史；若 KiwiVM 仍处于启用状态，下次成功同步会覆盖手动快照。停用 KiwiVM 会删除本机保存的 API Key，但保留最后一份流量数值供展示。

VPS 卡片网络信息行的“管理节点”会打开 `/nodes.html?serverId=<VPS ID>`。节点页按 VPS 分组显示已接入服务和节点；“查看设备”再携带 `serverId` 与 `nodeId` 打开设备页，概览、健康状态和设备列表使用同一筛选条件。

`sql/006_node_management.sql` 保存服务诊断、节点最近发现与存在状态，以及流量/在线能力是否可用。远端配置中消失的节点标记为“配置中未发现”，但不会删除凭证或历史数据。

- 后台每 60 秒通过 SSH 采集；浏览器每 30 秒读取数据库，不触发额外 SSH。手动刷新会触发一次采集。关闭页面不停止后端采集，但关闭 Node 进程或本机休眠会停止采集。
- 字节数使用 BIGINT，API 返回十进制字符串，展示单位为 GiB；统计日界为 Asia/Shanghai，数据库日期时间为 UTC。
- 首次采集建立基线，不把接入前流量归入当天。已经保存的累计和日汇总不会因 Xray 重启而清零。
- 明细和采集任务保留 30 天；日汇总长期保留；月报由日汇总生成。跨日分配按采样时间比例估算；采样间隔超过 180 秒或计数重置会标记缺口。
- 采集中断期间若 Xray 重启，最后一次采样到重启之间的未采集字节无法恢复。不同实例串行保护、最多两个实例同时 SSH，重复采样不会重复累计。
- 在线指标是来源 IP 数，不是物理设备数或会话数。采集失败不写入假零值；状态过期显示未知。
- 配置期望启停、实际启停、同步状态分别存储。新建和启停先入库任务，再备份、校验、原子保存配置，通过 HandlerService 动态增删用户；日常操作不重启服务。配置与运行时用户均核对成功后才更新开关。SSH 结果不确定时显示“正在核实”并幂等重试，阻止重复提交。
- 首次配置 HandlerService 需要管理员批准一次服务重启；日常路径无重启回退。API 仅监听 VPS 回环地址。停用阻止新认证，已有连接可能继续到结束，不承诺立即踢下线。远端配置和运行时无法组成同一事务；若配置已保存但 API 失败，保持待核实并自动收敛，不假报成功。
- SSH 私钥只存文件引用，REALITY 私钥不进入数据库。二维码和 VLESS 链接动态生成，不落图片表。

## API

- `GET /api/servers`、`GET /api/instances?serverId=...`、`GET /api/nodes?serverId=...&instanceId=...`。
- `POST /api/servers/:id/discover-xray`：通过已确认的 SSH 主机指纹只读发现 systemd Xray 服务；返回后台任务 ID。
- `POST /api/servers/:id/preflight-xray`：读取指定配置并检测 StatsService、活跃 IP 和 HandlerService 能力；不修改远端。
- `POST /api/servers/:id/connect-xray`：接入前再次预检，导入受支持节点与凭证；新服务始终默认只读。
- `GET /api/xray-jobs/:id`：查询发现、预检、接入和重新诊断任务进度。
- `POST /api/instances/:id/diagnose`、`PATCH /api/instances/:id`：重新诊断；能力完整时可切换 `allowWrite`。该开关仅控制设备凭证管理，不控制 Xray 服务启停。
- `PATCH /api/nodes/:id`：修改本地显示名称，不修改远端 inbound tag。
- `PATCH /api/servers/:id/traffic-usage`：JSON `{ "usedGb": "111.88" }`，替换服务商已用流量快照并返回更新后的 `server`；输入须为 0–999999999999.99 GB，最多两位小数。
- `PUT /api/servers/:id/kiwivm`：JSON `{ "veid": "123456", "apiKey": "..." }`，验证并启用 KiwiVM；后续更改 VEID 时 `apiKey` 可留空以复用已保存密钥。
- `POST /api/servers/:id/sync-bandwidth`：立即同步该 VPS 的 KiwiVM 套餐流量；同步失败保留上次成功数值并记录错误。
- `DELETE /api/servers/:id/kiwivm`：停用自动同步并删除本机保存的 API Key。
- `GET /api/devices?serverId=...&nodeId=...&query=...&status=...&page=1&pageSize=50`：按设备分页，每条包含 `credentials`。
- `GET /api/credentials/:id`、`/traffic`、`/qrcode`；旧 UUID 查询 `GET /api/devices/:uuid` 仍可用。
- `GET /api/devices/:deviceId/traffic?from=YYYY-MM-DD&to=YYYY-MM-DD&groupBy=day|month`：设备所有节点汇总。凭证流量接口接受相同参数；`totals` 是长期累计，`rangeTotals` 是所选范围。
- `POST /api/devices`：JSON `{name,note,nodeId,deviceId?}`；给已有设备加节点时传 `deviceId`。返回 202 和 `operationId`。
- `PATCH /api/credentials/:id/enabled`：JSON `{enabled:true|false}`。
- 两个远端写操作均支持 UUID 格式的 `Idempotency-Key` 请求头；重试同一个逻辑操作必须复用该值。
- `GET /api/operations/:id`：`pending/running/uncertain/success/failed`。只有 `success` 表示核对生效；失败后可以针对同一凭证重新提交启用任务，无须生成新 UUID。
- `PATCH /api/devices/:deviceId`：JSON `{name,note}`，仅更改资料，不修改 Xray email。
- `POST /api/refresh`：JSON `{instanceId?}`，执行采集。

新增 VPS 与已有 Xray 接入均可在页面完成：先上传 SSH 私钥并确认主机指纹，再进入“节点管理”执行发现、能力预检和接入。首版完整支持 VLESS + TCP/RAW + REALITY；配置目录或其他协议会显示不支持原因。缺少 StatsService、在线统计策略、用户 email 或 HandlerService 时只读导入，不显示虚假零值，也不能开启设备管理。每个实例的 email、全局 UUID 必须唯一；跨节点重复 UUID 会停止导入并报告冲突。

本版本仍绑定 `127.0.0.1`，没有部署到公网，也没有加入登录或账户权限系统。

## 验证

```powershell
npm run check
npm test
npm run test:mysql
```

`test:mysql` 创建随机命名的 `raygate_test_*` 临时库，使用假的 SSH 传输测试真实 MySQL 事务、接口、跨 VPS 关联及任务处理，最后删除该临时库，不写入 `raygate` 业务数据或真实 VPS。运行账户需具有临时建库/删库权限。

生产库应通过常规 MySQL 备份保存；`.env`、SSH 私钥文件及配置备份按其原有访问权限单独保管。
