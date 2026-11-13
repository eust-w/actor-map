# 报销系统 · 验收用例（v7）

由断言清单生成。每条断言 = 一条可执行的验收用例。

| 用例 | 角色 | 前提状态 | 操作 | 条件 | 期望状态 | 验收信号 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| a_001 | employee | （对象不存在） | create | — | draft | 单据出现在「我的报销」列表 | ✔ |
| a_002 | employee | draft | submit | 金额 > 0 && 已上传发票 | submitted | 单据出现在主管待办 | ✔ |
| a_003 | manager | submitted | approve | 金额 <= 5000 | approved | 状态变为已通过 | ✔ |
| a_004 | manager | submitted | escalate | 金额 > 5000 | pending_finance | 单据进入财务复核队列 | ✔ |
| a_005 | manager | submitted | reject | 发票不合规 | draft | 回到员工草稿，金额不可改 | ✔ |
| a_006 | finance | approved | pay | — | paid | 生成打款回执 | ✔ |
| a_007 | finance | pending_finance | confirm | — | approved | 进入待打款 | ⚠ 待确认 |
| a_008 | sweeper | submitted | auto_close | now - submitted_at > 30d | closed | 状态变为已关闭，双方各收一条通知 | ✔ |

## 反例（每条断言都必须被挡住的输入）

- a_002 在 金额 <= 0 时必须被拒绝，且状态不变。
- a_003 在 金额 > 5000 时必须被拒绝，且状态不变。
- a_004 在 金额 <= 5000 时必须被拒绝，且状态不变。
