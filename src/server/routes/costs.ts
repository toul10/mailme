import { and, asc, eq, gte, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { DateTime } from "luxon";
import { GEMINI_LAUNCH_PRICES } from "../../ai/pricing.js";
import { safeZone } from "../../digest/calendar.js";
import { extractions, mailboxes, messages, organizations, securityAudit, users } from "../../db/schema.js";
import { EARLY_MAIL_BUDGET_FACTOR, dailyBudgetUse, dailyCaps } from "../../engine/pipeline.js";
import type { AiCostDay, AiCostMailbox, AiCostModel, AiCosts } from "../api-types.js";
import { authOf, requireAuth } from "../auth/guard.js";
import type { AppContext } from "../context.js";

/** How far back the days and the models go (and always to the 1st of the month). */
export const COST_WINDOW_DAYS = 30;

/** The share of a row's table-price cost Google billed (GEMINI_LAUNCH_PRICES), as SQL over its model and time. */
function billedShareSql(model: SQL, at: SQL): SQL {
  if (GEMINI_LAUNCH_PRICES.length === 0) return sql`1`;
  const whens = GEMINI_LAUNCH_PRICES.map((p) => sql`when ${model} = ${p.model} and ${at} < ${p.until}::timestamptz then ${p.factor}::float8`);
  return sql`(case ${sql.join(whens, sql` `)} else 1::float8 end)`;
}

const usd = (v: unknown) => Math.round(Number(v ?? 0) * 1e6) / 1e6;

/** A stored model id as the price table writes it (lower case, without "models/"), as geminiPricingFor reads it. */
const modelId = (raw: SQL): SQL => sql`lower(regexp_replace(${raw}, '^models/', ''))`;

/**
 * "AI costs": what the AI cost, from the stored calls (extractions) and the chat's audit rows (chat.ask). Never a
 * message, a subject or a question: models, counts and amounts only. A user sees their own mailboxes and questions;
 * a platform admin, whose own account usually has no mailbox, sees every mailbox and every user's questions.
 */
export function registerCostRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, clock, config } = ctx.deps;

  app.get("/api/costs", { preHandler: requireAuth(ctx, "full") }, async (request) => {
    const auth = authOf(request);
    const now = clock.now();
    const zone = safeZone(auth.timezone);
    const [me] = await db.select({ platformAdmin: users.platformAdmin }).from(users).where(eq(users.id, auth.userId));
    const all = Boolean(me?.platformAdmin);

    const local = DateTime.fromJSDate(now, { zone });
    const today = local.toISODate()!;
    const monthStart = local.startOf("month").toISODate()!;
    const windowStartLocal = DateTime.min(local.startOf("day").minus({ days: COST_WINDOW_DAYS - 1 }), local.startOf("month"))!;
    const from = windowStartLocal.toJSDate();

    const boxes = await db
      .select({
        id: mailboxes.id,
        address: mailboxes.address,
        name: mailboxes.displayName,
        createdAt: mailboxes.createdAt,
        aiPaused: mailboxes.aiPaused,
        aiPausedReason: mailboxes.aiPausedReason,
        aiDailyCallCap: mailboxes.aiDailyCallCap,
        aiDailyUsdCap: mailboxes.aiDailyUsdCap,
        orgZone: organizations.timezone,
      })
      .from(mailboxes)
      .innerJoin(organizations, eq(organizations.id, mailboxes.orgId))
      .where(all ? undefined : eq(mailboxes.userId, auth.userId))
      .orderBy(asc(mailboxes.address));
    const ids = boxes.map((b) => b.id);

    const days = new Map<string, AiCostDay>();
    const day = (date: string) => {
      let d = days.get(date);
      if (!d) days.set(date, (d = { date, mail: {}, mails: 0, chat: 0, questions: 0 }));
      return d;
    };
    const models: AiCostModel[] = [];
    const queued = new Map<string, number>();

    if (ids.length) {
      const model = modelId(sql`coalesce(${extractions.model}, ${extractions.requestedModel})`);
      const localDay = sql<string>`to_char((${extractions.createdAt} at time zone ${zone})::date, 'YYYY-MM-DD')`;
      const billed = sql<number>`coalesce(sum(${extractions.costUsd} * ${billedShareSql(model, sql`${extractions.createdAt}`)}), 0)::float8`;
      // Only calls that went to an AI (the test mode and the user's own rules leave requested_model empty).
      const ai = and(inArray(extractions.mailboxId, ids), gte(extractions.createdAt, from), isNotNull(extractions.requestedModel));
      const perDay = await db
        .select({ day: localDay, mailboxId: extractions.mailboxId, mails: sql<number>`count(distinct ${extractions.messageId})::int`, usd: billed })
        .from(extractions)
        .where(ai)
        // By position: the day carries the zone as a parameter, so a repeated expression would not match it.
        .groupBy(sql`1`, sql`2`);
      for (const r of perDay) {
        const d = day(r.day);
        d.mail[r.mailboxId] = usd(r.usd);
        d.mails += Number(r.mails);
      }
      const perModel = await db
        .select({
          model: sql<string>`${model}`,
          mails: sql<number>`count(distinct ${extractions.messageId})::int`,
          calls: sql<number>`count(*)::int`,
          usd: billed,
          first: sql<string>`min(${localDay})`,
          last: sql<string>`max(${localDay})`,
          lastAt: sql<string>`max(${extractions.createdAt})`,
        })
        .from(extractions)
        .where(ai)
        .groupBy(model)
        .orderBy(sql`max(${extractions.createdAt}) desc`);
      for (const r of perModel) models.push({ model: r.model, mails: Number(r.mails), calls: Number(r.calls), usd: usd(r.usd), firstDay: r.first, lastDay: r.last });
      const q = await db
        .select({ id: messages.mailboxId, n: sql<number>`count(*)::int` })
        .from(messages)
        .where(and(inArray(messages.mailboxId, ids), inArray(messages.state, ["pending", "extracted"])))
        .groupBy(messages.mailboxId);
      for (const r of q) queued.set(r.id, Number(r.n));
    }

    // The chat's own record of each question (src/chat/usage.ts): model like "gemini:gemini-3.8-flash@low".
    const chatModel = modelId(sql`regexp_replace(regexp_replace(${securityAudit.detail}->>'model', '^[^:]*:', ''), '@.*$', '')`);
    const chatDay = sql<string>`to_char((${securityAudit.createdAt} at time zone ${zone})::date, 'YYYY-MM-DD')`;
    const chatRows = await db
      .select({
        day: chatDay,
        questions: sql<number>`count(*)::int`,
        usd: sql<number>`coalesce(sum((${securityAudit.detail}->>'costUsd')::float8 * ${billedShareSql(chatModel, sql`${securityAudit.createdAt}`)}), 0)::float8`,
      })
      .from(securityAudit)
      .where(and(eq(securityAudit.event, "chat.ask"), gte(securityAudit.createdAt, from), all ? undefined : eq(securityAudit.userId, auth.userId)))
      .groupBy(sql`1`);
    for (const r of chatRows) {
      const d = day(r.day);
      d.chat = usd(r.usd);
      d.questions = Number(r.questions);
    }
    const chatModels = chatRows.length
      ? (
          await db
            .selectDistinct({ model: sql<string>`${chatModel}` })
            .from(securityAudit)
            .where(and(eq(securityAudit.event, "chat.ask"), gte(securityAudit.createdAt, from), all ? undefined : eq(securityAudit.userId, auth.userId)))
        )
          .map((r) => r.model)
          .filter((m): m is string => Boolean(m))
          .sort()
      : [];

    // From the first day with a cost to today, every day in between too (a day without calls is a real zero).
    const costly = [...days.values()].filter((d) => d.chat > 0 || Object.values(d.mail).some((v) => v > 0)).map((d) => d.date);
    const out: AiCostDay[] = [];
    if (costly.length) {
      const first = costly.sort()[0]!;
      for (let d = DateTime.fromISO(first, { zone }); d.toISODate()! <= today; d = d.plus({ days: 1 })) {
        const date = d.toISODate()!;
        out.push(days.get(date) ?? { date, mail: {}, mails: 0, chat: 0, questions: 0 });
      }
    }

    const mbs: AiCostMailbox[] = [];
    for (const b of boxes) {
      const use = await dailyBudgetUse(db, b, safeZone(b.orgZone), now);
      mbs.push({
        id: b.id,
        address: b.address,
        name: b.name,
        today: { live: use.live, early: use.early, caps: dailyCaps(b, config), earlyFactor: EARLY_MAIL_BUDGET_FACTOR },
        paused: b.aiPaused ? b.aiPausedReason || "paused" : null,
        queued: queued.get(b.id) ?? 0,
      });
    }

    // Today's questions against the caps of src/server/routes/chat.ts (the user's own; everyone's $ for an admin).
    const dayStart = local.startOf("day").toJSDate();
    const [chatToday] = await db
      .select({
        mine: sql<number>`count(*) filter (where ${securityAudit.userId} = ${auth.userId})::int`,
        calls: sql<number>`count(*)::int`,
        usd: sql<number>`coalesce(sum((${securityAudit.detail}->>'costUsd')::float8), 0)::float8`,
      })
      .from(securityAudit)
      .where(and(eq(securityAudit.event, "chat.ask"), gte(securityAudit.createdAt, dayStart)));

    const res: AiCosts = {
      scope: all ? "all" : "own",
      today,
      monthStart,
      days: out,
      mailboxes: mbs,
      models,
      chat: {
        models: chatModels,
        questionsToday: Number(chatToday?.mine ?? 0),
        questionCap: config.CHAT_DAILY_QUESTION_CAP,
        all: all ? { calls: Number(chatToday?.calls ?? 0), usd: usd(chatToday?.usd), usdCap: config.CHAT_DAILY_USD_CAP } : null,
      },
    };
    return res;
  });
}
