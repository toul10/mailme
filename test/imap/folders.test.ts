import { describe, expect, it } from "vitest";
import { classifyFolder, defaultSyncEnabled, initialSyncEnabled, isSelectableFolder, isVirtualFolder, toListedFolder, type ListedFolder } from "../../src/mail/imap/folders.js";

const f = (path: string, opts: Partial<ListedFolder> = {}): ListedFolder => {
  const delimiter = opts.delimiter === undefined ? "." : opts.delimiter;
  const name = opts.name ?? (delimiter ? path.split(delimiter).pop()! : path);
  return { path, name, delimiter, flags: opts.flags ?? [], specialUse: opts.specialUse ?? null };
};

describe("classifyFolder", () => {
  it("INBOX is inbox whatever its case", () => {
    expect(classifyFolder(f("INBOX"))).toEqual({ role: "inbox", source: "special_use" });
    expect(classifyFolder(f("Inbox"))).toEqual({ role: "inbox", source: "special_use" });
  });

  it("SPECIAL-USE wins over the name", () => {
    expect(classifyFolder(f("Stuff", { specialUse: "\\Sent" }))).toEqual({ role: "sent", source: "special_use" });
    expect(classifyFolder(f("INBOX.Archive", { flags: ["\\HasNoChildren", "\\Trash"] }))).toEqual({ role: "trash", source: "special_use" });
    expect(classifyFolder(f("[Gmail]/All Mail", { delimiter: "/", specialUse: "\\All" }))).toEqual({ role: "other", source: "special_use" });
  });

  it("English, Outlook and Plesk/Dovecot names", () => {
    const cases: Array<[string, string]> = [
      ["INBOX.Sent", "sent"],
      ["Sent Items", "sent"],
      ["INBOX.Sent Messages", "sent"],
      ["Drafts", "drafts"],
      ["INBOX.Drafts", "drafts"],
      ["Outbox", "drafts"],
      ["Deleted Items", "trash"],
      ["INBOX.Trash", "trash"],
      ["Junk E-mail", "junk"],
      ["INBOX.spam", "junk"],
      ["Archive", "archive"],
      ["INBOX.Archives", "archive"],
    ];
    for (const [path, role] of cases) expect(classifyFolder(f(path)).role, path).toBe(role);
    expect(classifyFolder(f("INBOX.Sent")).source).toBe("name");
  });

  it("Greek names (accents and case folded)", () => {
    const cases: Array<[string, string]> = [
      ["Απεσταλμένα", "sent"],
      ["INBOX.Απεσταλμένα μηνύματα", "sent"],
      ["ΠΡΟΧΕΙΡΑ", "drafts"],
      ["Εξερχόμενα", "drafts"],
      ["Διαγραμμένα στοιχεία", "trash"],
      ["Κάδος απορριμμάτων", "trash"],
      ["Ανεπιθύμητη αλληλογραφία", "junk"],
      ["Αρχείο", "archive"],
    ];
    for (const [path, role] of cases) expect(classifyFolder(f(path)).role, path).toBe(role);
  });

  it("business subfolders stay other even when named like a system folder", () => {
    expect(classifyFolder(f("INBOX.Πελάτες"))).toEqual({ role: "other", source: "name" });
    expect(classifyFolder(f("Customers.Sent"))).toEqual({ role: "other", source: "name" });
    expect(classifyFolder(f("INBOX.ABC.Sent"))).toEqual({ role: "other", source: "name" });
  });
});

describe("sync defaults", () => {
  it("inbox, sent, archive, other and junk (pre-filter only) are synced; drafts and trash never", () => {
    expect(defaultSyncEnabled("inbox")).toBe(true);
    expect(defaultSyncEnabled("sent")).toBe(true);
    expect(defaultSyncEnabled("archive")).toBe(true);
    expect(defaultSyncEnabled("other")).toBe(true);
    expect(defaultSyncEnabled("junk")).toBe(true);
    expect(defaultSyncEnabled("drafts")).toBe(false);
    expect(defaultSyncEnabled("trash")).toBe(false);
  });

  it("virtual and non-selectable folders are not synced by default", () => {
    const all = f("[Gmail]/All Mail", { delimiter: "/", specialUse: "\\All" });
    expect(isVirtualFolder(all)).toBe(true);
    expect(initialSyncEnabled(all, "other")).toBe(false);
    const parent = f("Shared", { flags: ["\\Noselect", "\\HasChildren"] });
    expect(isSelectableFolder(parent)).toBe(false);
    expect(initialSyncEnabled(parent, "other")).toBe(false);
  });

  it("toListedFolder ignores imapflow's own name guesses", () => {
    const base = { path: "Sent", name: "Sent", delimiter: ".", flags: new Set(["\\HasNoChildren"]) };
    expect(toListedFolder({ ...base, specialUse: "\\Sent", specialUseSource: "name" }).specialUse).toBeNull();
    expect(toListedFolder({ ...base, specialUse: "\\Sent", specialUseSource: "extension" }).specialUse).toBe("\\Sent");
  });
});
