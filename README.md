# ActorMap

**通过对话把需求聊定，而不是把需求写成文档。**

产品经理用自然语言讲流程，AI 一边问一边把「谁、在什么状态下、做了什么、变成什么」落成断言；
零 LLM 的校验器在每一轮找出缺口，把下一个该问的问题交给 AI。

产出是一份带 `✔ / ⚠` 的断言清单：**✔ 可以照着写代码，⚠ 还得回去问人。**

---

## 30 秒上手

```bash
git clone https://github.com/eust-w/actor-map.git
cd actor-map
npm test                       # 11 条校验器测试，零依赖
node src/cli.ts report --ir examples/expense/ir.json
```

接进 [pi](https://github.com/earendil-works/pi)：

```bash
cd actor-map
pi          # .pi/extensions/actormap.ts 会自动加载，AGENTS.md 会自动注入访谈协议
```

然后直接开口：**「我想做一个报销系统。」**

## 五轮对话之后你会得到

```
> 我想做一个报销系统。员工填完单据提交，主管批。

AI：先问一句——这个系统里除了员工和主管，还有谁会在没有界面的情况下动这些单据？
    比如定时任务、财务系统回调、导入脚本？

> 超时三十天没人批会自动关单。

AI：记下了（system actor：超时关单任务）。那主管批的时候，有没有金额上限？
    超过多少要往上走？

> 五千以上要财务复核。

AI：落了两条：
    · manager: submitted --approve--> approved，条件 金额<=5000
    · manager: submitted --escalate--> pending_finance，条件 金额>5000
    财务复核通过之后呢？
```

第 5 轮结束时 `.actormap/map.md` 里已经有 8 条断言、4 个角色、2 个缺口。
缺口不是失败，**缺口就是下一次对话的议程**。

## 三个工具，就三个

模型改不了 IR 文件，只能走这三个工具 —— 格式错误在类型边界就被挡住，幻觉没有落库的路径。

| 工具 | 干什么 |
| --- | --- |
| `ir_add_actor` | 登记角色，含 `system` / `external` / `anonymous` / `virtual` / `batch` |
| `ir_add_assertion` | 落一条状态迁移，带条件、验收和**原话依据** |
| `ir_validate` | 零 LLM 校验，返回错误 + 「该问什么」 |

## 校验器会抓什么

每条 issue 都自带一句可以直接问出口的话。

| code | 含义 | 追问 |
| --- | --- | --- |
| `implicit_entry` | 没记录创建动作，入口是推断的 | 这个对象怎么产生的？ |
| `unreachable_state` | 状态从入口走不到 | 漏了哪条迁移？ |
| `no_terminal_path` | 走不到任何终态 | 用户会不会永远卡住？ |
| `loop_without_exit` | 闭环没有出口 | 这一圈什么时候停？ |
| `ambiguous_transition` | 同状态同动作两种结果 | 到底执行哪一种？ |
| `unguarded_branch` | 多分支但无条件 | 什么时候走哪条？ |
| `orphan_actor` | 角色没有任何动作 | 他能做什么，还是不该存在？ |
| `actor_without_trigger` | 系统/外部角色没写触发条件 | 它什么时候会动？ |
| `unconfirmed_terminal` | 没人确认的终态 | 这是终点吗？ |
| `missing_source` | 断言没有原话依据 | 这是从哪句话来的？ |

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
  "terminals": ["order:paid"]
}
```

`∅` 是伪状态，代表"对象还不存在"：`∅ --create--> draft` 是创建，`draft --discard--> ∅` 是消亡。
把入口显式化，就不用猜哪个状态是起点。

## 设计取舍

1. **状态数据一行都不存。** 实体、状态、入口、终态全部推导。推导错了改算法，不用改数据。
2. **校验器零 LLM。** 结果可复现，人才能信。LLM 只负责抽取和提问。
3. **`(entity, from, action)` 唯一。** 同一状态下同一动作只能有一个结果，否则产品行为不确定。
4. **没有原话依据的断言降级成 ⚠。** 防幻觉不靠提示词，靠 `source` 字段。
5. **IR 是纯文件，进 git，可 diff。** 后面做变更集和漂移检测都建立在这上面。

## 还没做的

- 变更集与影响分析（改需求时算出谁会受影响）
- 从代码仓库反向扫描出骨架地图
- 多角色会话与跨会话矛盾检测
- Web UI（当前是终端 + Markdown）

## 许可证

MIT
