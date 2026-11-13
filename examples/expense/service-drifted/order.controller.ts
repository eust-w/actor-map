/**
 * 示例：一份"实现和需求一致"的后端。
 *
 * 这个文件是给 drift 检查用的靶子：它的每条状态迁移都应该能在 IR 里找到。
 * 真实项目里这就是你的 controller / service。
 */

router.post("/orders/:id/submit", async (req, res) => {
  const order = await orders.find(req.params.id);
  if (order.status === "draft" && req.user.amountIsPositive()) {
    order.status = "submitted";
    await order.save();
  }
  res.ok(order);
});

router.post("/orders/:id/approve", async (req, res) => {
  const order = await orders.find(req.params.id);
  if (order.status === "submitted" && order.amount <= 5000 && req.user.role === "manager") {
    order.status = "approved";
    await order.save();
  }
  res.ok(order);
});

router.post("/orders/:id/escalate", async (req, res) => {
  const order = await orders.find(req.params.id);
  if (order.status === "submitted" && order.amount > 5000 && req.user.role === "manager") {
    order.status = "pending_finance";
    await order.save();
  }
  res.ok(order);
});

router.post("/orders/:id/confirm", async (req, res) => {
  const order = await orders.find(req.params.id);
  if (order.status === "pending_finance" && req.user.role === "finance") {
    order.status = "approved";
    await order.save();
  }
  res.ok(order);
});

router.post("/orders/:id/pay", async (req, res) => {
  const order = await orders.find(req.params.id);
  if (order.status === "approved" && req.user.role === "finance") {
    order.status = "paid";
    await order.save();
  }
  res.ok(order);
});

/**
 * 这一条在 IR 里没有 —— drift 应该把它抓出来，门禁失败。
 */
router.post("/orders/:id/cancel", async (req, res) => {
  const order = await orders.find(req.params.id);
  if (order.status === "submitted" && req.user.role === "employee") {
    order.status = "cancelled";
    await order.save();
  }
  res.ok(order);
});
