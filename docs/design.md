# pi-better-subagents 设计文档

版本: v0.1 (2026-09-17)
状态: 已确认基线,进入实现

## 1. 背景与目标

pi (`@earendil-works/pi-coding-agent`) 刻意不内置 subagent、后台 bash、监控等能力(见 usage.md),由扩展提供。本仓库实现一个独立的 pi 扩展 + 进程管理 daemon,提供四个能力:

1. **subagents** — 多个并行或顺序执行,同步等待带 foreground budget,超时自动转异步
2. **monitoring** — 可创建监控任务(命令行事件流),事件主动注入
3. **bash 自动后台化** — 前台预算到期自动转后台,不卡死等候,完成主动通知
4. **agent 间通讯协作** — 父子 subagent 间的 ask/reply/send(进程内 mailbox)

### 已确认的决策

| 决策点 | 结论 |
|---|---|
| 编排表达 | 工具参数风格: `tasks[]` 并行 + `chain[]` 顺序插值(lain 风格) |
| 包定位 | 全新独立包。不兼容 pi-subagents;跨 session/跨机器通讯归 agent-intercom(独立体系),本包不做 |
| 同步策略 | 智能 budget 模式: 默认同步等待,foreground budget 到期自动转异步(grok 风格) |
| 子代理进程模型 | v1 全部进程内 `createAgentSession`;执行层抽象 `ChildRunner` 接缝,未来可加 detached 后端 |
| 进程管理 | 独立 Rust binary `pbs-manager`,全机单例,约定路径,session_id 命名空间隔离 |
| manager 生命周期 | **与 pi 进程共存亡**: 活跃连接归零 → 杀掉剩余任务 → 退出。需要时经 lock 启动。不自我复活,spawn 权只在客户端 |
| manager 语言 | Rust (tokio + clap + serde_json + interprocess + fd-lock) |

### 研究来源(结论已内化,实现时不依赖)

- **lain** (本地 TS): foreground budget 15s 自动后台、durable inbox 通知、ordinal 保序、fail_fast 只停未启动、子代理 shell 禁后台(waitUntilExit)、ask 统一 request_id
- **claude-code 2.1.201**: 超时转后台而非杀死、`<task-notification>` user-role 注入、Monitor 工具(200ms 合批/单行500/批3000)、裸 sleep 拦截、stall watchdog 10min、发消息即 resume
- **grok-build** (Rust): 单写者 coordinator actor、ChildRunner host 接缝、前台预算 45s、准入排队不拒绝、monitor=文件 tail+限流、steer/queue/interject 三态投递
- **pi-subagents 0.68** (反面教材): 23k 行的教训——detached runner 证据链、pruned-fork 摘要、workflowScript VM、双通讯通道,全部不抄
- **pi-intercom 0.12.1** (已废弃): 仅借鉴 daemon 单例 spawn 流程与 idle/busy 注入模式;其全局单 ask 锁、僵尸生命周期为反面教材

## 2. 总体架构

```
pi 实例 A (session a) ──┐
pi 实例 B (session b) ──┼── 约定路径 socket ──►  pbs-manager (Rust, 全机单例)
pi 实例 C (session c) ──┘                        ├─ 进程引擎: spawn/wait/stop/output
                                                 ├─ session_id 命名空间
    pi 扩展 (TS, 进程内)                          ├─ 输出双写(内存截断 + 磁盘全量)
    ├─ bash 覆盖 ────► manager client ───────────┤─ 事件推送 (task_started/exited/output)
    ├─ monitor 工具 ──► start + watch 输出流       └─ 生命周期: 连接归零 → 清算退出
    ├─ task_list/output/stop
    ├─ subagent 工具 ──► ChildRunner 接缝 (v1: InProcessRunner)
    ├─ comms ──► 进程内 mailbox (contact_supervisor / agent_message)
    └─ NotifyCenter ──► 唯一注入出口 (triggerTurn/steer)
```

**分层铁律**: manager 只管进程与输出管道,无任何 LLM/会话语义;所有语义(预算、限流、截断、注入、通讯)在扩展侧。

## 3. pbs-manager (Rust)

### 3.1 单例与启动

约定路径(Unix; Windows 用 named pipe `\\.\pipe\pi-better-subagents`)。**基准目录可被环境变量 `PBS_HOME` 覆盖**(测试与多实例调试必须;CLI 另支持 `--home <dir>` 全局 flag,优先级: flag > env > 默认):

```
~/.pi/agent/pbs/
├── manager.sock          # unix domain socket
├── manager.pid           # {pid, version, started_at} JSON
├── manager.lock          # daemon 生命周期锁(flock,daemon 存活期间一直持有)
├── manager.spawn.lock    # 客户端 spawn 锁(fd-lock 占用即有效)
├── manager.log           # manager 自身日志
├── config.json           # 可选用户配置
└── sessions/<session_id>/tasks/<task_id>.json    # 任务状态
                                └─ <task_id>.output   # 全量 stdout+stderr 合并流
```

启动流程(客户端侧,即扩展或 CLI):

1. 连接 socket;成功 → `hello` 握手,版本兼容即用
2. 失败 → 抢 `manager.spawn.lock`(fd-lock,非阻塞 trylock)
3. 抢到 → spawn `pbs-manager daemon`(detached)→ 轮询等 socket 就绪(2s 超时)→ 释放锁
4. 没抢到 → 说明别人正在 spawn,轮询等 socket 就绪
5. socket 存在但连不上(僵尸 socket)→ 同 2–4:spawn 一个 daemon,由它清理。**客户端从不删除 socket/pid 文件**(否则可能删掉另一个客户端刚 spawn 出的 daemon 的 socket)
6. `hello` 被拒且是 manager 正在 graceful shutdown(§3.2)→ 等它退出,再走 2–4。精确协议(Rust CLI `client::connect` 即此实现,测试 `d8`/`d8b`):
   - 识别:对 `hello` 的响应为 `{"ok":false,"error":{"code":"E_INTERNAL","message":"manager is shutting down"}}`(`id` 为该 hello 的 id),随后 manager 关闭该连接。以 `code == "E_INTERNAL"` 且 `message == "manager is shutting down"` 精确匹配;其他 `E_INTERNAL` 不适用本步骤。该响应立即返回(shutdown 期间 manager 仍 accept),不会等到 hello 超时
   - 等待:读 `manager.pid` 的 `pid`,每 50ms 以 `kill(pid, 0)` 探测,直到进程不存在或累计 5s(graceful shutdown 最多 2s kill grace + 收尾)。读不到 pid 文件则不等。等待期间不删任何文件、不重连旧连接
   - 之后:走 2–4(抢 spawn 锁 → spawn → 等 socket 2s),再连接 + `hello` 一次;仍失败才向上报错。5s 到了旧 manager 仍在时也照此继续:新 spawn 的 daemon 拿不到 `manager.lock` 会以 "already running" 退出,本次连接按普通失败处理

`manager.pid` 与 socket 所有权: daemon 身份 = 持有 `manager.lock` 的独占 flock,从启动持有到退出(崩溃时由 OS 释放;fd 为 CLOEXEC,任务进程不继承)。daemon 启动时 trylock:失败 → 已有 daemon,打印 "already running" 退出码 0;成功 → 此时 socket/pid 文件必然陈旧,删除后 bind 并写 pid。不以 pid 存活判断身份(pid 可能被无关进程复用)。`doctor` 同理:只在拿到锁时清理陈旧文件。

### 3.2 生命周期(反僵尸硬语义)

- 每个扩展连接在 `hello` 时注册 `{session_id, pi_pid}`;该连接即此 session 的控制通道
- 连接断开(unix socket 下进程死亡必然触发,含 kill -9)→ 该 session 标记 disconnected
- **活跃连接数归零持续 5s → graceful shutdown**:
  1. 对所有 running 任务发 SIGTERM(进程组);leader 已退出但进程组仍有成员(后台子进程)的任务也包括在内
  2. 2s grace → 对仍可能有成员的**进程组**发 SIGKILL(即使 leader 已死,忽略 SIGTERM 的子孙也会被杀)
  3. 任务状态落盘标记 `killed`(reason: "manager_shutdown")
  4. 删除 socket/pid 文件,退出
- shutdown 期间 manager 仍接受新连接,但立即拒绝其 `hello`(`E_INTERNAL` "manager is shutting down");客户端按 §3.1 第 6 步等该 manager 退出后 spawn 继任者,而不是卡到响应超时
- 后台任务不允许比最后一个 pi 活得久。`pi --resume` 的 reattach 只在"还有其他 pi 活着"时成立
- manager **永不自我复活**;只有客户端(扩展/CLI)在需要时 spawn
- **manager 是所有任务的父进程,它以任何方式结束,任务都随之清理(lifeline)**:每个任务由 `pbs-manager __run <command>`(runner)作为进程组 leader 启动,runner 再在同一进程组里 exec `sh -c <command>`。runner 在 fd 3 持有 lifeline:一条只有 daemon 持有写端的 pipe 的读端。daemon 无论怎样结束(`shutdown`、`kill -9`、panic),内核都会关闭写端,runner 读到 EOF → 对自己的进程组 SIGTERM → 2s → SIGKILL。**没有崩溃恢复**:新 daemon 启动时不接管任何任务(见 §3.4)。
  - runner 在 fd 4 通过状态 pipe 上报命令的真实退出码/信号(`exit <code> <alone|linger>` 或 `signal <n> <alone|linger>`)。若命令留下了后台子进程(`cmd &`),runner 留下来当守护者(guardian),继续持有 lifeline,直到进程组只剩它自己;daemon 以"收到状态"为任务结束,以"runner 退出"为进程组已空。
  - runner 屏蔽 SIGTERM(子进程在 exec 前解除屏蔽),所以 stop/shutdown 的组 SIGTERM 只作用于命令,runner 能上报命令是怎么结束的;runner 自身只被 SIGKILL 带走,此时 daemon 退回用 runner 的 wait 状态。
  - lifeline 写端只有一个持有者(`task::lifeline()`,CLOEXEC),方便后续原地 exec 交接只处理一个 fd。
- **原地升级(exec 交接,对运行中的工作透明)**:替换二进制后,daemon `exec()` 新二进制,**pid 不变**,所有 runner 仍是它的子进程(`waitpid` 照常,退出码真实),任务不中断、不需要用户判断"现在能不能升级"。
  - 触发:`pbs-manager upgrade`;或 daemon 每 2s 检查自身可执行文件(dev/inode/size/mtime),文件变化且再稳定一个周期后自动升级(`trigger: "binary-changed"`)。安装仍用 `install`(新 inode,macOS 签名缓存)。
  - 步骤:① preflight:运行 `<新二进制> __handover-check`,必须回答同一交接格式版本;不兼容/损坏的二进制在此止步,什么都不动(换同一文件前不再重试)。② quiesce:各任务的输出泵只在两次读之间停下、退出等待挂起,fanout 推完已读内容,关闭所有客户端连接并让写端 flush;上限 quiesce 5s + flush 2s,超时则放弃升级、旧映像恢复。③ 写 `<home>/handover.json`(版本化:任务记录、kill 请求/原因、**绝对**超时截止与 kill grace 截止、守护者状态、各 fd 号),对要继承的 fd 清 CLOEXEC,exec。④ exec 失败:fd 恢复 CLOEXEC、任务继续、结果记入 `status.last_upgrade`,旧映像照常服务。
  - 跨 exec 继承的 fd:监听 socket(**不重新 bind**,交接中的新连接在 backlog 里等,不会被拒)、`manager.lock`、lifeline 两端(写端若关闭所有任务都会被清理)、每个任务的 stdout/stderr/状态 pipe 读端。
  - 新映像以 `daemon --handover <file>` 恢复;恢复失败即退出,lifeline 断开,所有任务被清理——与崩溃同一语义(无崩溃恢复,不做抢救)。
  - 恢复后先有 **30s 交接宽限期**(`handover-grace`),期间不适用"零连接 5s 关机",等客户端重连。
  - 客户端可见的断连窗口实测 30–46 ms(并行测试负载下);交接中在途请求**得不到响应**,连接直接关闭,客户端重连 + 重新 hello 后重发:幂等请求(wait/output/list/watch/status/stop/mark_background)直接重发,`start` 以同一个 `key` 重发(见 §3.3)。
  - 会话在交接前的 watch 在重新 hello 时自动恢复,并补发它漏掉的输出区间 `[交接前已送达的 cursor, 当前)`,不缺不重。
  - `status` 增加 `generation`(本 pid 经历的原地升级次数)与 `last_upgrade`(`at, ok, from_version, to_version?, error?, trigger: "cli"|"binary-changed"`)。
- **已断开 session 的保留期**:session 断开后立即从 `ls` / `sessions` 消失;`sessions/<sid>/` 在最后一次写入后保留 `goneSessionRetention`(config.json,默认 24h),期间 `show` / `agent` / `events` 仍可查(事后排查、`pi --resume`),到期由 daemon 删除目录并从内存移除其任务。启动时与每 `min(保留期, 1h)` 清扫一次;已连接、或仍有 running 任务/存活进程组的 session 永不清扫

### 3.3 传输与协议

- 帧: `u32 BE length + UTF-8 JSON payload`,最大帧 4 MiB
- 扩展: 每会话一条长连接(请求/响应/事件复用); CLI: 短连接,单请求-响应后关闭
- 请求: `{"v":1, "id":"<uuid>", "type":"...", ...}`(**所有请求含 hello 都带 v+id**;下文示例为简洁省略 v/id)
- 响应: `{"v":1, "id":"<uuid>", "ok":true, ...}` 或 `{"v":1, "id":"...", "ok":false, "error":{"code":"E_*","message":"..."}}`
- 事件(服务端推送,无 id): `{"v":1, "type":"event", "event":"...", ...}`

**版本兼容(N−1,原地升级的前提)**:升级后,仍在运行的 pi 里加载的是旧扩展,会立刻以旧协议重连。规则:
- 帧版本 `v` 固定为 1,仅它不匹配才回 `E_VERSION`;hello 里的 `protocol` 级别只作信息,旧级别照常接受。
- 新字段一律可选(`#[serde(default)]`),旧客户端不发即取默认;新增请求/事件不得改变已有请求/事件的语义。
- 测试守住:交接后用旧协议 hello 连接仍可正常工作。

**输出游标契约**:输出事件的 `next_cursor` 与 `output` 请求的 `cursor`/`next_cursor` 是同一个**单调递增的字节偏移**(合并输出 `.output` 内)。一个输出事件覆盖 `[next_cursor − bytes(chunk), next_cursor)`。块边界 UTF-8 安全(事件会扣住不完整的尾部字节,交接时一并带过)。在末尾调用 `output` 返回空 chunk 且 `next_cursor == cursor`(已追平)。客户端据此对自身的 `output(cursor)` 补读与交接后的补发按字节范围去重/裁剪。

**`start` 幂等**:`start` 可带可选的 `key`(客户端生成);同一会话内以同一 key 重发返回第一次启动的任务,不会再启动一次;key 跨原地升级保留。

**补充裁决(2026-09-17)**:
- `kind:"shell"` 的命令经 shell 解释: unix 用 `env.SHELL -c`(env 未给 SHELL 则 `/bin/sh -c`);Windows 用 `cmd /c`
- `start` 省略 `env` → 子进程继承 manager 自身环境(扩展侧总是显式传完整 env)
- `stop` 响应 = 信号已发送(SIGTERM→2s→SIGKILL 流程开始);状态翻转以 `task_exited` 事件为准;killed 任务的 `task_exited` 带 `exit_code:null, signal:"SIGTERM"|"SIGKILL"`
- CLI 输出为人类可读表格(不作契约);`shutdown` 成功退出码 0

#### 消息定义

**hello** — 连接后第一个消息,必须是它:
```json
→ {"type":"hello", "client_kind":"extension", "session_id":"<pi session id>", "pi_pid":1234, "cwd":"/path",
   "extension_version":"0.3.0", "protocol":2}
→ {"type":"hello", "client_kind":"cli"}
← {"ok":true, "version":"0.1.0", "pid":4321, "started_at":1726...}
```
- `extension` 必须带 `session_id` + `pi_pid`;此后该连接接收此 session 的事件
- `cwd` 可选(向后兼容)。扩展在 hello 里带上 session cwd;manager 存入 session 并在 status/sessions 里返回。旧客户端省略该字段仍可握手
- `extension_version`(字符串)、`protocol`(整数)可选:manager 按 session 存储,在 `status` 的 sessions 里返回,`doctor` 据此检查每个已连接 session 的协议与 manager 一致。`protocol` 为特性级别:1 = 原始 §3.3,2 = 可观测性契约(origin / mark_background / stop.reason / end_reason / events.jsonl)。缺省 = 旧扩展
- 同一 `session_id` 重复 hello: 新连接赢,旧连接收到 `{"type":"event","event":"session_rebound"}` 后由服务端关闭
- `cli` 不带 session;可访问跨 session 的只读/管理操作

**start** — 启动进程:
```json
→ {"type":"start", "kind":"shell"|"monitor", "command":"...", "cwd":"...",
   "env":{...}, "run_in_background":false, "timeout_ms":null,
   "origin":{"via":"child-bash", "child_id":"ch_…", "run_id":"run_…"}}
← {"ok":true, "task_id":"sh_a1b2c3d4", "pid":5678}
```
- `session_id` 从连接绑定取
- `env` 为子进程**完整环境**(客户端负责构造;扩展侧传 `process.env` + `PI_*` 注入)
- `timeout_ms`: 硬 kill 上限;`null` = 无限制(后台任务默认)
- `run_in_background:true` 仅语义标记(客户端不再 wait);manager 行为相同
- `origin` 可选,记录谁发起:`via` 为 `"bash-fg"`(前台 bash,可能随后被转后台) | `"bash-bg"` | `"child-bash"`(子代理的 bash,带 `child_id`/`run_id`) | `"monitor"`;manager 原样存入 TaskRecord(新值不会导致 start 失败)
- task_id 格式: `<kind 前缀>_<8位hex>`;前缀 `sh`(shell) / `mon`(monitor) / 未来 `ag`(agent)

**wait** — 等待退出(预算内):
```json
→ {"type":"wait", "task_id":"sh_a1b2c3d4", "budget_ms":20000}
← {"ok":true, "done":true, "exit_code":0}
← {"ok":true, "done":false}                  // 预算到期,任务继续跑
```

**output** — 增量读输出:
```json
→ {"type":"output", "task_id":"sh_a1b2c3d4", "cursor":0, "max_bytes":65536}
← {"ok":true, "chunk":"...utf8-lossy...", "next_cursor":12345, "status":"running",
   "exit_code":null, "total_size":23456}
```
- cursor 是字节偏移;`next_cursor` 供下次增量读
- chunk 为 UTF-8 lossy 字符串;v1 不支持二进制保真
- chunk 边界永不切断 UTF-8 字符:切点回退到字符边界,不会为合法文本产生 U+FFFD,也不会跳过字节(`next_cursor` 指向第一个未发送字节)。末尾不完整的序列在任务仍在运行时暂缓发送。若首个字符本身超过 `max_bytes`,整字符发出(chunk 最多超出 3 字节);`max_bytes:0` 返回空 chunk
- chunk 经 JSON 转义后的大小受帧上限约束(控制字符转义为 6 字节),响应不会超过 4 MiB;任何放不进一帧的响应改为 `E_INTERNAL` 错误,连接保持可用
- `watch` 的 `output` 事件同样遵守字符边界

**mark_background** — 扩展把任务转入后台时通知 manager(前台预算用尽或 run_in_background):
```json
→ {"type":"mark_background", "task_id":"sh_a1b2c3d4"}
← {"ok":true}
```
manager 在 TaskRecord 记录 `backgrounded_at`(ms);只记第一次;任务已结束则为空操作。

**stop**:
```json
→ {"type":"stop", "task_id":"sh_a1b2c3d4", "reason":"tui"|"cli"|"tool"|"timeout"|"rate-limit"|"session-end"}
← {"ok":true}
```
`reason` 可选(缺省视为 `"tool"`,兼容旧扩展),未知值 → `E_BAD_REQUEST`。CLI `stop` 发送 `"cli"`。
SIGTERM 进程组 → 2s → SIGKILL(发给进程组,leader 已退出也照发)。终态 `killed`。对已终止但仍有后台子进程残留的任务,`stop` 同样清理其进程组,状态不变。

**end_reason**(TaskRecord 与 `task_exited` 事件):任务为何结束,取值之一
`exited`(自然退出,任意退出码) | `timeout` | `stopped:tui` | `stopped:cli` | `stopped:tool` | `rate-limit` | `session-end` | `manager-shutdown` | `manager-crash`。
映射:stop 带 reason X → `stopped:X`,但 timeout / rate-limit / session-end 映射为自身;`timeout_ms` 到期 → `timeout`;`shutdown_session` → `session-end`;manager 优雅关闭 → `manager-shutdown`;manager 未经关闭就死掉(kill -9、panic),下一个 daemon 启动时把仍为 running 的记录标为 `orphaned` → `manager-crash`。多个原因先到先得(stop 之后的关闭不覆盖 `stopped:cli`)。

`signal` 字段(`task_exited` 事件与 TaskRecord)为信号名字符串,如 `"SIGTERM"` / `"SIGKILL"`;正常退出为 `null`。旧版本写入的数字仍可读取(按名称转换)。

**list**:
```json
→ {"type":"list", "all":false}
← {"ok":true, "tasks":[{...TaskRecord}]}
```
- extension 连接: 仅本 session; cli 连接: `all:true` 或显式 `session_id` 可看全部

**watch / unwatch** — 订阅某任务的输出流事件:
```json
→ {"type":"watch", "task_id":"mon_x"}
← {"ok":true}
// 之后服务端推送:
← {"type":"event", "event":"output", "task_id":"mon_x", "chunk":"...", "next_cursor":100}
```

**shutdown_session** — 停掉本 session 全部任务:
```json
→ {"type":"shutdown_session"}
← {"ok":true, "stopped":["sh_a","mon_b"]}
```

**status**(只读,cli 与 extension 均可):
```json
→ {"type":"status"}
← {"ok":true, "version":"0.1.0", "pid":4321, "uptime_ms":3600000, "protocol":2,
   "sessions":[{"session_id":"...","pi_pid":1234,"connected":true,"cwd":"/path",
                "extension_version":"0.3.0","protocol":2,"connected_at":1726...,"last_seen":1726...}],
   "task_counts":{"running":2,"terminal":5}}
```
`protocol` 为 manager 的协议级别;`connected_at` = 本 manager 首次见到该 session 的 hello(重连保持不变);`last_seen` = 最近一次请求或断开(连接中为当前时间)。

**shutdown** (cli): 触发与"连接归零"相同的 graceful shutdown。

#### 事件

| event | 字段 | 推送条件 |
|---|---|---|
| `task_started` | task_id, kind, command, pid, ts | 始终(推给 owning session) |
| `output` | task_id, chunk, next_cursor | 仅 watch 后 |
| `task_exited` | task_id, exit_code, signal, duration_ms, output_path, output_size, ts, end_reason | 始终 |
| `session_rebound` | — | 被替换的旧连接 |

#### 事件日志(events.jsonl)

- 文件:`<home>/sessions/<session_id>/events.jsonl`,只追加,一行一个 JSON 对象;无 session 的 daemon 事件写 `<home>/events.jsonl`
- 每行 < 4 KiB(含换行):超长的字符串字段被截断(以 `…` 结尾)并加 `"truncated":true`;`src`/`type`/`ts` 不截断。每行用一次 O_APPEND `write` 写入,manager 与扩展并发追加也不会交错
- 公共字段:`ts`(ms)、`src`(`"manager"` | `"extension"`)、`type`、`id?`(task/child id),加类型字段
- manager 写:`session.connect {pi_pid, cwd, extension_version, protocol}`、`session.disconnect {reason: closed|rebound}`、`task.start {kind, command(≤200 字符), origin, pid}`、`task.background {after_ms}`、`task.stop {reason}`、`task.exit {exit_code, signal, end_reason, duration_ms}`(含 orphaned 与关闭时强制结束的任务)、`daemon.start {pid, version, protocol, readopted, orphaned, loaded}` / `daemon.shutdown {pid, killed_tasks}`(也写 manager.log)
- 扩展写:`wake.emit {kind, ids[], batch}`、`wake.deliver {kind, mode: trigger|steer}`、`wake.dedupe {id}`、`monitor.drop {id, lines}`、`monitor.stop {id, reason}`、`agent.start {child_id, run_id, name, agent, model}`、`agent.settle {child_id, status, error?, duration_ms}`、`agent.stall {child_id}`、`agent.timeout {child_id}`、`decision.request/reply/timeout {child_id}`
- 读者(CLI `events`/`show`/`sessions`)跳过无法解析、或缺 `ts`/`type` 的行
- 保留:随 session 目录存放,v1 不轮转(deferred: rotation | impact: 超长 session 磁盘增长 | trigger: doctor 报告 sessions 目录 > 100MB)

#### Agent 记录(扩展所有,`<home>/sessions/<sid>/agents/`)

- `<ch>.json`:`{child_id, run_id, session_id, name, agent, model?, status, started_at, ended_at?, error?, end_reason?(completed|failed|model-error|stalled|timeout|interrupted|disposed), prompt_head(仅任务 prompt,不含 agent preamble,≤2000), result_tail(≤2000), tool_calls, transcript}`
- `<ch>.jsonl` transcript:每条消息一行 `{role, text, tool?, args?, isError?, ts}`,实时追加
- CLI 只读这些文件(`ls`/`show`/`agent`/`log`);记录显示 running 但所属 session 未连接时,CLI 视为 `interrupted`,`doctor` 报为陈旧记录

#### 错误码

`E_NOT_FOUND` / `E_BAD_REQUEST` / `E_VERSION` / `E_SESSION_REQUIRED` / `E_FORBIDDEN`(cli 越权) / `E_INTERNAL`

### 3.4 任务模型与状态机

```
running ──exit 0──► completed
       ──exit≠0──► failed
       ──stop────► killed
       ──manager 崩溃(下次启动时标记)──► orphaned
```

- TaskRecord(磁盘 `<task_id>.json`): `{task_id, session_id, kind, command, cwd, pid, status, exit_code, signal, started_at, ended_at, output_path, output_size, origin?, backgrounded_at?, end_reason?}`(后三项为可观测性契约新增,可选,旧记录照常加载)
- 输出: 内存 ring buffer(64KB)+ 磁盘全量追加;`output_size` 单调增
- **崩溃后启动(无崩溃恢复)**: 读 state dir。仍为 running 的记录属于一个未经关闭就死掉的 daemon,它的 runner 已经看到 lifeline 断开并清理了进程组(§3.2),没有可接管的东西:记录标为 `orphaned`(`end_reason:"manager-crash"`,`ended_at` 设为启动时刻)并落盘,`output_size` 从文件长度恢复。**不向旧记录里的 pid/pgid 发任何信号**(pid 可能已被复用)。

### 3.5 CLI(inspection 管理,用户侧)

单 binary,`pbs-manager <subcommand>`;除 `daemon` 外都是客户端。完整手册见 `docs/cli.md`。

```
pbs-manager daemon [--foreground]        # 前台运行(被 spawn 时用)
pbs-manager status [--json]              # 版本/协议/uptime/sessions/任务与 agent 计数;不启动 daemon
pbs-manager sessions [--json]            # 已连接的会话(断开但仍有运行中任务的也列出)
pbs-manager ls [--session P] [--cwd D] [--since DUR] [--json]   # 已连接会话的全部工作 + 任何仍在运行的
pbs-manager show <id> [--json]           # sh_/mon_/ch_/run_ 任意 id,模糊匹配
pbs-manager agent <ch_id> [--full] [-f]  # 渲染 agent transcript
pbs-manager events [-f] [--session P] [--id X] [--since DUR] [--json]
pbs-manager log|tail [ID]                # manager.log / 任务输出 / agent transcript
pbs-manager output|wait|stop <id>        # stop 对 agent 报错(子代理在 pi 进程内)
pbs-manager kill-session <session_id>
pbs-manager doctor                       # 健康检查;任何 FAIL → 退出码 1
pbs-manager shutdown
```

### 3.6 Rust 结构

```
manager/
├── Cargo.toml
└── src/
    ├── main.rs       # clap 分发: daemon | 客户端子命令
    ├── daemon.rs     # listener、accept loop、连接注册、归零 shutdown
    ├── proto.rs      # 帧 codec + 消息 serde 类型
    ├── task.rs       # spawn(经 runner、进程组)、lifeline、输出 tee
    ├── runner.rs     # `__run`:任务进程组 leader,lifeline、状态上报、残留子进程守护
    ├── sys.rs        # 唯一生产 unsafe 缝: setsid(pre_exec) + kill(pgid)/liveness
    ├── registry.rs   # task registry + session 命名空间 + 磁盘持久化
    ├── lifecycle.rs  # spawn lock、pid claim、崩溃后启动扫描(标记 orphaned)
    ├── client.rs     # CLI: 连接/spawn 流程、作用于 daemon 的命令、log/tail、doctor
    ├── inspect.rs    # CLI: status/sessions/ls/show/agent/events 与数据层
    ├── events.rs     # events.jsonl 写(manager)与读(CLI)
    ├── fmt.rs        # 显示宽度(CJK)、时长、本地时间
    └── out.rs        # 管道关闭时静默退出 0 的 stdout
```

依赖: tokio(full), clap(derive), serde + serde_json, interprocess(跨平台 socket), fd-lock(spawn lock), libc(仅经 `sys.rs` 封装进程组)。Windows 进程组用 Job Object(v1 可先 `taskkill /T`)。

**内存边界(§3.4 加固)**:
- 内存 ring 硬上限 64KB(`RING_CAPACITY`);全量只落盘 `.output`
- tee→fanout 使用有界 mpsc(`CHUNK_CHANNEL_CAP=64`,约 ≤512KB 在途),避免慢 watch 撑爆进程
- 连接 map / session 随连接增减;任务条目在终态后仍保留供 list/output(不无限增长于运行中 tee)
- 活跃连接归零 → 杀任务 → 清 socket/pid 后退出(§3.2)

## 4. pi 扩展 (TypeScript)

目录: `extension/`,`package.json` 声明 `"pi": {"extensions": ["./src/index.ts"]}`。

### 4.1 manager client (`src/manager-client.ts`)

- `connect()`: §3.1 启动流程 → hello(session_id=pi session id, pi_pid=process.pid)
- 请求/响应多路复用(id → Promise map);事件回调注册(`onEvent`)
- 断线: 指数退避重连(0.5s/1s/2s,最多 3 次),重连后重新 hello;**彻底失败则 bash 回退到 pi 内置本地执行**(降级不挂)
- `session_shutdown` → `shutdown_session` → 关闭连接

### 4.2 bash 覆盖 (`src/bash-override.ts`)

用 `createBashToolDefinition(cwd)` 拿 schema/renderer,自实现 execute:

```
schema: { command: string, timeout?: number(秒,硬 kill 上限), run_in_background?: boolean }

execute:
  manager.start({kind:"shell", command, cwd, env: process.env + PI_* 注入, timeout_ms})
  run_in_background → 立即返回后台通知
  否则 wait(foregroundBudgetMs, 默认 20000, config 可配):
    done → output 全量读 → 尾部截断(2000 行 / 50KB,同内置) → {content, details:{truncation, fullOutputPath}}
    超时 → 返回一行后台状态: `⏵ sh_x running in background · /tasks`
      (no instructions or duplicate output path in transcript)
      details: {backgrounded:true, task_id, fullOutputPath}; no-poll/end-turn guidance stays model-facing in tool guidelines
```

- `details` 保持 `BashToolDetails` 兼容(truncation/fullOutputPath),扩展字段加在 details 上
- **裸 sleep 拦截**: `^\s*(sleep\s+\d|while true|until ...)` 类模式 → 返回错误,建议 `monitor` 工具或 `run_in_background`
- **子代理内的 bash**(M3): 变体注册,禁自动后台(budget=0 语义,超时直接 kill 报错)——lain 的 waitUntilExit 教训

### 4.3 task_* 工具 (`src/task-tools.ts`)

- `task_list({all?})` → manager list **合并**进程内 subagent children(扩展 registry + `sessions/<sid>/agents/*.json`);`pbs-manager ls` 同步读该落盘记录
- `task_output({task_id, cursor?, max_bytes?})` → manager output;返回尾部 + 文件指针
- `task_stop({task_id})` → manager stop

### 4.4 monitor 工具 (`src/monitor.ts`)

```
monitor({ command, description, timeout_ms = 300000 (min 1000, max 3600000),
          persistent = false })
```

- `manager.start({kind:"monitor", run_in_background:true})` + `watch(task_id)`
- 扩展侧行处理(纯函数,便于测试):
  - `LineBatcher`: chunk → `\n` 切分 → 200ms 合批;单行 cap 500 字符,单批 cap 3000 字符
  - `RateLimiter`: token bucket(容量 10,每 2s +1);过去 30s 内至少 10 个批次且丢弃比例 ≥50% → 自动 stop + 通知
- 事件注入: `<pbs-wake kind="monitor">`(见 §4.5);idle→triggerTurn,busy→steer;busy 期间按 monitor 合并并在 `agent_settled` 后发送,携带 `event-count` 与 `dropped-lines`
- 进程退出 → 结束通知;timeout 到期 → stop + "[Monitor timed out — re-arm if needed.]"
- `persistent:true` → 活到 session 结束(无 timeout)
- 所有时间源与定时器由 extension scope 注入的 `Clock` 驱动,包括批处理、限速与 timeout;测试用 `ManualClock`,不替换全局 fake timers
- prompt 文案(防误用): 命令必须 line-buffered;"silence is not success"(grep 要覆盖失败特征);事件不是用户回复;不要 poll

### 4.5 NotifyCenter (`src/notify.ts`)

所有异步事件的唯一注入出口:

```ts
notify({ customType, content, details }): void
// idle → pi.sendMessage(msg, {triggerTurn:true})
// busy → pi.sendMessage(msg, {deliverAs:"steer"})
```

- 200ms 合批窗口: 多条 task_exited 合并为**一个** `<pbs-wake kind="task">`,内含多个 `<task>`
- 去重: 同一 task 同一事件只发一次
- 所有异步注入共用一个 `customType`: `pbs-wake`。不再发送 `pbs-task-notification` / `pbs-monitor-event` / `pbs-subagent-notification` / `pbs-supervisor-message`。旧 renderer 已删除;旧 transcript 走 pi 默认 custom message。
- Lead-in 只有一句,导出为 `PBS_WAKE_LEAD_IN`:

```ts
export const PBS_WAKE_LEAD_IN =
  "System wake — not a new user message. Handle this <pbs-wake> before other work.";
```

  content = lead-in + 空行 + 一个 `<pbs-wake>`。lead-in 换成 `""` 后仍是可解析的 envelope。Renderer 只读 `details.kind`,不从 XML 猜类型。Pill 的颜色/glyph 用 details 里的 status/exitCode,不用 summary 文本。

### pbs-wake 合同(eval wake adapter 以此为准)

属性 kebab-case,值 XML 转义。子元素文本一律转义(含 monitor `<event>`)。`details` camelCase,按 `kind` 区分。`still-running` 是子元素,不是属性;空则省略。item 文本是显示标题(shell: 命令压成一行并 cap 80;agent: name)。

| kind | 根属性 | 子元素 | details |
|---|---|---|---|
| `task` | (无;still-running 不是属性) | `<still-running><item id>` 可选;一个或多个 `<task id kind status duration-ms exit-code? signal?>`,内含 `summary` `command` `output-file` `preview` | `{ kind:"task"; stillRunning: {id,title}[]; tasks: [{ id, taskKind, status, summary, command, outputPath, preview, durationMs, exitCode: number\|null, signal?: string }] }` |
| `monitor` | `id` `description` `status?` | `<event>` | `{ kind:"monitor"; id; description; status?; event }` |
| `subagent-handover` | `run-id` `child-id` `name` `status` | `<still-running>` 可选;`summary` `prompt` `result`;`error` 可选 | `{ kind:"subagent-handover"; runId; childId; name; status; stillRunning: {id,title}[]; summary; prompt; result; error? }` |
| `subagent-done` | `run-id` `status` `duration-ms` | `summary`,然后每个 child 一个 `<child id name status>`,内含 `prompt`(头 cap 2000)、`error` 可选、`result`(尾 cap 2000) | `{ kind:"subagent-done"; runId; status; durationMs; summary; children: [{ childId, name, status, prompt, result, error? }] }` |
| `supervisor-request` | `from` `name` | `message`,`reply-with` | `{ kind:"supervisor-request"; from; name; message }` |
| `supervisor-update` | `from` `name` | `message` | `{ kind:"supervisor-update"; from; name; message }` |

- `exit-code` 属性在 `exitCode === null` 时省略;details 里始终是 `number | null`。`signal` 是信号名字符串(`"SIGTERM"` | `"SIGKILL"`),没有则省略,不是数字。
- `reply-with` 文本是 `agent_message { action: "reply", to: "<childId>", message: "<your decision>" }`,不写进 `message`。
- subagent-done 的 pill 显示各 status 计数,例如 `3 completed · 1 failed`。
- 行为准则是持久 section,不是 `before_agent_start` 返回的整段 systemPrompt。收到 `<pbs-wake>` 后先处理再继续,不要 poll/sleep/伪造结果。

### 4.6 subagent 工具 (M3)

模块: `src/subagent/`(types.ts / runner.ts / registry.ts / pool.ts / tool.ts / child-bash.ts / pi-runtime.ts / fleet-widget.ts)

**pi 运行时隔离铁律**: `createAgentSession` 只能在 `pi-runtime.ts` 里 **动态 import**(`await import("@earendil-works/pi-coding-agent")`),其余所有模块零运行时 pi 依赖(可 `import type`)。runner 通过注入的 `CreateSessionFn` 工厂创建子会话,测试用 fake。动态 import 失败时 subagent 工具返回明确错误文本,不影响其他工具。

**子会话构造**(pi SDK 已验证): `createAgentSession({ cwd, model?, thinkingLevel?, tools: allowlist, customTools: [contact_supervisor 等], sessionManager: SessionManager.inMemory() })`;模型解析经 `ctx.modelRegistry.find(provider, id)` / `getAvailable()`;默认 model = 父 session 当前 model(`ctx.model`)。子会话对象常驻 registry 直到 session_shutdown,因此 "resume" = 同一对象上再次 `prompt()`(v1 不做跨进程重建)。

**工具 schema**(typebox,字段名契约):

```
subagent({
  tasks?: [{ agent?: string, prompt: string, name?: string }],   // 并行, 1..10
  chain?: [{ agent?: string, prompt: string, label?: string }],  // 顺序, 强制同步执行
  async?: boolean,            // true=立即返回 run_id
  concurrency?: number,       // 1..8, 默认 4
  fail_fast?: boolean,        // 默认 false; 只停未启动的任务, 已启动的跑完
  model?: string,             // 模糊模型指定, 见下方"模型解析"; 可带 ":<thinking>" 后缀
  timeout_ms?: number,        // 单个子代理硬超时, 默认 600000, 最大 3600000
  action?: "list"|"get"|"status"|"interrupt"|"resume"|"steer"|"models",   // 管理已有 run
  run_id?: string,            // action 目标
  child_id?: string,          // steer/interrupt/resume 可精确到单个子代理
  message?: string,           // steer/resume 的内容
})
```

- `tasks` 与 `chain` 互斥,且与 `action` 互斥;三者必须居一
- 同步路径: 等待至全部完成或 **subagentBudgetMs(默认 45000, config 可配)** 到期 → 转异步,立即返回 `{ run_id, status: "backgrounded" }` + "完成时会通知你,不要 poll" 文案;完成时 NotifyCenter 注入 `<pbs-wake kind="subagent-done">`
- chain 插值: `{previous}` = 上一节点结果文本, `{outputs.<label>}` = 指定 label 节点结果;未定义 label 引用 → 立即报错不启动
- 并行: worker pool(concurrency 槽位),结果按 tasks 数组 ordinal 保序返回
- 单个子代理失败不拖垮整组: 结果数组该项标 `status:"failed", error`;fail_fast=true 时取消未启动项
- 结果文本: 每个子代理取 `session.getLastAssistantText()`;空 → "(no output)"
- 深度: 扩展记录自身 depth(主=0);子会话工具集中**不含 subagent**(depth 1 硬上限,v1 不开放更深)
- **child session isolation**: `createPiSessionFn` 显式传入 `DefaultResourceLoader({ cwd, agentDir, noExtensions:true, noSkills:true, noPromptTemplates:true, noThemes:true, noContextFiles:true })`;不加载 user/project extensions、skills、prompt templates、themes 或 context files。特别是不能加载父 extension,否则它的 session_start / before_agent_start 会把 parent wake guidelines 注入 child prompt。child 仍单独注入 `CHILD_BEHAVIOR_GUIDELINES`;没有配置开关。
- **统一时钟与 generation timer ownership**: 扩展创建一个 `Clock` 并通过依赖注入传给时间相关服务。`ManualClock` 确定性地按 deadline、再按插入顺序执行同刻 timer;`advance()` 中新产生且已到期的 timer 也会运行, callback 内清除 timer 会阻止后续执行,大跨度 interval 每个到期点只触发一次。每个 child generation 有自己的 `TimerScope`; settle、interrupt、resume 或 dispose 时清除该 scope 的所有 timeout,避免过期 generation 影响后续状态。无需 Effect-TS;试点被拒绝的原因和数据见 `docs/decisions/effect-child-runner-pilot.md`。
- 子代理 bash: `child-bash.ts` 禁后台变体——schema 无 `run_in_background`;execute 走 manager start + wait(timeout_ms 全程),到期 SIGKILL 并返回超时错误(不转后台);裸 sleep 拦截规则与主 bash 相同
- 限制: 全局并发 8(跨 run);stall watchdog——子代理 10min 无任何事件 → abort 标记 `failed (stalled)`;session 级 spawn 预算 32 个子代理/小时,超限报错
- 管理 action: `list`(本 session 全部 run + 状态), `get`(run_id → 完整结果), `status`(run_id → 每子代理状态/耗时/最后事件), `interrupt`(abort 子代理或整 run), `steer`(运行中子代理 → `session.steer(message)`), `resume`(已结束子代理 → `session.prompt(message)` 续跑, 结果完成时再通知), **`models`(列出可指定的模型, 供调用前自查)**

**模型解析**(pi 多 provider 已验证: `modelRegistry.getAvailable()` / `find(provider,id)`; 白名单 = settings `enabledModels` / `--models` → `ctx.scopedModels`):

- 候选集: `ctx.scopedModels` 非空 → 只用 scoped(尊重用户白名单);否则 `modelRegistry.getAvailable()`
- 匹配算法(纯函数 `resolveModelSpec(spec, candidates)`): ① 精确(`provider/id` 或裸 id 唯一命中) → ② 大小写不敏感的 id/显示名子串;0 命中 → 报错并列出候选;多命中 → 报错列出命中项,提示用 `provider/` 前缀消歧
- spec 可带 `:<thinking>` 后缀(如 `claude-haiku-4-5:high`),解析后覆盖 agent 定义的 thinking
- 工具参数 `model` 解析失败 → **硬错误**(列出候选, LLM 可重试);agent 定义文件里的 `model` 解析失败 → **回退父模型** + 结果 details 记 warning(用户 authored 文件跨机器可能失效,不该硬死)
- 未指定: 子代理继承父 session 当前模型(`ctx.model`)
- `action:"models"` 返回: 候选集逐行 `provider/id — 显示名`,标注 `(current)` 父模型与 `(scoped)` 白名单来源

**通知格式**(NotifyCenter 合批规则与 task_exited 相同):

完成通知是 `<pbs-wake kind="subagent-done">`,交接是 `<pbs-wake kind="subagent-handover">`。形状见 §4.5,不使用 `<subagent-notification>`。

**fleet widget**(M5 部分提前到 M3,因依赖 registry): `ui.setWidget("pbs-fleet", lines, {placement:"belowEditor"})`,仅 `ctx.hasUI` 时;内容 = 每个活跃子代理一行 `● name (agent) — 12s`,无活跃时 `undefined` 清除;更新时机: registry 任何状态迁移 + 每 5s 计时刷新(活跃时)。

### 4.7 comms (M4)

模块: `src/comms/`(mailbox.ts / tools.ts / routing.ts)。**只依赖附录 B 的 `CommsHost` 接口**,不 import subagent 实现(测试用 mock host)。

- `contact_supervisor`(注册在子会话, customTools): `{ reason: "need_decision"|"progress_update", message: string }`
  - `progress_update`: 即发即返(经 NotifyCenter 注入 `<pbs-wake kind="supervisor-update">` 通知父 agent,不阻塞)
  - `need_decision`: 阻塞子代理 tool execute,等父 agent 回复;**per-child 独立 waiter**(无全局锁——pi-intercom 教训);10min 超时返回 `"Supervisor did not respond within 10 minutes; decide yourself and continue."`;父侧收到 `<pbs-wake kind="supervisor-request">`(见 §4.5),用 `agent_message reply` 应答
- `agent_message`(父会话;子会话变体带 `from`): `{ action: "send"|"reply"|"broadcast"|"list", to?: string(child_id|name), message?: string, delivery?: "steer"|"queue"(默认 steer) }`
  - send 到运行中子代理: steer → `session.steer(message)`;queue → `session.followUp(message)`
  - send 到已结束子代理: 即 resume(`session.prompt(message)`),完成时再通知
  - reply: 解析对应 child 的 pending need_decision waiter;无 pending → 报错列出等待中的 child
  - broadcast: 同 run 全部活跃子代理 steer
  - list: 本 session 所有子代理 + 状态 + pending 请求
- 兄弟互发: 子会话的 agent_message 带 `from: childId`;routing 校验目标与来源**同 run_id**(谱系检查),跨 run 拒绝并报错
- 所有通讯写 mailbox 日志(内存环形, 每 run 200 条),`list` action 可见最近 20 条

### 4.8 agent 定义 (M5)

模块: `src/agents/`(definition.ts / loader.ts / builtins.ts)。**纯模块,零 pi 依赖**;index.ts 接线在集成期做。

markdown 文件,frontmatter(yaml 子集,手写解析,不引依赖):

```markdown
---
name: explorer
description: Fast codebase exploration — finds files, symbols, answers structure questions
tools: [read, bash, grep, find, ls]     # 或 `read, bash, grep, find, ls`; 缺省 = [read, bash, edit, write]
model: anthropic:claude-haiku-4-5       # 可选; "provider:id" 或裸 id
thinking: high                          # 可选: minimal|low|medium|high|xhigh
---

You are an explorer agent. ... (body = system prompt 追加段)
```

- 三级覆盖(后者胜): builtin → `~/.pi/agent/agents/**/*.md` → `<cwd>/.pi/agents/**/*.md`;同名覆盖,`description` 必填,`name` 须匹配 `^[a-z][a-z0-9-]*$`
- builtin 至少两个: `explorer`(只读工具集)、`worker`(全工具)
- 加载时机: session_start + 每次 subagent 工具调用前惰性 reload(mtime 缓存,解析失败的文件跳过并在 status 中报告)
- 未知名称: `subagent({agent:"xxx"})` 报错并列出可用 agent 名

### 4.9 配置

`~/.pi/agent/pbs/config.json`(扩展读):

```json
{ "foregroundBudgetMs": 20000, "subagentBudgetMs": 45000, "managerPath": null, "logLevel": "info", "goneSessionRetention": "24h" }
```

## 5. 测试策略

### Rust(`manager/tests/`,黑盒集成)

不依赖 crate 内部 API,spawn 编译好的 binary,用 std UnixStream/TcpStream 直接打帧:

- 协议: hello/start/wait/output/stop/list/watch 全消息往返
- 事件: task_exited 推送、watch 后 output 推送
- 生命周期: 连接归零 → manager 退出且任务被清算;spawn lock 单例(第二个 daemon 拒绝启动)
- 崩溃: kill -9 / panic manager → 所有任务及其子孙在 grace 内消失 → 重启后记录为 orphaned(manager-crash),不接管、不发信号
- 输出: 大输出 cursor 增量读、UTF-8 lossy

### TS(`extension/tests/`)

- 纯函数: LineBatcher(合批/cap)、RateLimiter、通知格式化、结果截断
- bash 覆盖: mock manager client(内存实现协议)验证 budget 转后台、回退路径
- NotifyCenter: 合批/去重/idle-busy 路由

### 端到端

M1 后手动: `pi -e ./extension` 跑长命令验证自动后台 + 通知 + `pbs-manager list`。

## 6. 非目标(v1 明确不做)

- 跨 session / 跨机器通讯(归 agent-intercom)
- detached subagent runner(ChildRunner 接缝预留)
- worktree 隔离、workflow 脚本沙箱、watchdog、missions
- 兼容 pi-subagents / pi-intercom
- Windows 完整支持(代码路径预留,不验证)

## 附录 A: TS 纯函数签名契约(实现与测试的共同依据)

**裁决注释(2026-09-17, 契约测试分歧后补充;同日经实现方收敛后修订)**:

- `maxLineChars` / `maxBatchChars` 是**硬上限,纯硬切,不加省略号标记**。(初版裁决要求标记计入 cap;实现与测试双方独立收敛于硬切,理由:语义最简、cap 严格。截断事实由 monitor 事件的上下文可知)
- LineBatcher 定时 flush **排空全部缓冲,含未换行残行**("窗口结束不丢数据")。(初版裁决是只发完整行;实现方收敛于 drain-at-end,对 progress bar / 慢速行场景更友好——残行立即可见而非无限持有)
- `truncateTail` 的 maxBytes 是**硬上限**: 若保留的最后一行单独超限,对该行做 UTF-8 字符边界安全的字节截尾,结果永远 ≤ maxBytes;不产生 U+FFFD 溢出
- `truncateTail` 的 `totalLines`: 原始文本行数;空串 = 0 行。截断发生时,输出首行为标记行 `… (truncated: showing last K of N lines)`
- `formatTaskNotification`: 见 §4.5。多事件合并为一个 `<pbs-wake kind="task">`;command/preview 必须 XML 转义(`& < >`);`exitCode:null` 省略 `exit-code` 属性
- `formatBackgroundNotice` 是一行任务状态 (`⏵ sh_x running in background · /tasks`); no-poll/end-turn 指引仅进入 model-facing tool guidelines
- **spawn daemon 必须显式传 `--home <resolvedHome>`**(`pbs-manager --home X daemon`),不得依赖 PBS_HOME 环境继承——调用方的 home 可能来自显式覆盖而非环境变量(2026-09-17 端到端联调发现的实际 bug)
- CLI `status` 输出汇总计数(version/pid/uptime/sessions 数/tasks 数);session 明细用 `sessions` 子命令
- monitor 的 `timeout_ms` 由**扩展侧**强制执行(传 manager `timeout_ms:null`):若由 manager 硬杀,超时通知会退化为普通 task_exited,无法产出 "[Monitor timed out — re-arm if needed.]" 文案;扩展死亡时由 manager 连接归零清算兜底
- 前台完成的命令,扩展只从 manager 拉 **512KB 尾窗**(不全量拉取);`details.truncation.totalBytes` 用 manager 报告的 `total_size`

```ts
// extension/src/monitor-batching.ts
export interface LineBatcherOptions {
  flushMs?: number;          // 合批窗口, 默认 200
  maxLineChars?: number;     // 单行 cap, 默认 500 (含截断标记的硬上限)
  maxBatchChars?: number;    // 单批 cap, 默认 3000 (同上)
  onFlush: (text: string) => void;
}
export class LineBatcher {
  constructor(opts: LineBatcherOptions);
  push(chunk: string): void;   // 喂原始输出 chunk(可能不含换行/含多行)
  flush(): void;               // 立即发出当前缓冲(含残留半行)
  dispose(): void;             // flush + 清定时器
}

export interface RateLimiterOptions {
  capacity?: number;          // 默认 10
  refillIntervalMs?: number;  // 默认 2000
  refillAmount?: number;      // 默认 1
}
export class RateLimiter {
  constructor(opts?: RateLimiterOptions);
  tryConsume(n?: number): boolean;  // 默认 n=1; 不足返回 false
  dispose(): void;
}

// extension/src/format.ts
export interface TruncationInfo { truncated: boolean; totalLines: number; totalBytes: number }
export function truncateTail(
  text: string, maxLines?: number /*默认2000*/, maxBytes?: number /*默认51200*/
): { text: string } & TruncationInfo;

export interface TaskExitInfo {
  taskId: string; kind: string; command: string;
  status: "completed" | "failed" | "killed" | "orphaned";
  exitCode: number | null; durationMs: number;
  outputPath: string; preview: string;  // preview 由调用方先截断到 4000
}
export function formatTaskNotification(events: TaskExitInfo[], stillRunning?: WakeItem[], leadIn?: string): FormattedWake;  // §4.5
export function formatBackgroundNotice(taskId: string, command: string, outputPath: string): string;
export function formatMonitorEvent(description: string, taskId: string, batchText: string, status?: string): FormattedWake;  // §4.5
```

## 附录 B: M3-M5 接口签名契约(subagent / comms / agents 三方的共同依据)

```ts
// ---------- extension/src/agents/ (M5, 纯模块, 零 pi 依赖) ----------
export interface AgentDefinition {
  name: string;                 // ^[a-z][a-z0-9-]*$
  description: string;          // 必填非空
  tools: string[];              // 缺省 ["read","bash","edit","write"]
  model?: string;               // "provider:id" | 裸 id
  thinking?: "minimal"|"low"|"medium"|"high"|"xhigh";
  systemPrompt: string;         // frontmatter body, trim 后
  source: "builtin"|"user"|"project";
  path?: string;                // builtin 无 path
}
export interface LoadReport { definitions: AgentDefinition[]; errors: { path: string; error: string }[] }
export function parseAgentMarkdown(content: string, source: AgentDefinition["source"], path?: string):
  AgentDefinition;            // 解析失败 throw Error(含原因)
export function loadAgentDefinitions(opts: { userDir: string; projectDir: string }): LoadReport;
                              // 三级合并: builtin < userDir(**/*.md) < projectDir(**/*.md), 同名后者胜
export function resolveAgent(defs: AgentDefinition[], name: string | undefined): AgentDefinition;
                              // undefined → 默认 "worker"; 未知名 → throw(消息列出可用名)

// ---------- extension/src/subagent/model-spec.ts (纯函数, 零 pi 依赖) ----------
export interface ModelCandidate { provider: string; id: string; name?: string }
export type ModelResolution =
  | { ok: true; provider: string; id: string; thinking?: string }
  | { ok: false; error: "no-match"|"ambiguous"; candidates: string[]; thinking?: string };
export function resolveModelSpec(spec: string, candidates: ModelCandidate[]): ModelResolution;
  // ① 剥 ":<thinking>" 后缀(minimal|low|medium|high|xhigh 才认, 否则当 id 一部分)
  // ② "provider/id" 精确 → 裸 id 精确唯一 → id/name 大小写不敏感子串
  // ③ 0 命中 no-match(candidates=全部), >1 命中 ambiguous(candidates=命中项)

// ---------- extension/src/subagent/types.ts (M3 核心类型) ----------
export type ChildStatus = "pending"|"running"|"completed"|"failed"|"interrupted";
export interface ChildResult {
  status: "completed"|"failed"|"interrupted";
  text: string;                 // getLastAssistantText() 或 "(no output)"
  error?: string;
  durationMs: number;
}
export interface ChildRunRequest {
  childId: string;              // 由 registry 分配: "ch_" + 8
  runId: string;                // "run_" + 8
  name: string;                 // 展示名(tasks[].name 或 agent 名或序号)
  prompt: string;               // 已插值
  agent: AgentDefinition;       // 已 resolve
  model?: string;               // subagent() 参数级覆盖
  timeoutMs: number;
  depth: number;                // 主 session = 0, 子 = 1
}
export interface ChildHandle {
  readonly childId: string;
  readonly result: Promise<ChildResult>;          // 终态 resolve 恰好一次
  steer(message: string): Promise<void>;          // 运行中; 已终态 → throw
  followUp(message: string): Promise<void>;       // 同上, 排队投递
  resume(message: string): Promise<void>;         // 已终态 → 续跑, 返回后 result 重新 pending? 否:
                                                  // resume 返回新 Promise<ChildResult> 经 registry.getResult()
  interrupt(): Promise<void>;                     // abort; result resolve 为 interrupted
  status(): ChildStatus;
  lastEventAt(): number;                          // watchdog 用
}

// 子会话适配层 —— pi-runtime.ts 的动态 import 产物包成此接口, 测试用 fake
export interface ChildSessionAdapter {
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  getLastAssistantText(): string | undefined;
  isStreaming(): boolean;
  subscribe(listener: (event: { type: string }) => void): () => void;
  dispose(): void;
}
export type CreateSessionFn = (req: ChildRunRequest) => Promise<ChildSessionAdapter>;

export interface ChildRunner {
  start(req: ChildRunRequest): Promise<ChildHandle>;
}

// ---------- extension/src/subagent/registry.ts ----------
export interface RunRecord {
  runId: string; kind: "tasks"|"chain";
  children: { childId: string; name: string; agent: string; status: ChildStatus;
              result?: ChildResult; startedAt: number; endedAt?: number }[];
  status: "running"|"completed"|"partial"|"failed"|"interrupted";
  createdAt: number;
}
export interface RunRegistry {
  createRun(kind: RunRecord["kind"]): RunRecord;
  get(runId: string): RunRecord | undefined;
  list(): RunRecord[];
  handle(childId: string): ChildHandle | undefined;      // 活跃与已结束(未 dispose)都可达
  findChild(runId: string, childIdOrName: string): ChildHandle | undefined;
  lineage(runIdA: string, runIdB: string): boolean;      // M4 谱系检查: v1 = 同一 runId
  onTransition(cb: (run: RunRecord) => void): void;      // fleet widget / 通知用
  disposeRun(runId: string): void;
}

// ---------- extension/src/comms/ (M4, 只依赖此接口, 不 import subagent 实现) ----------
export interface CommsHost {
  // 由 subagent registry 实现(集成期接线)
  getChild(childId: string): { handle: ChildHandle; runId: string; name: string; status: ChildStatus } | undefined;
  listChildren(): { childId: string; runId: string; name: string; status: ChildStatus }[];
  sameRun(childIdA: string, childIdB: string): boolean;
  notifySupervisor(content: string): void;               // → NotifyCenter(triggerTurn/steer 路由)
}
export interface MailboxEntry {
  ts: number; from: string; to: string;                  // "supervisor" | childId
  kind: "need_decision"|"progress_update"|"send"|"reply"|"broadcast";
  message: string; reply?: string;
}
export interface Comms {
  contactSupervisor(fromChildId: string, reason: "need_decision"|"progress_update", message: string):
    Promise<string>;        // need_decision → 等回复文本; progress_update → 立即 "ok"
  reply(toChildId: string, message: string): void;       // 无 pending waiter → throw
  send(toChildId: string, message: string, delivery: "steer"|"queue"): Promise<void>;
  broadcast(runId: string, message: string, fromChildId?: string): Promise<string[]>;  // 返回送达的 childId
  pendingRequests(): { childId: string; name: string; message: string; sinceMs: number }[];
  log(runId: string, limit?: number): MailboxEntry[];    // 默认 20, 环形 200/run
}
export function createComms(host: CommsHost): Comms;
```

**接线矩阵(集成期, 三方都不许越界)**:

| 文件 | M3 agent | M4 agent | M5 agent |
|---|---|---|---|
| `src/subagent/**` | ✅ 拥有 | ❌ | ❌ |
| `src/comms/**` | ❌ | ✅ 拥有 | ❌ |
| `src/agents/**` | ❌ | ❌ | ✅ 拥有 |
| `src/index.ts` | ✅ 注册 subagent 工具+widget | ❌(集成期接) | ❌(集成期接) |
| `src/notify.ts` `src/format.ts` | ✅ 可加 `formatSubagentNotification` | ❌(supervisor 通知格式自含于 comms/ 内) | ❌ |
| `src/config.ts` | ✅ 可加 subagent 段 | ❌ | ❌ |

## 7. 里程碑

| | 内容 | 状态 |
|---|---|---|
| M1 | manager(start/wait/output/stop/list/events/CLI)+ bash 覆盖 + task_* | ✅ 2026-09-17 |
| M2 | NotifyCenter + monitor 工具 | ✅ 2026-09-17 |
| M3 | subagent 工具(InProcessRunner + tasks/chain + budget 转异步 + fleet widget) | ✅ 2026-09-17 |
| M4 | comms(contact_supervisor / agent_message) | ✅ 2026-09-17 |
| M5 | agent 定义系统 | ✅ 2026-09-17 |

**集成期增补(2026-09-17, 全部为附录 B 的兼容扩展)**:

- `ChildResult.warning?: string` / `ChildSessionAdapter.warning?: string`: agent 定义 model 回退等非致命警告的传递通道;runner 在 settle 时从 session 复制
- `subagent` action 增加 `"models"`(不需 registry/run_id);`SubagentToolDeps.listModels` 注入候选集
- `PiRuntimeDeps.getScopedModels`: 白名单候选来源;`modelCandidates()` 导出供 listModels 复用
- `CommsWithOrigin.dispose()`: session_shutdown 时把孤儿 need_decision waiter 以超时文案 resolve(不悬挂)
- `src/comms/registry-host.ts`: CommsHost ↔ SubagentRegistry 适配器(集成期新增,F 模块自含)
- F 的工具层路由违规(跨 run/自发/缺参)返回 `details.ok:false` + 错误文本,不 throw
- 子会话 customTools 固定注入 `contact_supervisor` + `agent_message`(child sender);`bash` 变体仅当 agent tools 含 bash
