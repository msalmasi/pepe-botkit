import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { PcpValidator, defaultSchemaDir } from "../src/index.js";
import { SchemaSet, fieldsOnlyIn } from "./compat.js";

const repo = path.resolve(defaultSchemaDir(), "..");
const samplesDir = path.join(repo, "samples");
const validator = new PcpValidator();

interface SampleFile {
  description: string;
  frames: { dir: "c2r" | "r2c"; note?: string; frame: any }[];
}
interface BadSample {
  description: string;
  expect_path: string;
  frame: any;
}

function jsonFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f));
}

// Every samples/<dir> except invalid/ holds valid sessions (camfrog, discord, twitch, bridge, ...).
const validDirs = fs
  .readdirSync(samplesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== "invalid")
  .map((e) => path.join(samplesDir, e.name))
  .sort();
const validFiles = validDirs.flatMap(jsonFiles);
const badFiles = jsonFiles(path.join(samplesDir, "invalid"));

test("generated dispatch schemas are up to date", () => {
  const script = path.join(repo, "scripts", "gen-dispatch.mjs");
  execFileSync(process.execPath, [script, "--check"], { stdio: "pipe" });
});

test("there are samples", () => {
  assert.ok(validFiles.length >= 10, `only ${validFiles.length} valid sample files`);
  assert.ok(badFiles.length >= 10, `only ${badFiles.length} invalid sample files`);
});

for (const file of validFiles) {
  const rel = path.relative(repo, file).replace(/\\/g, "/");
  test(`valid: ${rel}`, () => {
    const sample: SampleFile = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(sample.description, "sample needs a description");
    assert.ok(Array.isArray(sample.frames) && sample.frames.length > 0, "sample needs frames");
    sample.frames.forEach((entry, i) => {
      assert.ok(entry.dir === "c2r" || entry.dir === "r2c", `frame ${i}: dir must be c2r or r2c`);
      const r = validator.validateFrame(entry.frame);
      const why = r.errors.map((e) => `${e.path} ${e.message}`).join("; ");
      assert.ok(r.valid, `frame ${i} (${entry.frame?.op} ${entry.frame?.type ?? ""}) invalid: ${why}`);
      assert.ok(r.known, `frame ${i} uses a type not in index.json: ${entry.frame?.type}`);
    });
  });
}

for (const file of badFiles) {
  const rel = path.relative(repo, file).replace(/\\/g, "/");
  test(`invalid: ${rel}`, () => {
    const bad: BadSample = JSON.parse(fs.readFileSync(file, "utf8"));
    const r = validator.validateFrame(bad.frame);
    assert.equal(r.valid, false, `expected rejection: ${bad.description}`);
    const paths = r.errors.map((e) => e.path);
    assert.ok(
      paths.some((p) => p.startsWith(bad.expect_path)),
      `expected an error at ${bad.expect_path}, got: ${paths.join(", ")}`,
    );
  });
}

test("every event, action and control frame type has at least one sample", () => {
  const seen = new Set<string>();
  for (const file of validFiles) {
    const sample: SampleFile = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const { frame } of sample.frames) {
      if (frame.op === "event" || frame.op === "action") seen.add(`${frame.op}:${frame.type}`);
      else seen.add(`op:${frame.op}`);
    }
  }
  const missing = [
    ...Object.keys(validator.index.events).map((t) => `event:${t}`),
    ...Object.keys(validator.index.actions).map((t) => `action:${t}`),
    ...["hello", "welcome", "result", "ack", "ping", "pong", "flow", "bye"].map((o) => `op:${o}`),
  ].filter((k) => !seen.has(k));
  assert.deepEqual(missing, [], `types without a sample: ${missing.join(", ")}`);
});

test("every result answers an action in the same sample file, with the same type", () => {
  for (const file of validFiles) {
    const sample: SampleFile = JSON.parse(fs.readFileSync(file, "utf8"));
    const actions = new Map<string, string>();
    for (const { frame } of sample.frames) if (frame.op === "action") actions.set(frame.id, frame.type);
    for (const { frame } of sample.frames) {
      if (frame.op !== "result") continue;
      assert.equal(actions.get(frame.ref), frame.type, `${path.basename(file)}: result ${frame.id} ref=${frame.ref}`);
    }
  }
});

test("standard type names have no underscores (so mic_grab <-> mic.grab maps unambiguously)", () => {
  const names = [...Object.keys(validator.index.events), ...Object.keys(validator.index.actions)];
  const bad = names.filter((n) => !/^[a-z]+(\.[a-z]+)*$/.test(n));
  assert.deepEqual(bad, []);
});

/** "1.10" > "1.9": compare MAJOR.MINOR numerically. */
function minorOf(v: string): number {
  const [major, minor] = v.split(".").map(Number);
  assert.equal(major, 1, `unexpected major in ${v}`);
  return minor;
}

test("index.json is PCP 1.1; 1.1 types carry since 1.1 and 1.0 types none", () => {
  assert.equal(validator.index.pcp, "1.1");
  const entries = [...Object.entries(validator.index.events), ...Object.entries(validator.index.actions)];
  for (const [name, entry] of entries) {
    if (entry.since !== undefined) assert.ok(minorOf(entry.since) >= 1, `${name}: since ${entry.since}`);
    assert.ok(entry.since === undefined || minorOf(entry.since) <= minorOf(validator.index.pcp), `${name}: since ${entry.since} > ${validator.index.pcp}`);
  }
  const added = entries.filter(([, e]) => e.since === "1.1").map(([n]) => n);
  assert.ok(added.length >= 25, `only ${added.length} types marked since 1.1`);
  for (const t of ["message", "send", "reaction", "mic.grab", "audio.play"]) {
    const e = (validator.index.events as any)[t] ?? (validator.index.actions as any)[t];
    assert.equal(e.since, undefined, `${t} is a 1.0 type`);
  }
});

test("a session negotiated at 1.0 uses no type added after 1.0 once welcomed", () => {
  let checked = 0;
  for (const file of validFiles) {
    const sample: SampleFile = JSON.parse(fs.readFileSync(file, "utf8"));
    let negotiated: number | undefined;
    for (const { frame } of sample.frames) {
      if (frame.op === "welcome") negotiated = minorOf(frame.data.pcp);
      if (negotiated === undefined || (frame.op !== "event" && frame.op !== "action" && frame.op !== "result")) continue;
      const entry = frame.op === "event" ? validator.index.events[frame.type] : validator.index.actions[frame.type];
      const since = entry?.since ? minorOf(entry.since) : 0;
      assert.ok(since <= negotiated, `${path.basename(file)}: ${frame.op} ${frame.type} (since 1.${since}) in a 1.${negotiated} session`);
      checked++;
    }
  }
  assert.ok(checked > 0, "no sample negotiates a version");
});

// The frozen PCP 1.0 schemas (git 501e5b0), for the field-level 1.0 compatibility check.
const compat10Dir = path.join(repo, "compat", "pcp-1.0", "schemas");
const v10 = new PcpValidator(compat10Dir);
const set10 = new SchemaSet(compat10Dir);
const set11 = new SchemaSet(defaultSchemaDir());

test("a session negotiated at 1.0 carries no 1.1 field once welcomed, and validates against the 1.0 schemas", () => {
  assert.equal(v10.index.pcp, "1.0");
  let checked = 0;
  for (const file of validFiles) {
    const sample: SampleFile = JSON.parse(fs.readFileSync(file, "utf8"));
    let negotiated: number | undefined;
    sample.frames.forEach(({ frame }, i) => {
      if (frame.op === "hello") negotiated = undefined;
      if (frame.op === "welcome") negotiated = minorOf(frame.data.pcp);
      if (negotiated !== 0) return;
      const where = `${path.basename(file)} frame ${i} (${frame.op} ${frame.type ?? ""})`;
      const r = v10.validateFrame(frame);
      assert.ok(r.valid && r.known, `${where}: not valid 1.0: ${r.errors.map((e) => `${e.path} ${e.message}`).join("; ")}`);
      assert.deepEqual(fieldsOnlyIn(set11, set10, frame), [], `${where} carries 1.1 fields`);
      checked++;
    });
  }
  assert.ok(checked >= 5, `only ${checked} frames of 1.0 sessions checked`);
});

test("the 1.1-field check finds 1.1 fields, elements and types", () => {
  const send = {
    op: "action", id: "r-1", ts: "2026-10-18T18:00:00.000Z", type: "send",
    scope: { platform: "discord", room: { id: "1100000000000000010" } },
    data: { text: "hi" },
  };
  assert.deepEqual(fieldsOnlyIn(set11, set10, send), []);
  assert.deepEqual(fieldsOnlyIn(set11, set10, { ...send, target: "native" }), ["/target"]);
  assert.deepEqual(
    fieldsOnlyIn(set11, set10, { ...send, data: { text: "hi", relay: { msg_id: "m", binding: "b" } } }),
    ["/data/relay"],
  );
  assert.deepEqual(
    fieldsOnlyIn(set11, set10, { ...send, data: { text: "x", content: [{ type: "code_block", text: "x", lang: "js" }] } }),
    ["/data/content/0/text", "/data/content/0/lang"],
  );
  const result = {
    op: "result", id: "c-1", ts: "2026-10-18T18:00:00.000Z", seq: 1, ref: "r-1", type: "send", ok: true,
    data: { message_ids: ["m-1"], parts: 1, t: { wait_ms: 1, send_ms: 2 } },
  };
  assert.deepEqual(fieldsOnlyIn(set11, set10, result), ["/data/t"]);
  const msg = {
    op: "event", id: "c-2", ts: "2026-10-18T18:00:00.000Z", seq: 2, type: "message", connector: "dc",
    scope: { platform: "discord", room: { id: "1" } },
    data: { user: { id: "1", anonymous: true }, text: "hi", ext: { discord: { anything: 1 } } },
  };
  assert.deepEqual(fieldsOnlyIn(set11, set10, msg), ["/data/user/anonymous"]);
});

test("every type added in 1.1 has at least one invalid sample", () => {
  const seen = new Set<string>();
  for (const file of badFiles) {
    const { frame } = JSON.parse(fs.readFileSync(file, "utf8")) as BadSample;
    if (frame.op === "event") seen.add(`event:${frame.type}`);
    if (frame.op === "action" || frame.op === "result") seen.add(`action:${frame.type}`);
  }
  const missing = [
    ...Object.entries(validator.index.events).filter(([, e]) => e.since === "1.1").map(([t]) => `event:${t}`),
    ...Object.entries(validator.index.actions).filter(([, e]) => e.since === "1.1").map(([t]) => `action:${t}`),
  ].filter((k) => !seen.has(k));
  assert.deepEqual(missing, [], `1.1 types without an invalid sample: ${missing.join(", ")}`);
});

test("relay parts are numbered 1..of", () => {
  let parts = 0;
  for (const file of validFiles) {
    const sample: SampleFile = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const { frame } of sample.frames) {
      const part = frame.op === "action" ? frame.data?.relay?.part : undefined;
      if (!part) continue;
      assert.ok(part.n >= 1 && part.n <= part.of, `${path.basename(file)} ${frame.id}: part ${part.n} of ${part.of}`);
      parts++;
    }
  }
  assert.ok(parts > 0, "no sample relays a split line");
});

test("message.reaction replaces reaction only when the runtime subscribes to it by name", () => {
  for (const file of validFiles) {
    const sample: SampleFile = JSON.parse(fs.readFileSync(file, "utf8"));
    let subscribe: string[] | undefined;
    let welcomed = false;
    for (const { frame } of sample.frames) {
      if (frame.op === "hello") welcomed = false;
      if (frame.op === "welcome") {
        welcomed = true;
        subscribe = frame.data.subscribe;
      }
      if (!welcomed || frame.op !== "event") continue;
      const wantsNew = !!subscribe?.includes("message.reaction");
      const wantsOld = !subscribe || subscribe.includes("reaction");
      if (frame.type === "message.reaction")
        assert.ok(wantsNew, `${path.basename(file)} ${frame.id}: message.reaction without welcome.subscribe naming it`);
      if (frame.type === "reaction")
        assert.ok(wantsOld, `${path.basename(file)} ${frame.id}: reaction although subscribe names message.reaction and not reaction`);
    }
  }
});

test("identity hash test vector (§15.1)", () => {
  const item = (key: string, platform: string, id: string) =>
    crypto.createHmac("sha256", Buffer.from(key, "ascii")).update(`${platform}:${id}`, "utf8").digest("hex").slice(0, 20);
  assert.equal(item("pcp-1.1-test-key", "camfrog", "lilypadlou"), "f84004d41a6a8ddaf206");
  assert.equal(item("pcp-1.1-test-key", "camfrog", "LilyPadLou"), "59f5b268a7e190753538");
  const spec = fs.readFileSync(path.join(repo, "spec", "PCP.md"), "utf8");
  assert.ok(spec.includes("f84004d41a6a8ddaf206") && spec.includes("59f5b268a7e190753538"), "spec states the vector");
});

test("validateData works per type", () => {
  assert.equal(validator.validateData("event", "mic.grab", { user: { id: "someone" } }).valid, true);
  assert.equal(validator.validateData("event", "mic.grab", {}).valid, false);
  assert.equal(validator.validateData("result", "sticker.send", { posted: null }).valid, true);
  assert.equal(validator.validateData("action", "nope", {}).known, false);
  assert.equal(validator.validateData("result", "interaction.followup", { message_ids: ["m-1"] }).valid, true);
  assert.equal(validator.validateData("event", "room.state", { full: true }).valid, false);
});

test("unknown future event types pass on a well-formed envelope (forward compatibility)", () => {
  const r = validator.validateFrame({
    op: "event", id: "evt-future-1", ts: "2026-10-05T18:00:00.000Z", seq: 7, type: "poll.vote",
    connector: "cf-main", scope: { platform: "camfrog" }, data: { anything: true }, new_field: 1,
  });
  assert.equal(r.valid, true);
  assert.equal(r.known, false);
});
