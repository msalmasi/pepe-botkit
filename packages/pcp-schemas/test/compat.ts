/**
 * Test helper: find fields a 1.1 schema set defines but a 1.0 set does not, in one frame.
 *
 * Both schema sets allow unknown properties (spec/PCP.md §14), so validating a frame against the 1.0
 * schemas cannot prove that it carries no 1.1 field. This walks the frame along both sets at once,
 * following $ref, allOf/anyOf/oneOf and if/then/else (taking a branch when its `if` can be decided
 * from const/enum/required, both branches otherwise), and reports every key that the 1.1 schemas
 * name at that place while the 1.0 schemas neither name it nor allow it as a map value. A 1.1
 * element type shows up the same way: its fields are named only by the 1.1 Element branch.
 */
import fs from "node:fs";
import path from "node:path";

type Json = any;
interface Node {
  s: Json;
  base: string;
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

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** true / false when an `if` schema can be decided from const, enum and required; undefined otherwise. */
function ifMatches(cond: Json, data: unknown): boolean | undefined {
  if (!isObj(cond) || !isObj(data)) return undefined;
  let unknown = false;
  for (const [k, v] of Object.entries(cond)) {
    if (k === "required") {
      if ((v as string[]).some((r) => !(r in data))) return false;
    } else if (k === "properties") {
      for (const [p, sub] of Object.entries(v as Record<string, Json>)) {
        if (!(p in data)) continue;
        const keys = Object.keys(sub).filter((x) => x !== "description" && x !== "$comment");
        if ("const" in sub && !deepEqual(sub.const, data[p])) return false;
        if (Array.isArray(sub.enum) && !sub.enum.some((e: unknown) => deepEqual(e, data[p]))) return false;
        if (keys.some((x) => x !== "const" && x !== "enum")) unknown = true;
      }
    } else if (k !== "description" && k !== "$comment") unknown = true;
  }
  return unknown ? undefined : true;
}

export class SchemaSet {
  private readonly byId = new Map<string, Json>();
  readonly root: Node;

  constructor(schemaDir: string) {
    for (const file of listSchemaFiles(schemaDir)) {
      const s = JSON.parse(fs.readFileSync(file, "utf8"));
      this.byId.set(s.$id, s);
    }
    const index = JSON.parse(fs.readFileSync(path.join(schemaDir, "index.json"), "utf8"));
    this.root = { s: this.byId.get(index.base + index.frame), base: index.base + index.frame };
  }

  private resolve(ref: string, base: string): Node {
    const url = new URL(ref, base);
    const frag = decodeURIComponent(url.hash.slice(1));
    url.hash = "";
    let s = this.byId.get(url.href);
    if (s === undefined) throw new Error(`unresolved $ref ${ref} from ${base}`);
    for (const part of frag.split("/").slice(1)) s = s[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    return { s, base: url.href };
  }

  /** Every schema object that applies to `data` at this place. */
  expand(n: Node, data: unknown, out: Node[] = [], depth = 0): Node[] {
    if (!isObj(n.s) || depth > 64) return out;
    const s = n.s;
    const base = typeof s.$id === "string" ? new URL(s.$id, n.base).href : n.base;
    out.push({ s, base });
    if (typeof s.$ref === "string") this.expand(this.resolve(s.$ref, base), data, out, depth + 1);
    for (const k of ["allOf", "anyOf", "oneOf"])
      for (const sub of (s[k] as Json[] | undefined) ?? []) this.expand({ s: sub, base }, data, out, depth + 1);
    if (s.if !== undefined) {
      const m = ifMatches(s.if, data);
      if (m !== false && s.then) this.expand({ s: s.then, base }, data, out, depth + 1);
      if (m !== true && s.else) this.expand({ s: s.else, base }, data, out, depth + 1);
    }
    return out;
  }
}

interface Props {
  named: Map<string, Node[]>;
  values: Node[];
  items: Node[];
}
function props(nodes: Node[]): Props {
  const p: Props = { named: new Map(), values: [], items: [] };
  for (const { s, base } of nodes) {
    if (isObj(s.properties))
      for (const [k, sub] of Object.entries(s.properties)) {
        if (!p.named.has(k)) p.named.set(k, []);
        p.named.get(k)!.push({ s: sub, base });
      }
    if (isObj(s.additionalProperties)) p.values.push({ s: s.additionalProperties, base });
    if (isObj(s.items)) p.items.push({ s: s.items, base });
  }
  return p;
}

/** JSON pointers of the keys in `frame` that only `newer` defines. */
export function fieldsOnlyIn(newer: SchemaSet, older: SchemaSet, frame: unknown): string[] {
  const found: string[] = [];
  const walk = (data: unknown, nNew: Node[], nOld: Node[], at: string) => {
    const eNew = nNew.flatMap((n) => newer.expand(n, data));
    const eOld = nOld.flatMap((n) => older.expand(n, data));
    const pNew = props(eNew);
    const pOld = props(eOld);
    if (Array.isArray(data)) {
      data.forEach((item, i) => walk(item, pNew.items, pOld.items, `${at}/${i}`));
    } else if (isObj(data)) {
      for (const [k, v] of Object.entries(data)) {
        const inNew = pNew.named.get(k);
        const inOld = pOld.named.get(k);
        if (inNew && !inOld && pOld.values.length === 0) {
          found.push(`${at}/${k}`);
          continue;
        }
        const cNew = inNew ?? pNew.values;
        const cOld = inOld ?? pOld.values;
        if (cNew.length && cOld.length) walk(v, cNew, cOld, `${at}/${k}`);
      }
    }
  };
  walk(frame, [newer.root], [older.root], "");
  return found;
}
