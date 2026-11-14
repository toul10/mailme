import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IngestInput, IngestResult } from "../../src/domain/types.js";
import { importEmlFiles, listEmlFiles } from "../../src/mail/eml-import.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/imap/", import.meta.url));

function fakeIngest() {
  const inputs: IngestInput[] = [];
  const seen = new Set<string>();
  return {
    inputs,
    async ingest(input: IngestInput): Promise<IngestResult> {
      inputs.push(input);
      const raw = input.source.kind === "mime" ? input.source.raw.toString("latin1") : "";
      if (!/^From:/im.test(raw)) throw new Error("unparseable\nsecond line");
      const id = /^message-id:\s*<([^>]+)>/im.exec(raw)?.[1] ?? raw;
      const created = !seen.has(id);
      seen.add(id);
      return { messageId: id, created, state: "pending", filterReason: null, direction: "INBOUND", threadId: null };
    },
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mailme-eml-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("importEmlFiles", () => {
  it("ingests fixtures via eml_import, counting new, duplicate and failed files", async () => {
    const fx = await listEmlFiles(FIXTURES);
    expect(fx.map((f) => f.slice(FIXTURES.length))).toEqual(["greek-reply.eml", "sent-offer.eml"]);
    const dup = join(dir, "copy.eml");
    await writeFile(dup, await readFile(fx[0]!));
    const broken = join(dir, "broken.eml");
    await writeFile(broken, "garbage without headers");
    const empty = join(dir, "empty.eml");
    await writeFile(empty, "");

    const f = fakeIngest();
    const r = await importEmlFiles(f, "mb-1", [...fx, dup, broken, empty, join(dir, "missing.eml")]);
    expect(r.imported).toBe(2);
    expect(r.duplicates).toBe(1);
    expect(r.errors.map((e) => [e.file.slice(dir.length + 1), e.error])).toEqual([
      ["broken.eml", "unparseable"],
      ["empty.eml", "empty file"],
      ["missing.eml", expect.stringContaining("ENOENT")],
    ]);
    for (const i of f.inputs) {
      expect(i).toMatchObject({ mailboxId: "mb-1", location: null, via: "eml_import" });
      expect(i.source.kind).toBe("mime");
      expect("declaredOutbound" in i).toBe(false);
    }
  });

  it("passes declaredOutbound through and strips an mbox From_ line", async () => {
    const file = join(dir, "sent.eml");
    const body = await readFile(join(FIXTURES, "sent-offer.eml"));
    await writeFile(file, Buffer.concat([Buffer.from("From owner@contoso.example Thu Sep 24 10:00:00 2026\n"), body]));
    const f = fakeIngest();
    const r = await importEmlFiles(f, "mb-1", [file], { declaredOutbound: true });
    expect(r).toEqual({ imported: 1, duplicates: 0, errors: [] });
    expect(f.inputs[0]!.declaredOutbound).toBe(true);
    const raw = (f.inputs[0]!.source as { raw: Buffer }).raw;
    expect(raw.subarray(0, 5).toString()).toBe("From:");
    expect(raw.equals(body)).toBe(true);
  });

  it("listEmlFiles walks sub-directories and ignores other files", async () => {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "a", "b", "x.EML"), "From: a\r\n\r\n");
    await writeFile(join(dir, "a", "note.txt"), "no");
    await writeFile(join(dir, "y.eml"), "From: a\r\n\r\n");
    expect((await listEmlFiles(dir)).map((p) => p.slice(dir.length + 1))).toEqual([join("a", "b", "x.EML"), "y.eml"]);
  });
});
