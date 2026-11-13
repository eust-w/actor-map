# ActorMap

[![spec-check](https://github.com/eust-w/actor-map/actions/workflows/speccheck.yml/badge.svg)](https://github.com/eust-w/actor-map/actions/workflows/speccheck.yml)
[![Marketplace](https://img.shields.io/badge/GitHub%20Actions-ActorMap%20Gate-6f42c1?logo=githubactions)](https://github.com/marketplace/actions/actormap-gate)
[![npm](https://img.shields.io/badge/npx-github%3Aeust--w%2Factor--map-blue)](https://www.npmjs.com/package/actor-map)

**通过对话把需求聊定，而不是把需求写成文档。**

产品经理用自然语言讲流程，AI 一边问一边把「谁、在什么状态下、做了什么、变成什么」落成断言；
零 LLM 的校验器在每一轮找出缺口，把下一个该问的问题交给 AI。

产出是一份带 `✔ / ⚠` 的断言清单和一张地图：**✔ 可以照着写代码，⚠ 还得回去问人。**

```
断言清单 .actormap/map.md      给开发    ✔ 能写 / ⚠ 还得问
地图     .actormap/map.html    给评审会  一张能点开就看的图
IR       .actormap/ir.json     给机器    进 git，可 diff，可回滚
```

---

## 30 秒上手

```bash
git clone https://github.com/eust-w/actor-map.git
cd actor-map
npm test                                     # 51 条测试，零依赖
node src/cli.ts report --ir examples/expense/ir.json
open examples/expense/map.html               # 看一眼地图长什么样
```

**或者直接跟 AI 聊着建图**：

```bash
npm run dev            # 起在 http://127.0.0.1:4173，自动开浏览器
```

左边是对话，右边是实时更新的地图、断言和缺口。你说「员工填完单子提交，主管批」，
AI 会落断言、复述确认、然后基于校验器算出的缺口问下一句——**「3000 到 5000 之间走哪条？」这种问题不是它聪明，是区间推理算出来的**。

对话不是聊天窗口，是**受约束的写入口**：模型只能通过 `ir_add_assertion` 这类工具改 IR，
编不出不存在的状态，也没法悄悄改掉已确认的断言。每轮都把当前 IR 摘要重新注入 system prompt，
所以聊到第 50 轮也不会忘——**对话是缓存，IR 才是记忆**。

模型通道从环境变量读，支持任何 Gemini 兼容网关：

```bash
ACTORMAP_LLM_BASE=https://.../  ACTORMAP_LLM_KEY=...  ACTORMAP_LLM_MODEL=gemini-2.5-flash  npm run dev
# 也认 GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY / GEMINI_MODEL
```

没配也能用：界面照常工作，只是没有对话，手动表单和门禁都在。

接进 [pi](https://github.com/earendil-works/pi)：

```bash
cd actor-map
pi --extension ./.pi/extensions/actormap.ts
```

然后直接开口：**「我想做一个报销系统。」**

> 项目级扩展要过一次项目信任；如果你已经信任过，直接 `pi` 就会自动加载 `.pi/extensions/`。
> `AGENTS.md` 会被自动注入，里面是访谈协议。

## 三种用法，同一个内核

```bash
# 1. 当 CLI 用（不用 clone，不用装）
npx --yes github:eust-w/actor-map gate --ir .actormap/ir.json

# 2. 当 PR 门禁用（在 .github/workflows/ci.yml 里）
```

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v4
  - uses: eust-w/actor-map@v1
    with:
      ir: .actormap/ir.json
      repo: .
      adapter: .actormap/adapter.mjs
      strict: false
```

```bash
# 3. 当 pi 扩展用（边聊边落断言）
pi --extension ./.pi/extensions/actormap.ts
```

三个入口共用一套代码：`src/` 是源码，`dist/` 是编译产物（`bin` 指向它——Node 拒绝对 `node_modules` 里的文件做类型剥离，所以不能直接发 `.ts`）。`tests/entrypoints.test.ts` 钉住这三个入口不许漂移。

Action 在 [GitHub Marketplace](https://github.com/marketplace/actions/actormap-gate) 上，也可以直接 `uses: eust-w/actor-map@v1`。

## 五轮对话之后

```
> 我想做一个报销系统。员工填完单据提交，主管批。

AI：先问一句——除了员工和主管，还有谁会在没有界面的情况下动这些单据？
    定时任务、财务系统回调、导入脚本？

> 超时三十天没人批会自动关单。

AI：记下了（system actor：超时关单任务）。主管批的时候有没有金额上限？
    超过多少要往上走？

> 五千以上要财务复核。

AI：落了两条：
    · manager: submitted --approve--> approved，条件 金额<=5000
    · manager: submitted --escalate--> pending_finance，条件 金额>5000
    那 3000 到 5000 之间呢？走哪条？
```

最后那一问不是 AI 聪明，是校验器算出来的：两条区间的并集没覆盖 `(3000, 5000]`。
**缺口不是失败，缺口就是下一次对话的议程。**

## 九个工具

模型改不了 IR 文件，只能走工具 —— 格式错误在类型边界就被挡住，幻觉没有落库的路径。

| 工具 | 干什么 |
| --- | --- |
| `ir_add_actor` | 登记角色，含 `system` / `external` / `anonymous` / `virtual` / `batch` |
| `ir_add_assertion` | 落一条状态迁移，带条件、验收和**原话依据** |
| `ir_change` | 改需求：带 `reason` 的变更集，自动算影响面 |
| `ir_validate` | 零 LLM 校验，返回错误 + 「该问什么」 |
| `ir_scan` | 从代码仓库反抽骨架，只收有 `file:line` 证据的迁移 |
| `ir_drift` | 代码和 IR 双向比对：偷偷加的需求 / 没实现的需求 |
| `ir_export` | 导出 tools.json + openapi.yaml + acceptance.md + runner.mjs |
| `ir_conformance` | 把真实实现接进参考状态机跑契约测试 |
| `ir_gate` | 三项检查一次跑完，给 PR 一个裁决 |

## 校验器会抓什么

每条 issue 都自带一句可以直接问出口的话。

| code | 含义 | 追问 |
| --- | --- | --- |
| `branch_gap` | 两个分支之间存在无人覆盖的区间 | 3000~5000 归谁管？ |
| `branch_overlap` | 两个分支的条件同时成立 | 走哪一条？ |
| `unsatisfiable_guard` | 单条断言的条件自相矛盾 | 真实条件是什么？ |
| `implicit_entry` | 没记录创建动作，入口是推断的 | 这个对象怎么产生的？ |
| `unreachable_state` | 状态从入口走不到 | 漏了哪条迁移？ |
| `no_terminal_path` | 走不到任何终态 | 用户会不会永远卡住？ |
| `loop_without_exit` | 闭环没有出口 | 这一圈什么时候停？ |
| `ambiguous_transition` | 同状态同动作两种结果 | 到底执行哪一种？ |
| `ambiguous_owner` | 同一动作多个发起者 | 谁说了算？ |
| `action_semantics_conflict` | 一个动作名指向多个结果 | 是不是该拆成两个动作？ |
| `unguarded_branch` | 多分支但无条件 | 什么时候走哪条？ |
| `orphan_actor` | 角色没有任何动作 | 他能做什么，还是不该存在？ |
| `actor_without_trigger` | 系统/外部角色没写触发条件 | 它什么时候会动？ |
| `unconfirmed_terminal` | 没人确认的终态 | 这是终点吗？ |
| `missing_source` | 断言没有原话依据 | 这是从哪句话来的？ |

## 改需求

改需求是常态，不是例外，所以 IR 是「基线 + 变更集」：

```bash
actormap change --reason "驳回后允许改金额" --file changes.json
```

```
cs_001 已应用（~1）：驳回后允许改金额
受影响状态：submitted、draft
已消除：branch_gap -1
后续动作：
  · 更新契约测试：a_005
  · 复核 submitted 下另外 2 条分支是否仍成立：approve、escalate
错误数：1 → 0
```

删掉的断言不会静默消失，会留墓碑（`tombstones`）。`actormap history` 看全部变更。

## 从代码开始

```bash
actormap scan ~/code/my-app            # 只出报告，不动 IR
actormap scan ~/code/my-app --seed     # 把骨架写进 IR（已存在需 --force）
```

```
扫描 my-app：247 个文件 → entity 12 · state 31 · transition 44 · actor 6
骨架：7 个角色 · 38 条迁移（高置信 31 / 待确认 7）
需要人回答的问题：
  · src/jobs/archive.ts:42 把状态改成 "archived"，但看不出是从哪个状态来的。
  · 状态 "cancelled" 在代码里没有任何迁移。它是终态，还是这次没扫到？
```

只有同时拿到「路由/函数名」和「from 状态比较」的迁移才算高置信。
其余全部变成问题 —— **扫描的价值是让人挑错，不是替人决定。**

## 常用命令

```bash
actormap init "报销系统"
actormap validate                          # 有 error 时退出码 1，可当 CI 门禁
actormap report --out .actormap/map.md
actormap render --out .actormap/map.html
actormap scan <repo> [--seed] [--force]
actormap drift <repo>                      # 代码多了没确认的迁移 → 退出码 1
actormap conformance --adapter ./a.mjs     # 契约测试，有失败 → 退出码 1
actormap gate [--repo .] [--adapter …]     # 三项合一的门禁，默认扫当前目录
actormap gate --write-fixes fix.json       # 把代码多出来的迁移转成可应用的 IR 补丁
actormap gate --no-repo --strict           # 只要 validate + conformance，跳过即失败
actormap export --out .actormap/export
actormap change --reason "…" --file changes.json
actormap history
```

## PR 门禁：三项检查，一个裁决

```bash
actormap gate --repo . --adapter .actormap/adapter.mjs
```

```
门禁通过 · 报销系统 v7

✔ 需求自洽：8 条断言 · 0 错误 · 2 待确认
✔ 实现与需求一致：对上 5 条 · 代码多出 0 条 · 未实现 3 条
✔ 契约测试：12/12 通过
```

| 检查 | 拦什么 |
| --- | --- |
| **需求自洽** | IR 自己有错误（行为不确定、走不到终态、分支重叠…） |
| **实现与需求一致** | 代码里有、IR 没确认过的迁移（偷偷加的需求），双向比对 |
| **契约测试** | 实现违反断言（阈值、权限、拒绝后状态被改脏） |

三种结果分开：`✔ 通过` / `✖ 拦下` / `– 跳过`。**跳过不等于通过** —— 没给仓库就明说没查，
加 `--strict` 则要求三项都真的跑起来。

### 一个第二天就被关掉的门禁等于没有门禁

所以留了两个口子，`.actormap/gate.json`：

```json
{
  "allowDrift": [
    { "from": "submitted", "action": "cancel", "to": "cancelled",
      "reason": "PR #42 先上，下个迭代补 IR" }
  ],
  "warnOnly": ["conformance"]
}
```

- `allowDrift`：已知的、暂时接受的漂移。**必须写 reason**，报告里会显示「已豁免 1」。
- `warnOnly`：某项先降级成警告，观察两周再接成硬门禁。

### 行内评论：贴在 diff 的具体某一行

门禁的每条发现都带 `file:line`，PR 上直接标在代码行上：

```
✖ 需求里没有这条迁移：submitted --cancel--> cancelled
   IR 里没有确认过这条。要么补进 IR（ir_change，写清 reason），要么删掉这段代码。
   <!-- actormap:drift:submitted|cancel|cancelled -->
```

两个通道都实现了，因为成本完全不同：

| 通道 | 需要什么 | 效果 |
| --- | --- | --- |
| Workflow commands `::error file=…,line=…` | 零权限 | Actions 里自动出现在 diff 上 |
| PR review comments | `pull-requests: write` | 能带解释、能被讨论、能 resolve |

#### 能一键 Apply 的 suggestion

不是所有发现都停在“评论”这一步。`drift-extra` 会直接给一个可点 **Apply suggestion** 的删除块：

```
**需求里没有这条迁移：submitted --cancel--> cancelled**
IR 里没有确认过这条。要么补进 IR，要么删掉这段代码。

​```suggestion
​```
```

渲染成 `start_line: 53 → line: 60`，正好覆盖整个 `router.post(...)` handler。点一下，这段代码就没了。

能给出这个块，靠的是扫描器记下的**完整语句块范围**，而不是猜：

- 只删 `order.status = "cancelled"` 这一行会留下语法破损的 `if`，所以范围必须是整个 handler。
- **只有这个块里恰好一条迁移时才给范围。** 块里混了别的行为，删整块会误伤 —— 这时宁可不给建议，退化成普通评论。
- 范围必须**整段落在本次 diff 的新增行里**。被 diff 截断就不出 suggestion（GitHub 会 422，而且真删出来也是坏代码）。

#### 两条路，都只差一次点击

删掉代码是其中一条。另一条是「其实该保留」，所以评论里同时给出**可粘贴的 IR 补丁**：

<details>
<summary>也可以：把这条补进 IR（复制 YAML 或跑一条命令）</summary>

```yaml
- entity: order
  from: submitted
  action: cancel
  to: cancelled
  by: employee
  guards: []
  verify: ""
  source: "代码：order.controller.ts:59"
  status: confirmed
```

```bash
actormap change --file .actormap/drift-fix.json \
  --reason "补上代码里已有、IR 没确认的迁移：submitted --cancel--> cancelled"
```
</details>

`by` 不是瞎猜的 —— 扫描器会记住那个 handler 里的角色判断（`req.user.role === "employee"`）。
推断不出来的字段会标 `assumed` 并在注释里明说，不会让人无声地接受一个假设。

批量取全部补丁：

```bash
actormap gate --write-fixes .actormap/drift-fix.json
actormap change --file .actormap/drift-fix.json --reason "…"
```

**应用补丁之后门禁会变绿**，但校验器可能立刻报出新的缺口 —— 比如新加的 `cancel` 和 `approve` 在同一状态下区间重叠（`branch_overlap`）。这不是 bug，是补上一条需求之后自然暴露的下一个该问的问题。

三条规则：

1. **只标本次新增的行。** 注释在别人的上下文行上会让 review 变吵，所以先拿 PR 的 patch 算出新增行号，落不进去的不丢——降级写进 review 正文的折叠块里。
2. **去重靠标记。** 每条评论带 `<!-- actormap:<marker> -->`，重跑时已有的跳过；结论完全没变就一条都不发。
3. **能先离线看。** 不联网预览会贴在哪几行：

```bash
git diff --no-index old/ new/ > pr.patch
actormap gate --dry-run --diff pr.patch --quiet | jq '.comments'
```

### 挂到别人的仓库上

这是一个可复用工作流：

```yaml
# 在你自己仓库的 .github/workflows/ci.yml 里
jobs:
  spec-gate:
    uses: eust-w/actor-map/.github/workflows/gate-reusable.yml@main
    with:
      ir: .actormap/ir.json
      repo: .
      adapter: .actormap/adapter.mjs
      strict: false
```

在 GitHub Actions 里跑时，摘要会自动写进 `$GITHUB_STEP_SUMMARY`，PR 页面直接能看到哪条断言被破了。

## 契约测试：把真实实现接进来

这是整条链路合上的地方。适配器只交出三个方法，业务代码一行不用改：

```js
// adapter.mjs
const orders = new Map();

export default {
  name: "expense-service",
  create(actor, ctx) {           // 新建，返回 id
    if (actor !== "employee") throw new Error("只有员工能建");
    const id = String(orders.size + 1);
    orders.set(id, { status: "draft", amount: Number(ctx.金额 ?? 0) });
    return id;
  },
  act(id, action, ctx, actor) {   // 执行；抛错或返回 { ok: false } 表示拒绝
    const row = orders.get(id);
    if (action === "approve" && !(ctx.金额 <= 5000)) throw new Error("超过 5000 要财务复核");
    ...
  },
  state(id) { return orders.get(id).status; },  // 读当前状态
};
```

```bash
actormap conformance --adapter ./adapter.mjs
```

```
报销系统 v7 × expense-service：12/12 通过
```

它跑三类用例，全部由断言推导，不需要手写：

| 用例 | 期望 | 抓什么 |
| --- | --- | --- |
| 正例 | 成功且落到 `to` | 功能没实现 |
| 条件反例 | 被拒且状态不变 | 阈值写错、校验被绕过、先写库再校验 |
| 角色反例 | 被拒 | 权限漏检 |

取值一律用**边界值**：`金额 <= 5000` 的正例取 5000，反例取 5001。
差一错误是需求实现里最高频的 bug，也只有边界值能抓到。

仓库里带了一个故意写坏两处的实现，可以直接看它被抓：

```bash
actormap conformance --adapter ./examples/expense/adapters/expense-service-broken.mjs
```

```
报销系统 v7 × expense-service · 两处 bug：7/12 通过 · 3 失败
  ✖ a_003 反例·条件：submitted --approve--> approved（manager）
    期望被拒绝，实现却放行了（状态 approved）      输入：金额=5001
  ✖ a_006 反例·角色：approved --pay--> paid（employee）
    期望被拒绝，实现却放行了（状态 paid）
```

判分的不是 `cases.ts`，是导出的 `runner.mjs` 本身 —— 也就是说，
**你手上拿去给 coding agent 当尺子的那个文件，就是契约测试的裁判**，不存在两套逻辑。

解析不了的条件（`已上传发票`、`now - submitted_at > 30d`）不猜：整条断言标为 unchecked，
列在报告末尾等人确认。宁可漏测，不可误判。

## 一份来源，四份交付

```bash
actormap export
```

```
.actormap/export/tools.json       agent 的工具表，条件里的变量直接变成参数
.actormap/export/openapi.yaml     每个动作一个 path
.actormap/export/acceptance.md    QA 的验收用例，含每条条件的反例
.actormap/export/runner.mjs       参考状态机，给 coding agent 当尺子用
```

`runner.mjs` 能直接跑：

```js
import { apply, create, unchecked } from "./.actormap/export/runner.mjs";
apply("submitted", "approve", { 金额: 4000 }, "manager"); // { allowed: true, to: "approved" }
apply("submitted", "approve", { 金额: 9000 }, "manager"); // { allowed: false, reason: "guard-rejected" }
create("order", "employee");                              // "draft"
unchecked;                                                // 解析不了的条件（时间表达式等），必须人看
```

三者都是同一个状态机的投影，所以永远不会互相漂移 —— 需求改一次，三份一起变。

## IR 长什么样

只有两样东西是"作者写的"，实体、状态、入口、终态全部从断言推导 —— 少存一种数据，就少一种不一致。

```jsonc
{
  "actors": [
    { "id": "sweeper", "name": "超时关单任务", "type": "system",
      "trigger": "submitted 状态超过 30 天未处理" }
  ],
  "assertions": [
    { "id": "a_001", "entity": "order",
      "from": "∅", "action": "create", "to": "draft", "by": "employee",
      "guards": [], "verify": "单据出现在「我的报销」列表",
      "source": "员工点新建，填一张报销单", "status": "confirmed" }
  ],
  "terminals": ["order:paid"],
  "changesets": [], "tombstones": []
}
```

`∅` 是伪状态，代表"对象还不存在"：`∅ --create--> draft` 是创建，`draft --discard--> ∅` 是消亡。
把入口显式化，就不用猜哪个状态是起点。

## 目录

```
src/ir/types.ts          IR 类型：actor / assertion / changeset / tombstone
src/ir/store.ts          读写与写入校验
src/ir/changes.ts        变更集 + 影响分析（前后各跑一次校验做差分）
src/validate/validate.ts 图算法：可达性、死锁、孤儿、终态
src/validate/guards.ts   条件区间推理：重叠、空洞、自相矛盾
src/scan/scanner.ts      仓库扫描：实体/状态/迁移/角色，只收有证据的
src/scan/drift.ts        代码 ↔ IR 双向漂移
src/conformance/cases.ts 从断言推导正例/条件反例/角色反例（边界值）
src/conformance/harness.ts 接适配器执行，用 runner.mjs 当裁判
src/gate/index.ts        三项检查合一 + 豁免/降级 + Markdown 摘要
src/gate/annotate.ts     发现 → 行内标注：diff 过滤、工作流命令、review 载荷
src/gate/github.ts       PR files / comments / reviews（只依赖 fetch，可注入）
src/gate/suggest.ts      反向建议：可粘贴的 IR YAML + 可执行的 change 载荷
src/server/app.ts        HTTP API（和 CLI/扩展共用 handler）
src/server/agent.ts      对话 agent：system prompt 注入 IR + 三个工具 + 工具循环
src/server/llm.ts        Gemini 兼容客户端（可注入 fetcher，便于测试）
src/server/index.ts      零依赖静态服务 + API
web/                     本地工作台单页应用（原生 JS，无构建）
src/report/checklist.ts  ✔/⚠ 断言清单
src/report/html.ts       单文件 HTML 地图
src/extension/handlers.ts 九个工具的实际逻辑（可单测）
src/extension/index.ts   pi 绑定层，只声明 schema
```

## 设计取舍

1. **状态数据一行都不存。** 实体、状态、入口、终态全部推导。推导错了改算法，不用改数据。
2. **校验器零 LLM。** 结果可复现，人才能信。LLM 只负责抽取和提问。
3. **`(entity, from, action)` 唯一。** 同一状态下同一动作只能有一个结果，否则产品行为不确定。
4. **没有原话依据的断言降级成 ⚠。** 防幻觉不靠提示词，靠 `source` 字段 + 工具边界。
5. **IR 是纯文件，进 git，可 diff。** 变更集、墓碑、漂移检测都建立在这上面。
6. **解析不了的条件不臆断。** `now - submitted_at > 30d` 进 `unparsed`，不参与区间推理 —— 宁可漏报，不可误报。

## 还没做的

- 跨角色的说法前后不一致检测（同一个 PM 换个帽子说了相反的话）
- Diff 里的 suggestion（现在只评论，还不能一键 Apply suggestion）
- 多实体流程（当前一条断言只能挂一个 entity，跨对象的事务没有建模）
- 一次调用改多个状态的场景（现在假设一条动作只改一个实体）
- drift 接入 PR 门禁（`.github/workflows/speccheck.yml` 已经跑了测试和校验，
  还没在真实仓库上挂 drift）
- 图形化编辑（当前是终端对话 + 生成的自包含 HTML 地图）

## 从源码构建

```bash
npm ci
npm run build        # tsc → dist（import 说明符会被重写成 .js）
npm test             # 105 条，不需要任何依赖
```

`dist/` 是提交进仓库的：这样 `npx github:eust-w/actor-map` 不需要在安装时编译，CI 里也有一步 `git diff --exit-code -- dist` 防止它过期。

## 许可证

MIT
