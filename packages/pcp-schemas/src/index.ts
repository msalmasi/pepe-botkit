/**
 * PCP (Pepe Connector Protocol) schema loader and frame validator.
 *
 * Loads every *.schema.json under the schema directory into one Ajv (draft 2020-12) instance and
 * validates whole frames against frame.schema.json, which dispatches on `op` and then on `type`.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ErrorObject, ValidateFunction } from "ajv";

const require = createRequire(import.meta.url);
// ajv and ajv-formats are CommonJS; load them through require to avoid default-export interop issues.
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;

export type FrameOp = "hello" | "welcome" | "event" | "action" | "result" | "ack" | "ping" | "pong" | "flow" | "bye";

export interface PcpIndex {
  pcp: string;
  base: string;
  defs: string;
  envelope: string;
  frame: string;
  error: string;
  capabilities: string;
  control: Record<string, string>;
  events: Record<string, { schema: string; requires_room: boolean; priority: "low" | "normal" | "critical" }>;
  actions: Record<string, { schema: string; requires_room: boolean; result: string }>;
  results: Record<string, string>;
}

export interface PcpValidationError {
  /** JSON pointer into the frame, e.g. "/data/user/id". */
  path: string;
  message: string;
  keyword: string;
  schemaPath: string;
}

export interface ValidationResult {
  valid: boolean;
  /** False when the frame's event/action type is not in this schema version (still valid if the envelope is). */
  known: boolean;
  errors: PcpValidationError[];
}

/** repo/schemas, resolved from this file (dist/src/index.js) unless PCP_SCHEMA_DIR is set. */
export function defaultSchemaDir(): string {
  if (process.env.PCP_SCHEMA_DIR) return process.env.PCP_SCHEMA_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "..", "..", "schemas");
}

function listSchemaFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSchemaFiles(p));
    else if (entry.name.endsWith(".schema.json")) out.push(p);
  }
  return out.sort();
}

function toErrors(errors: ErrorObject[] | null | undefined): PcpValidationError[] {
  return (errors ?? [])
    .filter((e) => e.keyword !== "if") // "must match then schema" wrappers; the leaf errors follow
    .map((e) => ({
      path: e.instancePath || "/",
      message: e.message ?? e.keyword,
      keyword: e.keyword,
      schemaPath: e.schemaPath,
    }));
}

export class PcpValidator {
  readonly index: PcpIndex;
  readonly schemaDir: string;
  private readonly ajv: any;
  private readonly frameFn: ValidateFunction;

  constructor(schemaDir: string = defaultSchemaDir()) {
    this.schemaDir = schemaDir;
    this.index = JSON.parse(fs.readFileSync(path.join(schemaDir, "index.json"), "utf8"));
    this.ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
    addFormats(this.ajv);
    for (const file of listSchemaFiles(schemaDir)) {
      this.ajv.addSchema(JSON.parse(fs.readFileSync(file, "utf8")));
    }
    this.frameFn = this.compile(this.index.frame);
  }

  private compile(rel: string): ValidateFunction {
    const id = this.index.base + rel;
    const fn = this.ajv.getSchema(id);
    if (!fn) throw new Error(`schema not loaded: ${id}`);
    return fn;
  }

  /** Is this frame's type defined in the loaded schema version? Control frames are always known. */
  isKnown(frame: any): boolean {
    if (!frame || typeof frame !== "object") return false;
    if (frame.op === "event") return frame.type in this.index.events;
    if (frame.op === "action" || frame.op === "result") return frame.type in this.index.actions;
    return frame.op in this.index.control;
  }

  /** Validate one complete frame (any op). */
  validateFrame(frame: unknown): ValidationResult {
    const valid = this.frameFn(frame) as boolean;
    return { valid, known: this.isKnown(frame), errors: valid ? [] : toErrors(this.frameFn.errors) };
  }

  /** Validate just the data payload of an event, action or (successful, final) result. */
  validateData(kind: "event" | "action" | "result", type: string, data: unknown): ValidationResult {
    let rel: string | undefined;
    if (kind === "event") rel = this.index.events[type]?.schema;
    else if (kind === "action") rel = this.index.actions[type]?.schema;
    else {
      const r = this.index.actions[type]?.result;
      rel = r ? this.index.results[r] : undefined;
    }
    if (!rel) return { valid: false, known: false, errors: [{ path: "/", message: `unknown ${kind} type ${type}`, keyword: "type", schemaPath: "" }] };
    const fn = this.compile(rel);
    const valid = fn(data) as boolean;
    return { valid, known: true, errors: valid ? [] : toErrors(fn.errors) };
  }

  /** Throwing variant for connectors/runtimes that want fail-fast in development. */
  assertFrame(frame: unknown): void {
    const r = this.validateFrame(frame);
    if (!r.valid) {
      const lines = r.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
      throw new Error(`invalid PCP frame:\n${lines}`);
    }
  }
}

export const SUBPROTOCOL = "pcp.v1";
