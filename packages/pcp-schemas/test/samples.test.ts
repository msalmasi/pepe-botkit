import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PcpValidator, defaultSchemaDir } from "../src/index.js";

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

const validDirs = ["camfrog", "discord", "twitch"].map((d) => path.join(samplesDir, d));
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

test("validateData works per type", () => {
  assert.equal(validator.validateData("event", "mic.grab", { user: { id: "someone" } }).valid, true);
  assert.equal(validator.validateData("event", "mic.grab", {}).valid, false);
  assert.equal(validator.validateData("result", "sticker.send", { posted: null }).valid, true);
  assert.equal(validator.validateData("action", "nope", {}).known, false);
});

test("unknown future event types pass on a well-formed envelope (forward compatibility)", () => {
  const r = validator.validateFrame({
    op: "event", id: "evt-future-1", ts: "2026-10-05T18:00:00.000Z", seq: 7, type: "poll.vote",
    connector: "cf-main", scope: { platform: "camfrog" }, data: { anything: true }, new_field: 1,
  });
  assert.equal(r.valid, true);
  assert.equal(r.known, false);
});
