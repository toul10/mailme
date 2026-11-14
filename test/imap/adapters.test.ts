import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createImapFlowClient } from "../../src/mail/imap/client.js";
import { classifyImapError } from "../../src/mail/imap/errors.js";
import { createNodemailerSession } from "../../src/mail/transport.js";

/**
 * The real adapters against a loopback plaintext server (no external network): a server that cannot do TLS
 * must make connect() reject — never fall back to cleartext, never crash on an unhandled 'error' event.
 */

let server: Server | null = null;
const sockets = new Set<Socket>();

async function listen(onConnection: (s: Socket) => void): Promise<number> {
  server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    onConnection(s);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return typeof addr === "object" && addr ? addr.port : 0;
}

afterEach(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("real adapters refuse cleartext", () => {
  it("ImapFlow with implicit TLS rejects a plaintext server", async () => {
    const port = await listen((s) => s.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n"));
    const client = createImapFlowClient({ host: "127.0.0.1", port, user: "u", pass: "p", mode: "short" });
    const err = await client.connect().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(classifyImapError(err).kind).toBe("tls");
    client.close();
  });

  it("SMTP on 587 fails when the server offers no STARTTLS", async () => {
    const port = await listen((s) => {
      s.write("220 test ESMTP\r\n");
      s.on("data", (chunk) => {
        const line = chunk.toString("latin1");
        if (/^EHLO/i.test(line)) s.write("250-test\r\n250 AUTH PLAIN LOGIN\r\n");
        else if (/^QUIT/i.test(line)) s.end("221 bye\r\n");
        else s.write("502 no\r\n");
      });
    });
    const session = createNodemailerSession({ host: "127.0.0.1", port, implicitTls: false });
    const err = await session.connect().then(
      () => null,
      (e: unknown) => e,
    );
    session.close();
    expect(err).not.toBeNull();
    expect(classifyImapError(err).kind).toBe("tls");
  });
});
