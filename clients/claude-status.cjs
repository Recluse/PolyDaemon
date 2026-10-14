"use strict";

const { realpathSync } = require("node:fs");
const { findOwnPlugin } = require("../hooks/tg-bridge-locate.js");

const unavailable = (state = "unavailable") => ({
  state, topic: null, working: null, pending: null,
  tasks: { state: "unavailable", items: null },
});
const clean = (value, limit = 240) => String(value ?? "")
  .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, limit);

async function readClaudeStatus(cwd, options = {}) {
  if (!process.env.TG_WINDOW_UID) return unavailable("unbound");
  let target;
  try {
    target = (options.locate || findOwnPlugin)(cwd, "claude");
    if (!target || realpathSync(target.cwd) !== realpathSync(cwd)) return unavailable("unbound");
  } catch { return unavailable("unbound"); }
  const request = async path => {
    const response = await (options.fetch || fetch)(`http://${target.host}:${target.port}${path}`, {
      headers: { Authorization: `Bearer ${target.auth_token}` },
      signal: options.signal || AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Status unavailable");
    return response.json();
  };
  // Independent results: a task-router failure does not disconnect the bridge.
  const [status, tasks] = await Promise.allSettled([request("/status"), request("/tasks")]);
  const view = unavailable();
  if (status.status === "fulfilled") {
    const s = status.value;
    if (typeof s?.is_working === "boolean" && s.pending
        && ["approvals", "asks", "plans"].every(k => Array.isArray(s.pending[k]))) {
      view.state = "connected";
      view.working = s.is_working;
      const topic = s.topic;
      if (Number.isSafeInteger(topic?.message_thread_id) && topic.message_thread_id > 0) {
        view.topic = { id: topic.message_thread_id, title: clean(topic.title || s.instance_name) };
      }
      view.pending = { approvals: s.pending.approvals.length,
        questions: s.pending.asks.length, plans: s.pending.plans.length };
    }
  }
  if (tasks.status === "fulfilled") {
    const t = tasks.value;
    if (t?.ok === true && Array.isArray(t.tasks) && t.tasks.every(item =>
      Number.isSafeInteger(item?.id) && item.id > 0
      && ["from", "kind", "text", "state"].every(k => typeof item[k] === "string"))) {
      view.tasks = { state: "available", items: t.tasks.map(item => ({ id: item.id,
        from: clean(item.from), kind: clean(item.kind), text: clean(item.text), state: clean(item.state) })) };
    }
  }
  return view;
}

module.exports = { readClaudeStatus };
if (require.main === module) {
  readClaudeStatus(process.argv[2] || process.cwd()).then(value => {
    process.stdout.write(JSON.stringify(value) + "\n");
  }).catch(() => { process.stdout.write(JSON.stringify(unavailable()) + "\n"); });
}
