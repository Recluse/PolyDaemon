"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { matchRow } = require("./tg-bridge-locate.js");

const bridge = { cwd: path.resolve("/work/bridge"), workspace_name: "bridge-codex", parent_pid: 123 };
const project = { cwd: path.resolve("/work/sample-project"), workspace_name: "sample-project-codex", parent_pid: 123 };
const rootless = { cwd: path.parse(process.cwd()).root, workspace_name: "", parent_pid: 123 };
const ctx = { parentPid: 123, windowUid: "", agent: "codex" };
if (process.platform !== 'win32') {
  const upper = { ...project, cwd: '/nonexistent-case-fixture/Project' };
  const lower = { ...project, cwd: '/nonexistent-case-fixture/project' };
  assert.equal(matchRow([upper, lower], lower.cwd, ctx), lower);
  assert.equal(matchRow([lower, upper], upper.cwd, ctx), upper);
}
if (process.platform === 'win32') {
  const normalized = { ...project, cwd: project.cwd.toUpperCase().replace(/\\/g, '/') };
  assert.equal(matchRow([bridge, normalized], project.cwd, ctx), normalized);
}
assert.equal(matchRow([bridge, rootless, project], "/work/sample-project/src", ctx), project);
assert.equal(matchRow([bridge, project], "/outside", ctx), null);
assert.equal(matchRow([project], "/outside", ctx), project);
assert.equal(matchRow([rootless], "/outside", { ...ctx, agent: "claude" }), null);

const claude = { ...project, workspace_name: "sample-project" };
assert.equal(matchRow([claude, project], "/work/sample-project", ctx), project);
assert.equal(matchRow([project, claude], "/work/sample-project", { ...ctx, agent: "claude" }), claude);
assert.equal(matchRow([{ ...project, parent_pid: 1 }], project.cwd, ctx), null);
const owned = { ...project, window_uid: "own" };
assert.equal(matchRow([project, owned], project.cwd, { ...ctx, windowUid: "own" }), owned);
assert.equal(matchRow([project], project.cwd, { ...ctx, windowUid: "missing" }), null);
const opencode = { ...owned, workspace_name: "sample-project-opencode" };
assert.equal(matchRow([opencode, claude, project], project.cwd, { ...ctx, agent: "opencode" }), opencode);
assert.equal(matchRow([opencode, claude], project.cwd, { ...ctx, agent: "claude" }), claude);
console.log("plugin routing self-check OK");
const mimo = { ...owned, workspace_name: "sample-project-mimo" };
assert.equal(matchRow([opencode, mimo, claude], project.cwd, { ...ctx, agent: "mimo" }), mimo);
assert.equal(matchRow([mimo, claude], project.cwd, { ...ctx, agent: "claude" }), claude);

// Ambiguity is refused, never resolved to the first row.
const twin = { ...project, parent_pid: 456 };
const third = { ...project, parent_pid: 789 };
assert.equal(matchRow([twin, third], project.cwd, ctx), null, "two windows in one folder, neither ours");
assert.equal(matchRow([twin, project], project.cwd, ctx), project, "our own plugin (same parent) is exact");
const copyA = { ...project, window_uid: "dup", parent_pid: 456 };
const copyB = { ...project, window_uid: "dup", parent_pid: 789 };
assert.equal(matchRow([copyA, copyB], project.cwd, { ...ctx, windowUid: "dup" }), null, "one uid on two rows");
console.log("ambiguity self-check OK");

// A hook whose cwd is another window's folder still belongs to its own window.
const ownA = { ...project, cwd: path.resolve("/work/a"), parent_pid: 123 };
const otherB = { ...project, cwd: path.resolve("/work/b"), parent_pid: 456 };
assert.equal(matchRow([ownA, otherB], "/work/b", ctx), ownA);
console.log("own-parent self-check OK");
