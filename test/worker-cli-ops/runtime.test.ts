import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import * as s from "../../src/db/schema.js";
import { loadConfig, type Config } from "../../src/config.js";
import type { Extractor, IngestResult, MailTransport } from "../../src/domain/types.js";
import { sealMailboxPassword } from "../../src/lib/credentials.js";
import { generateSealingKeyPair } from "../../src/lib/sealed.js";
import { nullLogger } from "../../src/lib/log.js";
import { createTestDb, seedOrgUserMailbox, type TestDb } from "../helpers/db.js";

const fakeExtractor: Extractor = { name: "fake", pipelineVersion: "fake-1", extract: async () => { throw new Error("unused"); } };
const fakeTransport: MailTransport = { appendToInbox: async () => ({ alreadyPresent: false, uid: 1, folder: "INBOX" }), sendSmtp: async () => ({ messageId: "x" }) };
let transportOpts: { onLoginAttempt?(mailboxId: string, purpose: "append" | "smtp", outcome: string, detail?: string): void } = {};

vi.mock("../../src/ai/index.js", () => ({ COMPONENT_VERSIONS: {}, createExtractor: vi.fn(() => fakeExtractor) }));
vi.mock("../../src/mail/transport.js", () => ({
  createMailTransport: vi.fn((opts: typeof transportOpts) => {
    transportOpts = opts;
    return fakeTransport;
  }),
}));
vi.mock("../../src/mail/ingest.js", () => ({
  ingestMessage: vi.fn(async (): Promise<IngestResult> => ({ messageId: "m1", created: true, state: "pending", filterReason: null, direction: "INBOUND", threadId: null })),
}));

const { createRuntime, deriveLinkSecret, normalizeLoginOutcome } = await import("../../src/worker/runtime.js");
const { createExtractor } = await import("../../src/ai/index.js");
const { ingestMessage } = await import("../../src/mail/ingest.js");

function keyFiles() {
  const dir = mkdtempSync(path.join(tmpdir(), "mailme-keys-"));
  const pair = generateSealingKeyPair();
  const pub = path.join(dir, "pub.pem");
  const priv = path.join(dir, "key.pem");
  writeFileSync(pub, pair.publicPem);
  writeFileSync(priv, pair.privatePem, { mode: 0o600 });
  return { pub, priv };
}

function cfg(extra: Record<string, string> = {}): Config {
  return loadConfig({
    MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
    APP_SECRET: "x".repeat(40),
    DATABASE_URL: "pglite://memory",
    AI_MODE: "mock",
    PLATFORM_MAIL_DOMAIN: "mailme.test",
    LATE_DISCOVERY_MAX_DAYS: "9",
    ...extra,
  });
}

describe("createRuntime", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await createTestDb();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await t.close();
  });

  it("wires keys, password opening, ingest deps, lazy extractor/transport and login attempts", async () => {
    const k = keyFiles();
    const rt = await createRuntime(cfg({ CREDENTIALS_PUBLIC_KEY_FILE: k.pub, CREDENTIALS_PRIVATE_KEY_FILE: k.priv }), { handle: t, log: nullLogger });
    const { mailbox } = await seedOrgUserMailbox(t.db);
    const sealed = sealMailboxPassword(mailbox, "imap-pass", rt.sealingKeys());
    expect(await rt.getPassword({ ...mailbox, credentialsSealed: sealed.credentialsSealed })).toBe("imap-pass");
    expect(await rt.syncDeps.getPassword({ ...mailbox, credentialsSealed: sealed.credentialsSealed })).toBe("imap-pass");

    await rt.ingest({ mailboxId: mailbox.id, source: { kind: "mime", raw: Buffer.from("x") }, location: null, via: "eml_import" });
    const deps = vi.mocked(ingestMessage).mock.calls[0]![0];
    expect(deps).toMatchObject({ platformMailDomain: "mailme.test", lateDiscoveryMaxDays: 9 });
    expect(deps.db).toBe(t.db);

    expect(createExtractor).not.toHaveBeenCalled();
    expect(rt.pipelineDeps.extractor).toBe(fakeExtractor);
    expect(rt.extractor).toBe(fakeExtractor);
    expect(createExtractor).toHaveBeenCalledTimes(1);

    expect(rt.digestDeps.transport).toBe(fakeTransport);
    transportOpts.onLoginAttempt?.(mailbox.id, "append", "auth", "AUTHENTICATIONFAILED");
    await vi.waitFor(async () => expect(await t.db.select().from(s.mailboxLoginAttempts)).toHaveLength(1));
    const attempts = await t.db.select().from(s.mailboxLoginAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ purpose: "append", outcome: "auth_failed" });

    // withLock is the session lock: re-entrant use of the same key is refused.
    const outer = await rt.pipelineDeps.withLock("drain:x", async () => (await rt.withLock("drain:x", async () => 1)).acquired);
    expect(outer).toEqual({ acquired: true, value: false });
    expect(rt.digestDeps.config.linkSecret).toBe(deriveLinkSecret(rt.config));
  });

  it("requires the private key in eager mode; lazy mode loads keys on demand", async () => {
    const k = keyFiles();
    await expect(createRuntime(cfg({ CREDENTIALS_PUBLIC_KEY_FILE: k.pub }), { handle: t, log: nullLogger })).rejects.toThrow(/CREDENTIALS_PRIVATE_KEY_FILE/);
    const rt = await createRuntime(cfg({ CREDENTIALS_PUBLIC_KEY_FILE: k.pub }), { handle: t, log: nullLogger, keys: "lazy" });
    expect(rt.sealingKeys().privateKey).toBeNull();
    await expect(rt.getPassword({ id: "a", address: "a@b-gr.example", credentialsSealed: "sb1.x" })).rejects.toThrow(/CREDENTIALS_PRIVATE_KEY_FILE/);
    const missing = await createRuntime(cfg({ CREDENTIALS_PUBLIC_KEY_FILE: "/nonexistent/pub.pem" }), { handle: t, log: nullLogger, keys: "lazy" });
    expect(() => missing.sealingKeys()).toThrow();
  });

  it("derives the link secret like the server and normalizes login outcomes", () => {
    const c = cfg();
    expect(deriveLinkSecret(c)).toBe(createHmac("sha256", c.APP_SECRET).update("mailme/link-secret/v1").digest("base64url"));
    expect(deriveLinkSecret(cfg({ LINK_SECRET: "L".repeat(40) }))).toBe("L".repeat(40));
    expect(normalizeLoginOutcome("ok")).toBe("ok");
    expect(normalizeLoginOutcome("too_many")).toBe("too_many");
    expect(normalizeLoginOutcome("weird")).toBe("other");
  });
});
