/**
 * 演示用的"真实实现"：一个内存版报销服务。
 *
 * 适配器只是把业务代码接到契约测试上，不需要改业务逻辑。
 * 这个实现严格按 IR 来，所以契约测试应当全绿。
 */

const orders = new Map();
let seq = 0;

const OWNER = {
	submit: "employee",
	approve: "manager",
	escalate: "manager",
	reject: "manager",
	pay: "finance",
	confirm: "finance",
	auto_close: "sweeper",
};

function must(condition, message) {
	if (!condition) throw new Error(message);
}

export default {
	name: "expense-service · 正确实现",

	create(actor, ctx) {
		must(actor === "employee", `角色 ${actor} 不能新建报销单`);
		const id = `o${++seq}`;
		orders.set(id, { status: "draft", amount: Number(ctx.金额 ?? 0) });
		return id;
	},

	act(id, action, ctx, actor) {
		const order = orders.get(id);
		must(order, `找不到单据 ${id}`);
		must(OWNER[action] === actor, `角色 ${actor} 不能执行 ${action}`);

		const amount = Number(ctx.金额 ?? order.amount);

		switch (action) {
			case "submit":
				must(order.status === "draft", "只有草稿能提交");
				must(amount > 0, "金额必须大于 0");
				order.status = "submitted";
				return;
			case "approve":
				must(order.status === "submitted", "只有待审批能通过");
				must(amount <= 5000, "超过 5000 必须走财务复核");
				order.status = "approved";
				return;
			case "escalate":
				must(order.status === "submitted", "只有待审批能升级");
				must(amount > 5000, "5000 以内不需要财务复核");
				order.status = "pending_finance";
				return;
			case "reject":
				must(order.status === "submitted", "只有待审批能驳回");
				order.status = "draft";
				return;
			case "pay":
				must(order.status === "approved", "只有已通过的才能打款");
				order.status = "paid";
				return;
			case "confirm":
				must(order.status === "pending_finance", "只有待财务复核的才能确认");
				order.status = "approved";
				return;
			case "auto_close":
				must(order.status === "submitted", "只有待审批的会被超时关单");
				order.status = "closed";
				return;
			default:
				throw new Error(`未知动作 ${action}`);
		}
	},

	state(id) {
		const order = orders.get(id);
		if (!order) throw new Error(`找不到单据 ${id}`);
		return order.status;
	},
};
