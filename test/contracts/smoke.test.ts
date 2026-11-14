import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, insertMessage, insertTask, insertThread, seedOrgUserMailbox } from "../helpers/db.js";
import * as s from "../../src/db/schema.js";
import { ExtractionOutput } from "../../src/ai/schema.js";
import { ephemeralSealingKeys, open, seal, sealAad } from "../../src/lib/sealed.js";
import { foldForMatch } from "../../src/lib/text.js";
import { decryptSecret, encryptSecret, signActionToken, verifyActionToken } from "../../src/lib/crypto.js";

describe("contracts smoke", () => {
  it("migrates and seeds on embedded Postgres", async () => {
    const t = await createTestDb();
    const { org, user, mailbox } = await seedOrgUserMailbox(t.db);
    const th = await insertThread(t.db, mailbox.id);
    const m = await insertMessage(t.db, { mailboxId: mailbox.id, threadId: th.id });
    const task = await insertTask(t.db, { orgId: org.id, userId: user.id, mailboxId: mailbox.id, threadId: th.id, messageId: m.id });
    const rows = await t.db.select().from(s.tasks).where(eq(s.tasks.id, task.id));
    expect(rows[0]!.ref).toBe(1);
    await t.close();
  });

  it("parses a valid extraction output", () => {
    const out = ExtractionOutput.parse({
      message_class: "ACTIONABLE",
      suspicious_instructions: false,
      operations: [
        { op: "COMPLETE", task: "K1", evidence: { source: "NEW", segment_id: "S1", quote: "Σας επισυνάπτω την προσφορά" }, certainty: "EXPLICIT", confidence: 0.95, reason: "sent" },
      ],
    });
    expect(out.operations[0]!.op).toBe("COMPLETE");
  });

  it("seals and opens credentials with AAD binding", () => {
    const keys = ephemeralSealingKeys();
    const env = seal("s3cret", keys, sealAad("mb1", "a@b-gr.example"));
    expect(open(env, keys, sealAad("mb1", "a@b-gr.example"))).toBe("s3cret");
    expect(() => open(env, keys, sealAad("mb2", "a@b-gr.example"))).toThrow();
  });

  it("folds Greek text for evidence matching", () => {
    expect(foldForMatch("Σας επισυνάπτω  την ΠΡΟΣΦΟΡΆ")).toBe(foldForMatch("σας επισυναπτω την προσφορα"));
    expect(foldForMatch("τελικός")).toBe("τελικοσ");
  });

  it("encrypts secrets and signs action tokens", () => {
    const key = Buffer.alloc(32, 1).toString("base64");
    expect(decryptSecret(encryptSecret("x", key), key)).toBe("x");
    const tok = signActionToken({ t: "task", a: "complete", u: "user", exp: 2000 }, "secret");
    expect(verifyActionToken(tok, "secret", 1000)?.t).toBe("task");
    expect(verifyActionToken(tok, "secret", 3000)).toBeNull();
    expect(verifyActionToken(tok + "x", "secret", 1000)).toBeNull();
  });
});
