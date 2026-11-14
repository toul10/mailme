import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IngestInput, IngestResult } from "../domain/types.js";

/** Larger files are rejected (the ingest API caps uploads at 10 MB; this only guards memory). */
export const MAX_EML_BYTES = 50 * 1024 * 1024;

/** mbox exports start with an envelope line ("From sender@x Tue Sep 24 …") that is not a header. */
function stripMboxFromLine(raw: Buffer): Buffer {
  if (raw.length < 5 || raw.subarray(0, 5).toString("latin1") !== "From ") return raw;
  const nl = raw.indexOf(0x0a);
  return nl === -1 ? raw : raw.subarray(nl + 1);
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.split(/\r?\n/)[0]!.slice(0, 200);
}

/** Import .eml files (fixtures, one-off history) through the normal ingest path. */
export async function importEmlFiles(deps: { ingest(input: IngestInput): Promise<IngestResult> }, mailboxId: string, files: string[], opts: { declaredOutbound?: boolean } = {}): Promise<{ imported: number; duplicates: number; errors: Array<{ file: string; error: string }> }> {
  let imported = 0;
  let duplicates = 0;
  const errors: Array<{ file: string; error: string }> = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error("not a file");
      if (info.size === 0) throw new Error("empty file");
      if (info.size > MAX_EML_BYTES) throw new Error(`file larger than ${MAX_EML_BYTES} bytes`);
      const raw = stripMboxFromLine(await readFile(file));
      const res = await deps.ingest({
        mailboxId,
        source: { kind: "mime", raw },
        location: null,
        via: "eml_import",
        ...(opts.declaredOutbound ? { declaredOutbound: true } : {}),
      });
      if (res.created) imported++;
      else duplicates++;
    } catch (err) {
      errors.push({ file, error: shortError(err) });
    }
  }
  return { imported, duplicates, errors };
}

/** All `*.eml` files under `dir` (recursive), sorted by path — for `pnpm cli import:eml <dir>`. */
export async function listEmlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".eml")) out.push(p);
    }
  };
  await walk(dir);
  return out.sort();
}
