import type { ExtractionInput, Extractor, ParticipantHandle, ParticipantRef, Segment, TaskCard, TaskHandle } from "../domain/types.js";
import { foldForMatch, tokens } from "../lib/text.js";
import { anchorDate, findDueHint, hintToDueSpec } from "./due-hints.js";
import { conceptKeys, isAbbreviation, langOf, nextAction, nounIn, objectPhrase, summary, taskTitle, U, type Party, type TaskKind } from "./mock-text.js";
import { PROMPT_VERSION } from "./prompt.js";
import type { Certainty, DueSpec, ExtractionOutput, Operation } from "./schema.js";
import { OUTPUT_LIMITS, SCHEMA_VERSION } from "./schema.js";
import { COMPONENT_VERSIONS, componentValues } from "./versions.js";

/** Bump when the heuristics change (part of the mock's pipelineVersion). */
export const MOCK_VERSION = "m4";

// ── Patterns (matched on foldForMatch text: lower-case, no accents, ς→σ) ─────

const INJECTION = [
  U(String.raw`ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|rules|prompts?)`),
  U(String.raw`disregard (all |any )?(the )?(previous|prior|above) `),
  U(String.raw`αγνοησ(ε|τε) (ολεσ |τισ )?(τισ )?(προηγουμενεσ |παραπανω )?οδηγι`),
  U(String.raw`\bagno(h|i)s(e|te)\b`),
  U(String.raw`\b(ai|llm|gpt|claude) (assistant|system|model|agent)\b|\bassistant\s*:|\bsystem\s*:|system prompt|you are now|as an ai\b`),
  U(String.raw`βοηθ(ε|οσ) (τεχνητησ νοημοσυνησ|ai)\b|προσ το (συστημα|ai)\b|εντολη (προσ|για) (το )?(συστημα|ai)\b|(αυτοματο|αυτοματοποιημενο) συστημα`),
  U(String.raw`mark (all|every|each|any)\b.{0,60}\b(as )?(done|completed?|closed|resolved)`),
  U(String.raw`(σημανε|σημειωσε|κλεισε|ολοκληρωσε|μαρκαρε)\b.{0,40}\b(ολεσ|ολα|ολουσ|καθε)\b`),
  U(String.raw`<\/?(segment|task_cards?|message|system|participants?|example)\b`),
  U(String.raw`\{\s*"(message_class|operations|op)"\s*:`),
  U(String.raw`\b(dismiss|close|complete) (all|every|the rest|everything)\b`),
  U(String.raw`authorized by the (mailbox )?owner|εγκεκριμενο απο τον (ιδιοκτητη|χρηστη)`),
  U(String.raw`\b(η |οι )?εκκρεμοτητ\w* (ολοκληρωθηκ\w*|εκλεισ\w*|εχ\w* κλεισει)|\b(all )?(tasks?|tickets?) (is |are |has been |have been )?(completed|closed|resolved)\b`),
];

const MARKETING = U(String.raw`unsubscribe|διαγραφη απο τη λιστα|διαγραφειτε απο|newsletter|δεν επιθυμειτε να λαμβανετε|δειτε τισ προσφορεσ μασ|μονο αυτη την εβδομαδα`);
const AUTOMATED = U(String.raw`do not reply|μην απαντατε|αυτοματο μηνυμα|automated (message|notification)|this is an automated|no-reply`);
const OUT_OF_OFFICE = U(String.raw`εκτοσ γραφειου|out of (the )?office|θα απουσιαζω|autoreply|automatic reply|αυτοματη απαντηση`);

const ATTACH = U(
  String.raw`\b(επισυναπτ\w*|στελν\w* συνημμεν\w*|αποστελλ\w* συνημμεν\w*|συνημμεν\w* (θα βρειτε|σασ στελν\w*))|please find attached|find attached|\bi attach|attached (is|are|please find)|\bepisynapt\w*|\bepisinapt\w*|\bstelnw syn`,
);
const COMMIT = U(
  String.raw`\bθα (σασ |σου |το |τα |την |τον )?(στειλ\w*|αποστειλ\w*|ενημερωσ\w*|απαντησ\w*|καλεσ\w*|προωθησ\w*|ετοιμασ\w*|φερ\w*|παραδωσ\w*|κανονισ\w*)|\bi('ll| will) (send|get back|let you know|prepare|call|forward|deliver)|\bwe('ll| will) (send|get back|let you know|prepare|deliver)|\btha (sas |sou )?(steil\w*|enhmerws\w*|enimeros\w*|apanths\w*)`,
);
const VAGUE_COMMIT = U(String.raw`\bθα (το |τα )?(κοιταξ\w*|δω|δουμε|ψαξ\w*)\b|\bθα επανελθ\w*|\bθα σασ πω\b|\bi('ll| will) (look into|check|come back)|\btha (to )?(koitaks\w*|epanel\w*|dw)\b`);
const COURTESY = U(String.raw`στη διαθεση σασ|\bμη(ν)? διστασετε|παραμενω στη διαθεση|don'?t hesitate|at your disposal|let me know if you need anything`);
const REQUEST = U(
  String.raw`\b(μπορειτε|μπορεισ|θα μπορουσατε|θα μπορουσεσ) να\b|\bπαρακαλ(ω|ουμε)\b[^.;?]{0,40}\b(στειλ|αποστειλ|ενημερ|επιβεβαι|πειτε|κανετε|μου|μασ|εξοφλ|πληρωσ|καταθεσ)|\bστειλ(τε|ε) (μου|μασ)\b|\b(χρειαζομαστε|χρειαζομαι)\b|\bθα (ηθελα|θελαμε) να (μου|μασ)\b|\bcould you\b|\bcan you\b|\bwould you\b|\bplease (send|let me know|confirm|provide|share)\b|\bwe need\b|\b(mporeite|mporeis|tha mporousate|tha mporouses) na\b|\bsteil(te|e) (mou|mas)\b`,
);
const WAITING = U(String.raw`\bπεριμενω (την |το |τα |τισ |νεα)|\blooking forward to (your|hearing)|\bperimenw\b`);
/** «take it over», or «take/handle it» ending the clause — never «please take it into account». */
const HANDOVER = U(
  String.raw`\b(μπορεισ|θα μπορουσεσ) να (το |τα |την |τον )?(αναλαβεισ|χειριστεισ)\b|\bαναλαβε (το|τα|την|τον)\b|\b((can|could|would) you|please) (please )?(take|handle) (this|it)( over\b|\s*([.!?;,]|$))|\bplease take over\b|\bmporeis na to analaveis\b`,
);
const REOPEN = U(
  String.raw`\bδεν (το |τα |την |τον |τισ )?(λαβαμε|παραλαβαμε|ελαβα|πηραμε|ανοιγ\w*)|\bξαναστειλ\w*|\bστειλ\w* (το |τα |την |μασ |μου )*ξανα\b|\b(didn'?t|did not|haven'?t|have not) (receive|get)|\bresend\b|\bsend (it |them )?again\b|\b(doesn'?t|does not|can'?t|cannot) open\b|\bden (to |ta )?(lavame|anoigei)\b`,
);
const CANCEL = U(
  String.raw`\bδεν (τη |το |τα |την )?χρειαζ\w* (πλεον|πια|τελικα)\b|\bτελικα δεν (τη |το |τα |την )?χρειαζ|\bακυρω\w*|\bακυρωσ\w*|\bno longer (need|required)\b|\b(cancel(l)?ed|cancel) (the |our )?(order|request|event)\b|\bden xreiazetai\b`,
);
const RECEIVED = U(
  String.raw`(?<!δεν )(?<!δεν το )(?<!δεν τα )(?<!δεν την )\b(λαβαμε|παραλαβαμε|ελαβα|παρελαβα|πηραμε)\b|\b(well )?received\b|\bgot (it|them)\b|\b(to|ta) lavame\b`,
);
const URGENT = U(String.raw`\bεπειγ\w*|\burgent\b|\basap\b|\bαμεσα\b|\bepeig\w*|σημερα οπωσδηποτε`);
const GREETING = U(String.raw`^(καλημερα|καλησπερα|γεια( σου| σασ)?|hi|hello|dear|geia)\b`);

// ── Text helpers ─────────────────────────────────────────────────────────────

interface Sentence {
  text: string;
  folded: string;
  segment: Segment & { anchor: string | null };
  /** Offset in segment.text. */
  start: number;
}

/** Split a segment into sentences; every sentence is an exact substring of `segment.text`. */
export function splitSentences(segment: Segment & { anchor: string | null }): Sentence[] {
  const t = segment.text;
  const out: Sentence[] = [];
  let start = 0;
  const push = (end: number) => {
    const raw = t.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) out.push({ text, folded: foldForMatch(text), segment, start: start + lead });
    start = end;
  };
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === "\n") {
      push(i);
      start = i + 1;
      continue;
    }
    if (".!?;;".includes(ch)) {
      if (ch === "." && isAbbreviation(t.slice(start, i))) continue;
      const rest = t.slice(i + 1);
      const next = rest.match(/^\s*(\S)/u);
      if (!next || (/\s/.test(rest[0] ?? "") && /[\p{Lu}\p{N}«"(]/u.test(next[1]!))) push(i + 1);
    }
  }
  push(t.length);
  return out;
}

const firstMatch = (sentences: Sentence[], re: RegExp) => sentences.find((s) => re.test(s.folded)) ?? null;

/** How much card text `a` and mail text `b` are about the same thing (0..1). */
function overlap(a: string, b: string): number {
  const ta = new Set(tokens(a).filter((t) => t.length >= 4).map((t) => t.slice(0, 6)));
  const tb = new Set(tokens(b).filter((t) => t.length >= 4).map((t) => t.slice(0, 6)));
  let direct = 0;
  if (ta.size && tb.size) {
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    direct = hit / Math.min(ta.size, tb.size);
  }
  // An English title and Greek or Greeklish mail share few words: the share of the card's concepts the mail names.
  if (langOf(a) === langOf(b)) return direct;
  const ka = conceptKeys(a);
  if (!ka.size) return direct;
  const kb = conceptKeys(b);
  let shared = 0;
  for (const k of ka) if (kb.has(k)) shared++;
  return Math.max(direct, shared / ka.size);
}

/** Token overlap at which a card and a text are about the same deliverable. */
const SAME_DELIVERABLE = 0.34;

/** Best card for a context string: THREAD_* cards first, RELATED_OPEN only with a clear topical overlap. */
function pickCard(cards: TaskCard[], context: string, filter: (c: TaskCard) => boolean): TaskCard | null {
  const cands = cards.filter(filter);
  if (!cands.length) return null;
  const scored = cands
    .map((c, i) => ({ c, i, s: overlap(`${c.title} ${c.items.join(" ")}`, context) }))
    .filter((x) => x.c.scope !== "RELATED_OPEN" || x.s >= 0.5)
    .sort((a, b) => (a.c.scope === "RELATED_OPEN" ? 1 : 0) - (b.c.scope === "RELATED_OPEN" ? 1 : 0) || b.s - a.s || a.i - b.i);
  return scored[0]?.c ?? null;
}

// ── Mock extraction ──────────────────────────────────────────────────────────

interface Ctx {
  input: ExtractionInput;
  sentences: Sentence[];
  forwarded: Sentence[];
  /** Quoted history (context for a hand-over's title and deadline only; never evidence). */
  quoted: Sentence[];
  participants: Map<string, ParticipantRef>;
  ops: Operation[];
  touched: Set<TaskHandle>;
}

function evidence(s: Sentence) {
  return { source: s.segment.kind === "FORWARDED" ? ("FORWARDED" as const) : ("NEW" as const), segment_id: s.segment.id, quote: s.text.slice(0, OUTPUT_LIMITS.maxQuote) };
}

function segmentAnchor(ctx: Ctx, s: Segment & { anchor: string | null }): string | null {
  return anchorDate(s.anchor) ?? (s.kind === "NEW" ? anchorDate(ctx.input.message.sentAnchor) : null);
}

/** Deadline phrase in the sentence, else in the rest of the same segment, else (forwards) in forwarded text. */
function dueNear(ctx: Ctx, s: Sentence, forwarded: Sentence[] = []): DueSpec | null {
  // A handover ("μπορείς να το αναλάβεις;") takes the deadline from the forwarded request, not from the cover note.
  const scan = [s, ...forwarded, ...ctx.sentences.filter((x) => x.segment === s.segment && x.start > s.start)];
  for (const x of scan) {
    const hint = findDueHint(x.text);
    if (hint) return hintToDueSpec(hint, x.segment.id, segmentAnchor(ctx, x.segment));
  }
  return null;
}

function priorityFor(ctx: Ctx, due: DueSpec | null): "URGENT" | "HIGH" | "NORMAL" {
  const all = ctx.sentences.map((s) => s.folded).join(" ");
  if (URGENT.test(all)) return "URGENT";
  const anchor = anchorDate(ctx.input.message.sentAnchor);
  if (due?.model_date && anchor) {
    const days = (Date.parse(due.model_date) - Date.parse(anchor)) / 86_400_000;
    if (days <= 2) return "HIGH";
  }
  return "NORMAL";
}

function addressee(input: ExtractionInput): "OWNER_TO" | "OWNER_CC" | "OTHER" {
  const m = input.message;
  if (m.direction === "OUTBOUND" || m.toHandles.includes("P1")) return "OWNER_TO";
  if (m.ccHandles.includes("P1")) return "OWNER_CC";
  return "OTHER";
}

function ownerNamed(ctx: Ctx): boolean {
  const first = ctx.input.owner.name?.split(/\s+/)[0];
  if (!first) return false;
  const stem = foldForMatch(first).slice(0, Math.max(3, Math.min(5, first.length - 1)));
  return ctx.sentences.some((s) => s.folded.includes(stem));
}

function push(ctx: Ctx, op: Operation) {
  if (ctx.ops.length >= OUTPUT_LIMITS.maxOperations) return;
  if ("task" in op) {
    if (ctx.touched.has(op.task)) return;
    ctx.touched.add(op.task);
  }
  ctx.ops.push(op);
}

function statusOp(ctx: Ctx, op: "COMPLETE" | "REOPEN" | "SUGGEST_DISMISS", c: TaskCard, s: Sentence, certainty: Certainty, reason: string) {
  push(ctx, { op, task: c.handle, evidence: evidence(s), certainty, confidence: certainty === "EXPLICIT" ? 0.9 : 0.6, reason });
}

interface CreateSpec {
  status: "ACTION_REQUIRED" | "WAITING_FOR_ME" | "WAITING_FOR_OTHER";
  /** What the task is, for the wording of the next step and the summary. */
  kind: TaskKind;
  /** Whose task it is: P1, or the colleague P1 handed it over to. */
  owner?: ParticipantHandle;
  counterparty: ParticipantHandle | null;
  certainty: Certainty;
  deadline: DueSpec | null;
  reason: string;
  /** More sentences that name the deliverable (forwarded or quoted request), after the evidence sentence. */
  about?: Sentence[];
  /** The colleague of a hand-over (who asked P1, or whom P1 asked). */
  colleague?: ParticipantHandle;
}

function partyOf(p: ParticipantRef | undefined, company: string | null): Party | null {
  return p ? { name: p.name, company, address: p.address } : null;
}

function create(ctx: Ctx, s: Sentence, c: CreateSpec) {
  const party = c.counterparty ? ctx.participants.get(c.counterparty) : undefined;
  // The UI shows the person when there is no company: never P1's own company for a colleague.
  const company = party && !party.isInternal && !party.isOwner ? party.company : null;
  const colleague = c.colleague ? ctx.participants.get(c.colleague) : undefined;
  const about = [s, ...(c.about ?? [])];
  const object = about.map((x) => objectPhrase(x.text)).find((x) => !!x) ?? null;
  const parts = taskTitle(object, ctx.input.message.subject, [company, party?.company, party?.name, colleague?.name], about.map((x) => x.text).join(" "));
  push(ctx, {
    op: "CREATE",
    title: parts.title.slice(0, OUTPUT_LIMITS.maxTitle),
    status: c.status,
    owner: c.owner ?? "P1",
    counterparty: c.counterparty,
    company,
    items: [],
    due: c.status === "WAITING_FOR_OTHER" ? null : c.deadline,
    expect_reply: c.status === "WAITING_FOR_OTHER" ? c.deadline : null,
    priority: priorityFor(ctx, c.deadline),
    next_action: nextAction(c.kind, object, parts, c.deadline?.model_date ?? null),
    summary: summary(c.kind, parts, c.deadline, { party: partyOf(party, company), colleague: partyOf(colleague, null) }).slice(0, OUTPUT_LIMITS.maxSummary),
    addressee: addressee(ctx.input),
    evidence: evidence(s),
    certainty: c.certainty,
    confidence: c.certainty === "EXPLICIT" ? 0.9 : 0.6,
    reason: c.reason,
  });
}

function updateOp(ctx: Ctx, c: TaskCard, s: Sentence, changes: Partial<Extract<Operation, { op: "UPDATE" }>["changes"]>, certainty: Certainty, reason: string) {
  push(ctx, {
    op: "UPDATE",
    task: c.handle,
    changes: { status: null, due: null, expect_reply: null, priority: null, next_action: null, summary: null, add_items: [], ...changes },
    evidence: evidence(s),
    certainty,
    confidence: certainty === "EXPLICIT" ? 0.85 : 0.6,
    reason,
  });
}

const openThread = (statuses: string[]) => (c: TaskCard) => c.scope !== "THREAD_CLOSED" && statuses.includes(c.status);
const ownersCard = (c: TaskCard) => c.ownerHandle === "P1" || c.ownerHandle === "UNKNOWN";

function firstRecipient(input: ExtractionInput): ParticipantHandle | null {
  const h = [...input.message.toHandles, ...input.message.ccHandles].find((x): x is ParticipantHandle => x !== "OTHER" && x !== "P1");
  return h ?? null;
}

/** A colleague (internal, not P1) in To. */
function colleagueInTo(ctx: Ctx): ParticipantRef | undefined {
  return ctx.input.message.toHandles.map((h) => (h === "OTHER" ? undefined : ctx.participants.get(h))).find((p) => !!p && p.isInternal && !p.isOwner);
}

/** The external author of the forwarded or quoted request, when known. */
function requesterOf(ctx: Ctx): ParticipantRef | undefined {
  const external = ctx.input.participants.filter((p) => !p.isOwner && !p.isInternal);
  for (const seg of ctx.input.message.segments) {
    if (seg.kind === "NEW" || !seg.author) continue;
    const author = foldForMatch(seg.author);
    const hit = external.find((p) => (p.address && author.includes(p.address.toLowerCase())) || (p.name && foldForMatch(p.name).length >= 3 && author.includes(foldForMatch(p.name))));
    if (hit) return hit;
  }
  return external.find((p) => p.roles.includes("quoted"));
}

function outbound(ctx: Ctx) {
  const { input, sentences } = ctx;
  const cards = input.taskCards;
  const context = `${input.message.subject} ${input.message.attachments.map((a) => a.filename).join(" ")}`;

  const delivered = input.message.attachments.length > 0 ? firstMatch(sentences, ATTACH) : null;
  if (delivered) {
    const c = pickCard(cards, `${delivered.text} ${context}`, (x) => openThread(["ACTION_REQUIRED", "WAITING_FOR_ME"])(x) && ownersCard(x));
    if (c) statusOp(ctx, "COMPLETE", c, delivered, "EXPLICIT", "Owner sent the deliverable with an attachment.");
  }

  // Hand-over to a colleague («Μαρία, μπορείς να το αναλάβεις;»): the colleague's task, never a wait of P1's. Created
  // only when there is something to hand over: forwarded or quoted mail, or a deliverable named in the sentence itself.
  const colleague = colleagueInTo(ctx);
  const handover = colleague ? firstMatch(sentences, HANDOVER) : null;
  const about = [...ctx.forwarded, ...ctx.quoted];
  if (handover && colleague) {
    if (!about.length && !nounIn(handover.text)) return;
    const requester = requesterOf(ctx);
    create(ctx, handover, {
      status: "ACTION_REQUIRED",
      kind: "handover_out",
      owner: colleague.handle,
      counterparty: requester?.handle ?? null,
      certainty: "EXPLICIT",
      deadline: dueNear(ctx, handover, about),
      reason: "Owner handed the request over to a colleague.",
      about,
      colleague: colleague.handle,
    });
    // The owner's own open card for the same deliverable: someone else took it over.
    const handedOver = [handover, ...about].map((x) => x.text).join(" ");
    const mine = cards
      .filter((x) => x.scope === "THREAD_OPEN" && ownersCard(x) && (x.status === "ACTION_REQUIRED" || x.status === "WAITING_FOR_ME") && !ctx.touched.has(x.handle))
      .map((c) => ({ c, s: overlap(`${c.title} ${c.items.join(" ")}`, handedOver) }))
      .filter((x) => x.s >= SAME_DELIVERABLE)
      .sort((a, b) => b.s - a.s)[0]?.c;
    if (mine) statusOp(ctx, "SUGGEST_DISMISS", mine, handover, "EXPLICIT", "A colleague took the task over.");
    return;
  }

  const commit = sentences.find((s) => COMMIT.test(s.folded) && !ATTACH.test(s.folded)) ?? null;
  const vague = commit ? null : firstMatch(sentences, VAGUE_COMMIT);
  const promise = commit ?? vague;
  if (promise) {
    const certainty: Certainty = commit ? "EXPLICIT" : "IMPLIED";
    const deadline = dueNear(ctx, promise);
    const open = pickCard(cards, `${promise.text} ${context}`, (x) => openThread(["ACTION_REQUIRED", "WAITING_FOR_ME"])(x) && ownersCard(x) && !ctx.touched.has(x.handle));
    if (open?.status === "ACTION_REQUIRED") updateOp(ctx, open, promise, { status: "WAITING_FOR_ME", due: deadline }, certainty, "Owner committed to the requested deliverable.");
    else if (open && deadline) updateOp(ctx, open, promise, { due: deadline }, certainty, "Owner gave a date for an open promise.");
    else if (!open) create(ctx, promise, { status: "WAITING_FOR_ME", kind: "promise", counterparty: firstRecipient(input), certainty, deadline, reason: "Owner made a commitment." });
  }

  const ask = sentences.find((s) => (REQUEST.test(s.folded) || WAITING.test(s.folded)) && !COURTESY.test(s.folded)) ?? null;
  if (ask && !promise) {
    const deadline = dueNear(ctx, ask);
    const waiting = pickCard(cards, `${ask.text} ${context}`, openThread(["WAITING_FOR_OTHER"]));
    if (waiting && !ctx.touched.has(waiting.handle)) {
      if (deadline) updateOp(ctx, waiting, ask, { expect_reply: deadline }, "EXPLICIT", "Owner restated the request with a reply date.");
    } else if (!waiting) {
      create(ctx, ask, { status: "WAITING_FOR_OTHER", kind: "ask", counterparty: firstRecipient(input), certainty: "EXPLICIT", deadline, reason: "Owner asked the other party for something." });
    }
  }
}

function inbound(ctx: Ctx) {
  const { input, sentences } = ctx;
  const cards = input.taskCards;
  const from = input.message.fromHandle;
  const sender = from === "OTHER" ? undefined : ctx.participants.get(from);
  // A delivered copy "from P1" is not the owner speaking (it may be forged): no owner authority, no colleague authority.
  const colleague = !!sender && sender.isInternal && !sender.isOwner;
  const context = `${input.message.subject} ${input.message.attachments.map((a) => a.filename).join(" ")}`;
  const hasAttachment = input.message.attachments.length > 0;

  // Status evidence on existing cards.
  const reopen = firstMatch(sentences, REOPEN);
  if (reopen && !colleague) {
    const c = pickCard(cards, `${reopen.text} ${context}`, (x) => x.scope === "THREAD_CLOSED");
    if (c) statusOp(ctx, "REOPEN", c, reopen, "EXPLICIT", "Counterparty reports the deliverable was not received or unusable.");
  }
  const cancel = firstMatch(sentences, CANCEL);
  if (cancel) {
    const c = pickCard(cards, `${cancel.text} ${context}`, openThread(["ACTION_REQUIRED", "WAITING_FOR_ME", "WAITING_FOR_OTHER"]));
    if (c && !ctx.touched.has(c.handle)) statusOp(ctx, "SUGGEST_DISMISS", c, cancel, "EXPLICIT", "The requester says it is no longer needed.");
  }

  const delivered = hasAttachment ? firstMatch(sentences, ATTACH) : null;
  if (delivered && colleague) {
    // P1's card, or the colleague's own (a task P1 handed over to them): code asks P1 to confirm either way.
    const c = pickCard(cards, `${delivered.text} ${context}`, (x) => openThread(["ACTION_REQUIRED", "WAITING_FOR_ME"])(x) && (ownersCard(x) || x.ownerHandle === from));
    if (c && !ctx.touched.has(c.handle)) statusOp(ctx, "COMPLETE", c, delivered, "EXPLICIT", "Internal colleague sent the deliverable.");
  } else if (delivered && from !== "P1") {
    const c = pickCard(cards, `${delivered.text} ${context}`, openThread(["WAITING_FOR_OTHER"]));
    if (c && !ctx.touched.has(c.handle)) statusOp(ctx, "COMPLETE", c, delivered, "EXPLICIT", "The other party delivered what the owner was waiting for.");
  }

  const received = reopen ? null : firstMatch(sentences, RECEIVED);
  if (received && from !== "P1") {
    const c = pickCard(cards, `${received.text} ${context}`, openThread(["WAITING_FOR_OTHER"]));
    if (c && !ctx.touched.has(c.handle)) statusOp(ctx, "COMPLETE", c, received, "EXPLICIT", "Counterparty confirmed receipt.");
  }

  // Promises made to the owner.
  const promise = firstMatch(sentences, COMMIT);
  if (promise && !colleague && from !== "P1") {
    const deadline = dueNear(ctx, promise);
    const waiting = pickCard(cards, `${promise.text} ${context}`, openThread(["WAITING_FOR_OTHER"]));
    if (waiting && !ctx.touched.has(waiting.handle)) {
      if (deadline) updateOp(ctx, waiting, promise, { expect_reply: deadline }, "EXPLICIT", "Counterparty promised a date.");
    } else if (!waiting && from !== "OTHER") {
      create(ctx, promise, { status: "WAITING_FOR_OTHER", kind: "promised_to_me", counterparty: from, certainty: "EXPLICIT", deadline, reason: "Counterparty promised the owner a deliverable." });
    }
  }

  // Requests to the owner (Cc rule: only when addressed in To or named).
  const addressed = addressee(input) === "OWNER_TO" || ownerNamed(ctx);
  const handover = colleague ? firstMatch(sentences, HANDOVER) : null;
  const ask = handover ?? sentences.find((s) => REQUEST.test(s.folded) && !COURTESY.test(s.folded) && !REOPEN.test(s.folded)) ?? null;
  if (ask && addressed && from !== "P1" && !ctx.ops.some((o) => o.op === "REOPEN" || o.op === "SUGGEST_DISMISS")) {
    const fwdAuthor = handover ? requesterOf(ctx) : undefined;
    const counterparty: ParticipantHandle | null = fwdAuthor?.handle ?? (from === "OTHER" ? null : from);
    const deadline = dueNear(ctx, ask, handover ? ctx.forwarded : []);
    // Unit rule: an open card of this thread about the same thing absorbs the request instead of a duplicate CREATE.
    const existing = cards.find(
      (x) => x.scope === "THREAD_OPEN" && (x.status === "ACTION_REQUIRED" || x.status === "WAITING_FOR_ME") && overlap(`${x.title} ${x.items.join(" ")}`, ask.text) >= SAME_DELIVERABLE,
    );
    if (existing && !ctx.touched.has(existing.handle)) {
      if (deadline && !existing.dueDate) updateOp(ctx, existing, ask, { due: deadline }, "EXPLICIT", "Requester added a deadline to an open request.");
    } else if (!existing) {
      create(ctx, ask, {
        status: "ACTION_REQUIRED",
        kind: handover ? "handover_in" : "request",
        counterparty,
        certainty: "EXPLICIT",
        deadline,
        reason: handover ? "Colleague handed over a forwarded request." : "The sender asked the owner for something.",
        about: handover ? ctx.forwarded : [],
        colleague: handover && from !== "OTHER" ? from : undefined,
      });
    }
  }

  // The counterparty answered what the owner waited for (no attachment/receipt phrase needed).
  if (!ctx.ops.length && from !== "OTHER" && from !== "P1" && !colleague && !ask && !promise && !reopen && !cancel) {
    const c = cards.find((x) => x.scope === "THREAD_OPEN" && x.status === "WAITING_FOR_OTHER" && x.counterpartyHandle === from);
    const s = sentences.find((x) => !GREETING.test(x.folded) || x.text.length > 40) ?? sentences[0];
    if (c && s) statusOp(ctx, "COMPLETE", c, s, "IMPLIED", "The awaited party replied in the thread.");
  }
}

/** Pure heuristic extraction (exported for tests and the eval). */
export function mockExtract(input: ExtractionInput): ExtractionOutput {
  const segs = input.message.segments;
  const newSegs = segs.filter((s) => s.kind === "NEW");
  const all = newSegs.flatMap(splitSentences);
  const isInjected = (s: Sentence) => INJECTION.some((re) => re.test(s.folded));
  // Forwarded / quoted text only names the deliverable and its deadline; text aimed at the assistant never does.
  const forwarded = segs.filter((s) => s.kind === "FORWARDED").flatMap(splitSentences).filter((s) => !isInjected(s));
  const quoted = segs.filter((s) => s.kind === "QUOTED").flatMap(splitSentences).filter((s) => !isInjected(s));

  const injected = all.filter(isInjected);
  const suspicious = injected.length > 0;
  const sentences = all.filter((s) => !injected.includes(s));
  const folded = sentences.map((s) => s.folded).join(" ");

  if (MARKETING.test(folded)) return { message_class: "MARKETING", suspicious_instructions: suspicious, operations: [] };
  if (OUT_OF_OFFICE.test(folded) || (input.message.fromHandle === "OTHER" && AUTOMATED.test(folded))) {
    return { message_class: "AUTOMATED", suspicious_instructions: suspicious, operations: [] };
  }

  const ctx: Ctx = {
    input,
    sentences,
    forwarded,
    quoted,
    participants: new Map(input.participants.map((p) => [p.handle, p])),
    ops: [],
    touched: new Set(),
  };
  if (input.message.direction === "OUTBOUND") outbound(ctx);
  else inbound(ctx);

  return { message_class: ctx.ops.length ? "ACTIONABLE" : "FYI", suspicious_instructions: suspicious, operations: ctx.ops };
}

/** Deterministic rule-based extractor for dev/tests (no network, no cost). Greek/English/Greeklish keyword heuristics; the text it writes is English. */
export function createMockExtractor(opts: { pipelineVersion?: string } = {}): Extractor {
  const pipelineVersion = opts.pipelineVersion ?? [PROMPT_VERSION, SCHEMA_VERSION, "mock", MOCK_VERSION, ...componentValues(COMPONENT_VERSIONS)].join("|");
  return {
    name: "mock",
    pipelineVersion,
    async extract(input) {
      const output = mockExtract(input);
      return {
        ok: true,
        output,
        model: "mock",
        stopReason: "end_turn",
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        costUsd: 0,
        latencyMs: 0,
        request: { extractor: "mock", version: MOCK_VERSION, input },
      };
    },
  };
}
