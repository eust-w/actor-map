/* 本地工作台前端：无框架、无构建，所有状态都从 /api/state 重新拉。 */

const $ = (sel) => document.querySelector(sel);
let STATE = null;
let selected = null;
/** 只带文本的对话历史；IR 摘要每轮由服务端重新注入，所以这里可以很短 */
let HISTORY = [];
let MODEL = { available: false };

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(text, ms = 2600) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), ms);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.append(child);
  return node;
}

async function refresh() {
  STATE = await api("/api/state");
  render();
}

function render() {
  const s = STATE;
  $("#product").textContent = s.product;
  $("#version").textContent = `v${s.version}`;
  $("#stats").replaceChildren(
    el("span", {}, [el("b", { text: String(s.stats.assertions) }), document.createTextNode(" 条断言")]),
    el("span", {}, [document.createTextNode("✔ "), el("b", { text: String(s.stats.confirmed) })]),
    el("span", {}, [document.createTextNode("⚠ "), el("b", { text: String(s.stats.assumed) })]),
    el("span", {}, [document.createTextNode("✖ "), el("b", { text: String(s.stats.errors) })]),
    el("span", {}, [document.createTextNode("角色 "), el("b", { text: String(s.stats.actors) })]),
  );
  $("#actor-count").textContent = `${s.actors.length}`;
  $("#assert-count").textContent = `${s.assertions.length}`;

  renderActors();
  renderAssertions();
  renderGraph();
  renderIssues();
  renderBySelect();
  renderModelStatus();
}

function renderModelStatus() {
  const el = $("#model-status");
  el.textContent = MODEL.available ? `· ${MODEL.model}` : "· 未配置模型";
  el.title = MODEL.available ? "" : MODEL.hint || "";
}

function renderActors() {
  const list = $("#actors");
  list.replaceChildren(
    ...STATE.actors.map((a) =>
      el("li", {}, [
        el("strong", { text: a.name }),
        el("span", { class: "muted", text: ` ${a.id} · ${a.type}` }),
        ...(a.trigger ? [el("span", { class: "meta muted", text: a.trigger })] : []),
      ]),
    ),
  );
  if (STATE.actors.length === 0) list.append(el("li", { class: "muted", text: "还没有角色" }));
}

function renderAssertions() {
  const list = $("#assertions");
  list.replaceChildren(
    ...STATE.assertions.map((a) =>
      el("li", { class: a.status === "assumed" ? "assumed" : "" }, [
        el("span", { text: `${a.status === "assumed" ? "⚠" : "✔"} ${a.by} ${a.from} --${a.action}--> ${a.to}` }),
        el("span", { class: "meta", text: a.guards.length ? a.guards.join(" && ") : "无条件" }),
        ...(a.source ? [] : [el("span", { class: "meta", text: "（没有原话依据）" })]),
      ]),
    ),
  );
  if (STATE.assertions.length === 0) list.append(el("li", { class: "muted", text: "还没有断言" }));
}

function renderBySelect() {
  const select = $("#by-select");
  const current = select.value;
  select.replaceChildren(...STATE.actors.map((a) => el("option", { value: a.id, text: `${a.name} (${a.id})` })));
  if (current && STATE.actors.some((a) => a.id === current)) select.value = current;
}

// ── 地图 ────────────────────────────────────────────────────────────────

const NODE_W = 118;
const NODE_H = 38;
const COL = 190;
const ROW = 86;

function layout(graph) {
  const levels = new Map();
  const queue = [];
  for (const entry of graph.initial.length ? graph.initial : graph.states.slice(0, 1)) {
    levels.set(entry, 0);
    queue.push(entry);
  }
  while (queue.length) {
    const state = queue.shift();
    const level = levels.get(state) ?? 0;
    for (const edge of graph.edges) {
      if (edge.from !== state || edge.to === "∅") continue;
      if (!levels.has(edge.to)) {
        levels.set(edge.to, level + 1);
        queue.push(edge.to);
      }
    }
  }
  for (const state of graph.states) if (!levels.has(state)) levels.set(state, 0);

  const byLevel = new Map();
  for (const [state, level] of levels) {
    if (!byLevel.has(level)) byLevel.set(level, []);
    byLevel.get(level).push(state);
  }
  const nodes = new Map();
  for (const [level, states] of byLevel) {
    states.sort().forEach((state, row) => {
      nodes.set(state, { x: 40 + level * COL, y: 30 + row * ROW });
    });
  }
  return nodes;
}

function renderGraph() {
  const host = $("#graph");
  host.replaceChildren();
  if (!STATE.graphs.length) {
    host.append(el("p", { class: "muted", text: "还没有断言，地图是空的" }));
    return;
  }

  for (const graph of STATE.graphs) {
    const nodes = layout(graph);
    const width = Math.max(...[...nodes.values()].map((n) => n.x)) + NODE_W + 60;
    const height = Math.max(...[...nodes.values()].map((n) => n.y)) + NODE_H + 40;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    svg.setAttribute("height", height);
    svg.classList.add("graph-svg");

    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "arrow");
    marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "9");
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "7");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("orient", "auto");
    const tip = document.createElementNS("http://www.w3.org/2000/svg", "path");
    tip.setAttribute("d", "M0,0 L10,5 L0,10 z");
    tip.setAttribute("fill", "currentColor");
    marker.append(tip);
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.append(marker);
    svg.append(defs);

    for (const edge of graph.edges) {
      if (edge.from === "∅" || !nodes.has(edge.to) || !nodes.has(edge.from)) continue;
      const a = nodes.get(edge.from);
      const b = nodes.get(edge.to);
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x;
      const y2 = b.y + NODE_H / 2;
      const dx = Math.max(40, Math.abs(x2 - x1) / 2);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`);
      path.setAttribute("class", `edge ${edge.status}`);
      path.setAttribute("marker-end", "url(#arrow)");
      path.dataset.from = edge.from;
      path.dataset.to = edge.to;
      svg.append(path);

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", (x1 + x2) / 2);
      label.setAttribute("y", (y1 + y2) / 2 - 4);
      label.setAttribute("class", "label");
      label.dataset.from = edge.from;
      label.dataset.to = edge.to;
      label.textContent = edge.action;
      svg.append(label);
    }

    for (const [state, pos] of nodes) {
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const isInitial = graph.initial.includes(state);
      const isTerminal = graph.terminal.includes(state);
      group.setAttribute("class", `node ${isInitial ? "initial" : ""} ${isTerminal ? "terminal" : ""}`);
      group.dataset.state = state;
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", pos.x);
      rect.setAttribute("y", pos.y);
      rect.setAttribute("width", NODE_W);
      rect.setAttribute("height", NODE_H);
      rect.setAttribute("rx", "9");
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", pos.x + NODE_W / 2);
      text.setAttribute("y", pos.y + NODE_H / 2 + 4);
      text.textContent = state;
      group.append(rect, text);
      group.addEventListener("click", () => selectState(state, svg));
      svg.append(group);
    }

    host.append(el("div", { class: "muted", text: `${graph.entity} · 入口 ${graph.initial.join(" / ") || "未定"} · 终态 ${graph.terminal.join(" / ") || "未定"}` }));
    host.append(svg);
  }
}

function selectState(state, svg) {
  const same = selected === state;
  selected = same ? null : state;
  svg.classList.toggle("dim", !same);
  svg.querySelectorAll(".hl").forEach((node) => node.classList.remove("hl"));
  svg.querySelectorAll(".node").forEach((node) => node.classList.toggle("selected", node.dataset.state === selected));
  if (same) return;
  svg.querySelectorAll("[data-from]").forEach((node) => {
    if (node.dataset.from === state || node.dataset.to === state) node.classList.add("hl");
  });
}

// ── 缺口 ────────────────────────────────────────────────────────────────

function renderIssues() {
  const list = $("#issues");
  list.replaceChildren();
  if (STATE.issues.length === 0) {
    list.append(el("li", { class: "muted", text: "没有发现问题。" }));
    return;
  }
  for (const issue of STATE.issues) {
    const node = el("li", { class: issue.severity === "error" ? "err" : "warn" }, [
      el("span", { class: "tag", text: `${issue.severity === "error" ? "✖" : "⚠"} ${issue.code}` }),
      document.createTextNode(issue.message),
      el("div", { class: "ask", text: `问：${issue.question}` }),
    ]);
    node.addEventListener("click", () => prefillFromIssue(issue));
    list.append(node);
  }
}

const STATE_WORDS = /["“]([^"“”]{1,40})["”]|(\b[a-z][a-z0-9_]{1,30}\b)/g;

function guessStates(text) {
  const found = [];
  let m;
  STATE_WORDS.lastIndex = 0;
  while ((m = STATE_WORDS.exec(text))) {
    const word = m[1] ?? m[2];
    if (!word) continue;
    if (["error", "warn", "id", "actor", "main", "order", "code", "source"].includes(word)) continue;
    if (!found.includes(word)) found.push(word);
  }
  return found;
}

function prefillFromIssue(issue) {
  const form = $("#form-assertion");
  const states = guessStates(issue.message).filter((s) => s !== "∅");
  if (states.length >= 2) {
    form.from.value = states[0];
    form.to.value = states[1];
  } else if (states.length === 1) {
    form.from.value = states[0];
  }
  if (issue.code === "unconfirmed_terminal") {
    form.to.value = form.from.value || "";
  }
  form.action.focus();
  toast("已按缺口填好起点/终点，补上动作即可");
}

// ── 对话 ────────────────────────────────────────────────────────────────

function appendMessage(role, text, events = []) {
  const node = el("div", { class: `msg ${role}` });
  node.append(document.createTextNode(text));
  if (events.length > 0) {
    const box = el("div", { class: "events" });
    for (const event of events) {
      box.append(el("div", { class: `event ${event.ok ? "" : "fail"}`, text: `· ${event.detail.split("\n")[0]}` }));
    }
    node.append(box);
  }
  $("#chat-log").append(node);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  return node;
}

function appendThinking() {
  const node = el("div", { class: "msg assistant thinking", text: "思考中…" });
  $("#chat-log").append(node);
  $("#chat-log").scrollTop = $("#chat-log").scrollHeight;
  return node;
}

async function sendMessage(text) {
  if (!text.trim()) return;
  appendMessage("user", text);
  HISTORY.push({ role: "user", text });
  const placeholder = appendThinking();
  const button = $("#btn-send");
  button.disabled = true;
  try {
    const result = await api("/api/chat", { message: text, history: HISTORY.slice(0, -1) });
    placeholder.remove();
    appendMessage("assistant", result.reply, result.events || []);
    HISTORY.push({ role: "assistant", text: result.reply });
    if (HISTORY.length > 12) HISTORY = HISTORY.slice(-12);
    STATE = result.state;
    render();
  } catch (error) {
    placeholder.remove();
    appendMessage("assistant", `出错了：${error.message}`);
  } finally {
    button.disabled = false;
    $("#form-chat").message.focus();
  }
}

$("#form-chat").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = event.target.message.value;
  event.target.message.value = "";
  sendMessage(text);
});

// Ctrl/Cmd+Enter 发送
$("#form-chat").message.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    $("#form-chat").requestSubmit();
  }
});

// ── 事件 ────────────────────────────────────────────────────────────────

$("#form-actor").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target).entries());
  try {
    const result = await api("/api/actors", data);
    STATE = result.state;
    render();
    toast(result.message);
    event.target.reset();
  } catch (error) {
    toast(`失败：${error.message}`);
  }
});

$("#form-assertion").addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = Object.fromEntries(new FormData(event.target).entries());
  const payload = {
    entity: raw.entity || undefined,
    from: raw.from,
    action: raw.action,
    to: raw.to,
    by: raw.by,
    guards: String(raw.guards || "").split(";").map((g) => g.trim()).filter(Boolean),
    verify: raw.verify || "",
    source: raw.source || "",
  };
  try {
    const result = await api("/api/assertions", payload);
    STATE = result.state;
    render();
    toast(result.message.split("\n")[0]);
    event.target.reset();
  } catch (error) {
    toast(`失败：${error.message}`, 4000);
  }
});

$("#btn-gate").addEventListener("click", async () => {
  const button = $("#btn-gate");
  button.disabled = true;
  button.textContent = "跑…";
  try {
    const result = await api("/api/gate", {
      repo: $("#gate-repo").value.trim() || ".",
      adapter: $("#gate-adapter").value.trim(),
      strict: false,
    });
    $("#gate-card").classList.remove("hidden");
    $("#gate-output").textContent = result.message;
    $("#gate-card").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    toast(`门禁跑不起来：${error.message}`, 4000);
  } finally {
    button.disabled = false;
    button.textContent = "跑门禁";
  }
});

$("#btn-gate-close").addEventListener("click", () => $("#gate-card").classList.add("hidden"));

async function boot() {
  try {
    MODEL = await api("/api/chat/status");
  } catch {
    MODEL = { available: false };
  }
  await refresh();
  const opening = STATE.assertions.length === 0
    ? "先说一句这个产品是干什么的，以及谁会用它。角色里别忘了没有界面的那种——定时任务、外部回调。"
    : `我看到这份图里有 ${STATE.assertions.length} 条断言、${STATE.issues.length} 个缺口。想先补哪个？`;
  appendMessage("assistant", opening);
}

boot().catch((error) => {
  document.body.innerHTML = `<pre style="padding:24px">加载失败：${error.message}</pre>`;
});
