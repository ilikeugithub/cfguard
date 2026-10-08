# cfguard

**Cloudflare Workers 实时费用熔断器。** 在代码里逐条计量 D1 / KV / R2 / Durable Objects 的用量，一旦超出预算，几秒内就切断所有计费调用，不用等几小时后才收到账单提醒。

> Real-time cost circuit breaker for Cloudflare Workers. Meters D1/KV/R2/Durable Objects usage in-process and stops runaway bills within seconds — including cron, queue and Durable Object alarm loops.

## 为什么需要它

Cloudflare 付费计划**没有消费硬上限**，官方的预算告警只发邮件，而且数据有延迟。2026 年公开的账单事故里，单笔从 $800 到 $34,895 不等，原因几乎都是下面三类 bug：

| Bug | 例子 | cfguard 怎么拦 |
|---|---|---|
| 缺索引导致全表扫描 × 正常流量 | `WHERE author = ?` 没有索引 | 全局滑动窗口按估算费用熔断，告警里直接写出是哪条 SQL、哪个接口 |
| 死循环写入 | 循环的退出条件永远不成立 | 单次调用预算：超出就当场抛错，停在这一次请求里 |
| 没有用户也在跑的循环 | DO alarm 不停地重新调度、cron、queue 反复重试 | alarm、cron、queue 都会被拦截；熔断期间 alarm 自动推迟 1 小时 |

## 工作原理

```
请求 / cron / queue / DO alarm
   │
   ▼
guarded env（代理 D1/KV/R2 binding）
   │  每条 D1 查询都会返回 meta.rows_read / rows_written，这就是计费口径
   │  ├─ 单次调用预算：超出 → BudgetExceededError → 返回 503
   │  └─ 在 isolate 本地累计，每隔几秒汇总上报一次
   ▼
CostGuard Durable Object（部署在你自己的账号里）
   ├─ 按分钟分桶，滑动窗口统计：5 分钟、1 小时、1 天
   ├─ 超出窗口上限 → 熔断：之后所有 isolate 拒绝计费调用
   └─ 发送告警：Webhook、Slack、Discord、飞书、钉钉、企业微信、Telegram
```

- **所有逻辑都在你自己的 Worker 里运行。** 不依赖任何外部服务，也不需要交出 API Token。
- **失败时放行。** CostGuard 不可用时只记日志，业务照常运行，单次调用预算仍然有效。

## 安装与接入

```bash
npm i cfguard
```

**1. wrangler 配置**：添加 CostGuard Durable Object，并设置管理令牌。

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "CFGUARD", "class_name": "CostGuard" }]
  },
  "migrations": [{ "tag": "cfguard-v1", "new_sqlite_classes": ["CostGuard"] }]
}
```

```bash
npx wrangler secret put CFGUARD_ADMIN_TOKEN
```

**2. 包装入口**：只需要改 `export default` 这一处。

```ts
import { CostGuard, withGuard, guardDurableObject, type CostGuardOptions } from "cfguard";

export { CostGuard };

const guard = (env: Env): CostGuardOptions => ({
  bindings: { DB: "d1", CACHE: "kv", FILES: "r2" },       // 要计量的 binding
  label: "my-blog",
  locale: "zh",
  windows: [
    { minutes: 5, maxUsd: 2 },
    { minutes: 60, maxUsd: 10 },
    { minutes: 1440, maxUsd: 50 },
  ],
  alerts: [{ type: "feishu", url: env.FEISHU_WEBHOOK }],
});

export default withGuard({ fetch: app.fetch, scheduled, queue }, guard);   // Hono 用户可以直接写 withGuard(app, guard)

// Durable Object：包一层之后，alarm 死循环也能被熔断
export const Room = guardDurableObject(RoomImpl, guard, "Room");
```

handler 里的 `env.DB` 已经自动替换成受保护的版本，业务代码不用做任何修改。

## 配置项

| 选项 | 默认值 | 说明 |
|---|---|---|
| `bindings` | 必填 | `{ 绑定名: "d1" \| "kv" \| "r2" }` |
| `perInvocation` | D1 读 5M 行 / 写 100K 行，KV 写 1K 次 … | 单次请求、cron 或 alarm 的硬上限，用来拦死循环 |
| `windows` | 5 分钟 $2 / 1 小时 $10 / 1 天 $50 | 全局熔断窗口，可以按美元 `maxUsd` 设，也可以按任意指标 `limits` 设 |
| `warnAt` | `0.7` | 用到上限的 70% 时先发一次预警 |
| `autoResetMinutes` | 不自动恢复 | bug 不会自己消失，所以默认需要手动恢复 |
| `alerts` | `[]` | `webhook` / `slack` / `discord` / `feishu` / `dingtalk` / `wecom` / `telegram` |
| `locale` | `"en"` | 告警语言：`"zh"` 或 `"en"` |
| `syncIntervalMs` | `5000` | isolate 上报用量的间隔，也决定其他 isolate 多快感知到熔断 |
| `adminPath` | `/__cfguard` | 管理接口路径，设为 `false` 关闭 |
| `queueRetryDelaySeconds` | `3600` | 熔断期间，queue 消息延后多久再重试（消息不会丢） |
| `alarmDeferSeconds` | `3600` | 熔断期间，DO alarm 推迟多久（设为 0 表示直接丢弃） |
| `name` | `"global"` | 换一个名字，就是一份独立的预算 |

费用估算按 2026 年 10 月的超额单价计算，**不扣除免费额度**，所以结果偏保守。单价见 `PRICES_USD`。

## 管理接口

所有请求都需要带 `Authorization: Bearer $CFGUARD_ADMIN_TOKEN`。如果没有设置令牌，这些接口一律返回 404。

```bash
curl -H "authorization: Bearer $TOKEN" https://your.app/__cfguard/status          # 各窗口用量、最贵的 SQL 和入口
curl -X POST -H "authorization: Bearer $TOKEN" https://your.app/__cfguard/reset    # 修复后恢复服务
curl -X POST -H "authorization: Bearer $TOKEN" "https://your.app/__cfguard/trip?reason=..."  # 手动熔断
```

恢复后，恢复之前的用量不再计入窗口，所以不会因为刚才那波流量马上又被熔断。

## 上线前检查（CI）

```ts
import { assertNoFullScans } from "cfguard/testing";

await assertNoFullScans(env.DB, [
  ["SELECT * FROM posts WHERE author = ?", ["x"]],   // 没有索引 → 测试失败，并指出是哪条 SQL
]);
```

## 示例与测试

`example/` 是一个故意写了上面三种 bug 的 Worker。测试会在本地 workerd 里真实复现这些 bug，并验证都能被拦下：

```bash
npm test
```

本地手动体验（把预算调到很低）：

```bash
npx wrangler dev -c example/wrangler.jsonc --var CFGUARD_MAX_USD_5M:0.001 --var CFGUARD_ADMIN_TOKEN:demo
```

```bash
curl -X POST localhost:8787/setup && curl -X POST "localhost:8787/seed?n=20000"
```

```bash
for i in $(seq 100); do curl -s -o /dev/null -w "%{http_code}\n" "localhost:8787/search?author=author-7"; done
```

## 已知限制

- **已经发出的单条查询停不下来。** 预算在每条查询返回后检查；一条语句一次写入 2 万行，这 2 万行照样会被计费，熔断拦的是后续调用。
- **绕过包装的调用不会被计量**：通过 `import { env } from "cloudflare:workers"` 拿到的 binding，以及 `wrangler d1 execute` 脚本。
- **默认导出是 `WorkerEntrypoint` 类的写法暂不支持**，目前只支持对象形式的默认导出（包括 Hono）。
- **DO 的 RPC 方法**按"每个对象每分钟"统一计算预算，不单独当作一次调用；`doRequests` 只统计 alarm 和 fetch。
- **还没有计量** Workers AI、Vectorize、Queue 操作次数和 Worker CPU 时间。
- `raw({ columnNames: true })` 在结果为 0 行时拿不到列名，会返回 `[[]]`。
- `first()` / `raw()` 底层走 `all()` 实现：计费口径一致（D1 按扫描行数），但大结果集会把全量结果拉进 isolate 内存。取单行时建议在 SQL 里加 `LIMIT 1`。
- **新 isolate 的第一个请求**会多等一次 DO 往返（超过 1 秒就直接放行）；其他 isolate 会在 `syncIntervalMs` 内感知到熔断。
- **自身开销**：每个活跃 isolate 每 5 秒最多 1 次 DO 请求；CostGuard 每分钟最多写约 41 行 SQLite。

## License

MIT
