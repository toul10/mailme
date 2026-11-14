import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../../src/db/schema.js";
import { drainMailbox } from "../../../src/engine/pipeline.js";
import { nullLogger } from "../../../src/lib/log.js";
import type { ImapClientLike, ImapConnectOptions } from "../../../src/mail/imap/client.js";
import { syncMailboxOnce } from "../../../src/mail/imap/sync.js";
import { ingestMessage } from "../../../src/mail/ingest.js";
import { fakeExtractor, okResult, output, pipelineDeps } from "../../engine-db/fixtures.js";
import { makeEml } from "../../imap/fake-imap.js";
import { NOW, setupEnv, type Env } from "../../imap/helpers.js";

let env: Env;
beforeEach(async () => {
  env = await setupEnv();
  const ingestDeps = { db: env.t.db, clock: env.clock, log: nullLogger, platformMailDomain: "mailme.local", lateDiscoveryMaxDays: 7 };
  env.deps.ingest = (input) => ingestMessage(ingestDeps, input);
});
afterEach(() => env.t.close());

describe("settle-uses-cycle-finish", () => {
  it("a reply first seen during a full cycle, after Sent was scanned, is not 'covered' by that cycle", async () => {
    const T0 = NOW.getTime();
    // The customer's reply, filed by a server rule into INBOX.Πελάτες ("Customers").
    env.server.addMessage("INBOX.Πελάτες", {
      uid: 1,
      raw: makeEml({ messageId: "reply-1@abc-gr.example", subject: "RE: Προσφορά Χ200", body: "Το λάβαμε, ευχαριστούμε. Θα σας απαντήσουμε αύριο.", extraHeaders: ["In-Reply-To: <offer-x200@contoso.example>", "Delivered-To: owner@contoso.example"] }),
      internalDate: new Date(T0 + 1_000),
    });
    // Sent is scanned first in the cycle (folderOrder). When the cycle reaches INBOX.Πελάτες (T0+2 s),
    // Outlook finishes its late APPEND of the owner's offer into Sent: Sent is not scanned again this cycle.
    const inner = env.server.factory;
    env.deps.imapFactory = (opts: ImapConnectOptions): ImapClientLike => {
      const c = inner(opts);
      const open = c.mailboxOpen.bind(c);
      c.mailboxOpen = async (p, o) => {
        if (p === "INBOX.Πελάτες") {
          env.clock.advance(2_000);
          env.server.addMessage("INBOX.Sent", {
            raw: makeEml({ messageId: "offer-x200@contoso.example", from: "Owner <owner@contoso.example>", to: "client@abc-gr.example", subject: "Προσφορά Χ200", date: new Date(T0 - 60_000), body: "Σας επισυνάπτω την προσφορά." }),
            internalDate: new Date(T0 + 2_000),
          });
        }
        return open(p, o);
      };
      return c;
    };

    const report = await syncMailboxOnce(env.deps, env.mailboxId);
    expect(report.fullCycle).toBe(true);
    const [mb] = await env.t.db.select().from(s.mailboxes).where(eq(s.mailboxes.id, env.mailboxId));
    const [reply] = await env.t.db.select().from(s.messages).where(eq(s.messages.messageKey, "reply-1@abc-gr.example"));
    expect(reply!.state).toBe("pending");
    const [offer] = await env.t.db.select().from(s.messages).where(eq(s.messages.messageKey, "offer-x200@contoso.example"));
    expect(offer).toBeUndefined(); // not synced yet: Sent's next scan is FOLDER_POLL_SEC (300 s) later

    // SETTLE_SEC (180) later — still before the next full cycle — the worker drains with fullCycleAt = lastSyncAt
    // (drainTick) or report.finishedAt (onCycle): both are the cycle's END.
    env.clock.advance(181_000);
    const extractor = fakeExtractor(() => okResult(output([], "FYI")));
    await drainMailbox(pipelineDeps(env.t, extractor, { now: () => env.clock.now(), set() {}, advance() {} }), env.mailboxId, { fullCycleAt: mb!.lastSyncAt ?? report.finishedAt });
    // The reply must wait until a cycle that started after it was first seen has covered Sent.
    expect(extractor.calls).toHaveLength(0);
  });
});
