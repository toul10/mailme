import type { ListResponse } from "imapflow";
import type { FolderRole } from "../../domain/types.js";
import { foldForMatch } from "../../lib/text.js";

export interface ListedFolder {
  path: string;
  name: string;
  delimiter: string | null;
  flags: string[];
  specialUse: string | null;
}

/** RFC 6154 SPECIAL-USE attributes (plus imapflow's `\Inbox`) → role. `\All` / `\Flagged` are virtual views. */
const SPECIAL_USE_ROLES: Record<string, FolderRole> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "junk",
  "\\archive": "archive",
  "\\all": "other",
  "\\flagged": "other",
};

const VIRTUAL_FLAGS = new Set(["\\all", "\\flagged"]);
const UNSELECTABLE_FLAGS = new Set(["\\noselect", "\\nonexistent"]);

/**
 * Folder names seen on Dovecot/Plesk/Courier and in Outlook / Thunderbird / webmail, English and Greek.
 * Compared after foldForMatch (case, accents, final sigma). "Outbox" (Greek «Εξερχόμενα») holds unsent mail → drafts.
 */
const NAME_ROLES: Array<[FolderRole, string[]]> = [
  [
    "sent",
    [
      "Sent", "Sent Items", "Sent Messages", "Sent Mail", "Sent-Mail", "SentMail", "Sent-Items", "SentItems", "Sent Email",
      "Απεσταλμένα", "Απεσταλμένα μηνύματα", "Απεσταλμένα στοιχεία", "Σταλμένα", "Σταλμένα μηνύματα", "Σταλθέντα",
    ],
  ],
  [
    "drafts",
    ["Drafts", "Draft", "Templates", "Outbox", "Πρόχειρα", "Πρόχειρα μηνύματα", "Εξερχόμενα", "Πρότυπα"],
  ],
  [
    "trash",
    [
      "Trash", "Deleted", "Deleted Items", "Deleted Messages", "Bin", "Recycle Bin",
      "Κάδος", "Κάδος απορριμμάτων", "Διαγραμμένα", "Διαγραμμένα στοιχεία", "Διαγραμμένα μηνύματα", "Απορρίμματα",
    ],
  ],
  [
    "junk",
    [
      "Junk", "Junk E-mail", "Junk Email", "Junk Mail", "Spam", "Bulk Mail", "Junk E-Mail",
      "Ανεπιθύμητη αλληλογραφία", "Ανεπιθύμητα", "Ανεπιθύμητα μηνύματα", "Ανεπιθύμητη",
    ],
  ],
  ["archive", ["Archive", "Archives", "Αρχείο", "Αρχειοθέτηση", "Αρχειοθετημένα"]],
];

const NAME_INDEX = new Map<string, FolderRole>();
for (const [role, names] of NAME_ROLES) for (const n of names) NAME_INDEX.set(foldForMatch(n), role);

function lowerFlags(f: ListedFolder): string[] {
  return f.flags.map((x) => x.toLowerCase());
}

/** Path segments below the personal namespace; `INBOX.Sent` (Plesk/Courier) counts as top level. */
function segments(f: ListedFolder): string[] {
  const parts = f.delimiter ? f.path.split(f.delimiter).filter((p) => p.length > 0) : [f.path];
  if (parts.length > 1 && parts[0]!.toUpperCase() === "INBOX") parts.shift();
  return parts;
}

/** SPECIAL-USE first, then EN/EL/panel name variants (modified UTF-7 decoded), else "other". */
export function classifyFolder(f: ListedFolder): { role: FolderRole; source: "special_use" | "name" } {
  // INBOX is reserved by the protocol itself (RFC 3501 §5.1).
  if (f.path.toUpperCase() === "INBOX") return { role: "inbox", source: "special_use" };

  const candidates = [f.specialUse, ...f.flags].filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase());
  for (const c of candidates) {
    const role = SPECIAL_USE_ROLES[c];
    if (role) return { role, source: "special_use" };
  }

  // Name rules only for top-level folders: "Customers/Sent" is a business folder, not the Sent folder.
  const segs = segments(f);
  if (segs.length === 1) {
    const role = NAME_INDEX.get(foldForMatch(f.name || segs[0]!));
    if (role) return { role, source: "name" };
  }
  return { role: "other", source: "name" };
}

/** Default sync selection: inbox, sent, archive, other business folders; never drafts/trash; junk only via prefilter. */
export function defaultSyncEnabled(role: FolderRole): boolean {
  switch (role) {
    case "inbox":
    case "sent":
    case "archive":
    case "other":
      return true;
    case "junk":
      // Synced so the rule pre-filter (SPAM_FOLDER) and the recall sample see it; never reaches the AI unless a known contact.
      return true;
    case "drafts":
    case "trash":
      return false;
  }
}

/** `\Noselect` / `\NonExistent` entries (namespace roots, phantom parents) cannot be opened. */
export function isSelectableFolder(f: ListedFolder): boolean {
  return !lowerFlags(f).some((x) => UNSELECTABLE_FLAGS.has(x));
}

/** Server-side views over other folders (`\All`, `\Flagged`): never synced by default (they duplicate real folders). */
export function isVirtualFolder(f: ListedFolder): boolean {
  const all = [f.specialUse ?? "", ...f.flags].map((x) => x.toLowerCase());
  return all.some((x) => VIRTUAL_FLAGS.has(x));
}

/** Sync default for a newly discovered folder. */
export function initialSyncEnabled(f: ListedFolder, role: FolderRole): boolean {
  return defaultSyncEnabled(role) && isSelectableFolder(f) && !isVirtualFolder(f);
}

/** imapflow LIST entry → ListedFolder. Only server-reported SPECIAL-USE counts; imapflow's own name guesses are ignored. */
/**
 * RFC 3501 §5.1: INBOX always exists. A LIST under a personal namespace prefix ("INBOX." on Dovecot/Courier/Plesk)
 * may leave INBOX itself out — imapflow's INBOX fix-up LIST is skipped with `listOnly` — and a missing INBOX would
 * be marked gone and never synced. Add it back when it is missing.
 */
export function ensureInbox(listed: ListedFolder[]): ListedFolder[] {
  if (listed.some((f) => f.path.toUpperCase() === "INBOX")) return listed;
  const delimiter = listed.find((f) => f.delimiter)?.delimiter ?? null;
  return [{ path: "INBOX", name: "INBOX", delimiter, flags: [], specialUse: null }, ...listed];
}

export function toListedFolder(entry: Pick<ListResponse, "path" | "name" | "delimiter" | "flags" | "specialUse" | "specialUseSource">): ListedFolder {
  const specialUse = entry.specialUse && (entry.specialUseSource === "extension" || entry.specialUseSource === "user") ? entry.specialUse : null;
  return {
    path: entry.path,
    name: entry.name,
    delimiter: entry.delimiter || null,
    flags: [...entry.flags].sort(),
    specialUse,
  };
}
