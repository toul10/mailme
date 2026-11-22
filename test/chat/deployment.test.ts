import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { AI_KEY_ENV } from "../../src/ai/providers.js";
import { CHAT_KEY_ENV } from "../../src/chat/model.js";
import { loadConfig } from "../../src/config.js";

/**
 * Who holds which AI key. The worker's keys (Admin → AI, or its environment) never reach the API; the chat's key is
 * the API's alone, and only where the chat is switched on. The shipped files must say the same thing as the code
 * (no YAML dependency: the service blocks are read with a regex, as in test/regression/server-security).
 */
const root = path.resolve(__dirname, "../..");
const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
const envExample = readFileSync(path.join(root, ".env.example"), "utf8");

function serviceBlock(name: string): string {
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|^\\S)`, "m").exec(compose);
  if (!m) throw new Error(`service ${name} not found in docker-compose.yml`);
  return m[1]!;
}
const blanks = (block: string, name: string) => new RegExp(`^\\s+${name}: ""$`, "m").test(block);

describe("the chat's key in the shipped deployment files", () => {
  it("docker compose: the worker's keys stay out of the API, and the chat's key stays out of the worker and the migrations", () => {
    const api = serviceBlock("api");
    for (const name of Object.values(AI_KEY_ENV)) expect(blanks(api, name), `api ${name}`).toBe(true);
    // Not blanked: the API takes the chat's key from .env, when there is one.
    expect(api).not.toMatch(new RegExp(`^\\s+${CHAT_KEY_ENV}:`, "m"));
    for (const service of ["worker", "migrate"]) expect(blanks(serviceBlock(service), CHAT_KEY_ENV), `${service} ${CHAT_KEY_ENV}`).toBe(true);
  });

  it("Google Cloud kit: the chat's secret is granted to the API's account alone and reaches the API alone", () => {
    const gcp = (name: string) => readFileSync(path.join(root, "deploy/gcp", name), "utf8");
    const secrets = gcp("20-secrets.sh");
    expect(secrets).toContain('grant "$SECRET_CHAT_KEY" "$SA_API"');
    expect(secrets).not.toMatch(/grant "\$SECRET_CHAT_KEY" "\$SA_WORKER"/);
    // The loop that grants a secret to both accounts does not name it.
    const shared = /^for s in (.+); do\n\s+exists_secret "\$s" \|\| continue\n\s+grant "\$s" "\$SA_API"\n\s+grant "\$s" "\$SA_WORKER"/m.exec(secrets);
    expect(shared?.[1]).toBeTruthy();
    expect(shared![1]).not.toContain("CHAT");

    const deploy = gcp("40-deploy.sh");
    const withKey = deploy.split("\n").filter((line) => line.includes(`${CHAT_KEY_ENV}=`));
    expect(withKey).toEqual([`    api_secrets+=",${CHAT_KEY_ENV}=$SECRET_CHAT_KEY:latest"`]);
    // The API's release takes its secrets from that list; the jobs' lists are built without it.
    expect(deploy).toContain('--env-vars-file "$work/api.json" --set-secrets "$api_secrets"');
    for (const line of deploy.split("\n").filter((l) => /^(tick_secrets|common_secrets)(\+)?=/.test(l.trim()))) expect(line).not.toContain("CHAT");
    // The chat's settings go into the API's environment only, and only when the chat is on.
    expect(deploy).toMatch(/if \(kind === "api" && local\.CHAT_MODE === "gemini"\)/);
    expect(deploy).not.toMatch(/const CARRY = \[[^\]]*CHAT_/);
  });

  it(".env.example: the chat is off, and no key is set", () => {
    const env = parseEnv(envExample);
    expect(env.CHAT_MODE).toBe("off");
    expect(env[CHAT_KEY_ENV]).toBeUndefined();
    expect(envExample).toMatch(new RegExp(`^# ${CHAT_KEY_ENV}=$`, "m"));
    // What it ships is a valid configuration with the chat off.
    const config = loadConfig({ MASTER_KEY: Buffer.alloc(32, 7).toString("base64"), APP_SECRET: "test-secret-test-secret-test-secret-1234", CHAT_MODE: env.CHAT_MODE });
    expect(config.CHAT_MODE).toBe("off");
  });
});
