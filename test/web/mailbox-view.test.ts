import { describe, expect, it } from "vitest";
import type { OwnMailbox } from "../../src/server/api-types.js";
import type { KeyValueStore } from "../../web/src/api.js";
import { MailboxViewStore, VIEW_KEY_PREFIX, chosenMailbox, hasViews, mailboxName, mailboxNames, mailboxShortNames, newTaskMailbox, rowMailboxName, viewOf } from "../../web/src/mailbox-view.js";

const OWNER: OwnMailbox = { id: "11111111-1111-4111-8111-111111111111", address: "owner@contoso.example", displayName: null };
const PURCHASING: OwnMailbox = { id: "22222222-2222-4222-8222-222222222222", address: "purchasing@contoso.example", displayName: "Αγορές" };
const SALES: OwnMailbox = { id: "33333333-3333-4333-8333-333333333333", address: "sales@contoso.example", displayName: "  " };
const BOTH = [OWNER, PURCHASING];
const GONE = "99999999-9999-4999-8999-999999999999";

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

describe("the per-mailbox view: the choice", () => {
  it("starts with all mailboxes, and tells its listeners only when the choice really changes", () => {
    const store = new MailboxViewStore(memoryStore());
    let heard = 0;
    const leave = store.subscribe(() => heard++);
    expect(store.getSnapshot()).toBeNull();
    store.bindUser("u1");
    store.set(null);
    expect(heard).toBe(0);

    store.set(PURCHASING.id);
    expect(store.getSnapshot()).toBe(PURCHASING.id);
    store.set(PURCHASING.id);
    expect(heard).toBe(1);
    store.set(null);
    expect([store.getSnapshot(), heard]).toEqual([null, 2]);
    leave();
    store.set(OWNER.id);
    expect(heard).toBe(2);
  });

  it("survives a reload of the tab, per signed-in user; another user never gets it", () => {
    const tab = memoryStore();
    const first = new MailboxViewStore(tab);
    first.bindUser("u1");
    first.set(PURCHASING.id.toUpperCase());
    expect(tab.data.get(`${VIEW_KEY_PREFIX}u1`)).toBe(PURCHASING.id);

    // The page is loaded again in the same tab.
    const reloaded = new MailboxViewStore(tab);
    expect(reloaded.getSnapshot()).toBeNull();
    reloaded.bindUser("u1");
    expect(reloaded.getSnapshot()).toBe(PURCHASING.id);

    // Somebody else signs in on this tab: all of their mailboxes; the first user's choice is still theirs.
    reloaded.bindUser("u2");
    expect(reloaded.getSnapshot()).toBeNull();
    reloaded.set(OWNER.id);
    reloaded.bindUser("u1");
    expect(reloaded.getSnapshot()).toBe(PURCHASING.id);

    // Back to all of them: nothing is left behind.
    reloaded.set(null);
    expect(tab.data.has(`${VIEW_KEY_PREFIX}u1`)).toBe(false);
    expect(tab.data.get(`${VIEW_KEY_PREFIX}u2`)).toBe(OWNER.id);
  });

  it("takes only a mailbox id: anything else, also from the storage, is no view", () => {
    const tab = memoryStore();
    tab.data.set(`${VIEW_KEY_PREFIX}u1`, "<script>alert(1)</script>");
    const store = new MailboxViewStore(tab);
    store.bindUser("u1");
    expect(store.getSnapshot()).toBeNull();
    for (const bad of ["", "all", "1 or 1=1", `${PURCHASING.id}&tab=closed`]) {
      store.set(PURCHASING.id);
      store.set(bad);
      expect(store.getSnapshot(), bad).toBeNull();
    }
  });

  it("works without a storage and with one that throws: the choice then lasts until the page is reloaded", () => {
    const none = new MailboxViewStore(null);
    none.bindUser("u1");
    none.set(PURCHASING.id);
    expect(none.getSnapshot()).toBe(PURCHASING.id);

    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const store = new MailboxViewStore(broken);
    store.bindUser("u1");
    expect(store.getSnapshot()).toBeNull();
    store.set(OWNER.id);
    expect(store.getSnapshot()).toBe(OWNER.id);
    store.set(null);
    expect(store.getSnapshot()).toBeNull();
  });

  it("drops a view the user can no longer choose: a mailbox that is gone, or only one mailbox left", () => {
    const tab = memoryStore();
    const store = new MailboxViewStore(tab);
    store.bindUser("u1");

    store.set(PURCHASING.id);
    store.reconcile(BOTH);
    expect(store.getSnapshot()).toBe(PURCHASING.id);

    store.set(GONE);
    store.reconcile(BOTH);
    expect(store.getSnapshot()).toBeNull();
    expect(tab.data.size).toBe(0);

    // One mailbox left: a view of it would hide tasks that belong to no mailbox, with no switch to turn it off.
    store.set(OWNER.id);
    store.reconcile([OWNER]);
    expect(store.getSnapshot()).toBeNull();
    store.set(OWNER.id);
    store.reconcile([]);
    expect(store.getSnapshot()).toBeNull();

    // No view: nothing to do, nobody is told.
    let heard = 0;
    store.subscribe(() => heard++);
    store.reconcile(BOTH);
    expect(heard).toBe(0);
  });
});

describe("the per-mailbox view: what is shown", () => {
  it("is offered to a user with two or more mailboxes", () => {
    expect([hasViews([]), hasViews([OWNER]), hasViews(BOTH), hasViews([OWNER, PURCHASING, SALES])]).toEqual([false, false, true, true]);
    expect(viewOf(BOTH, PURCHASING.id)).toBe(PURCHASING);
    expect(viewOf(BOTH, null)).toBeNull();
    expect(viewOf(BOTH, GONE)).toBeNull();
    // Not before the mailboxes are known, and not for a single mailbox.
    expect(viewOf([], PURCHASING.id)).toBeNull();
    expect(viewOf([PURCHASING], PURCHASING.id)).toBeNull();
  });

  it("calls a mailbox by the name the user gave it, else by its address; equal names fall back to the addresses", () => {
    expect([...mailboxNames([OWNER, PURCHASING, SALES])]).toEqual([
      [OWNER.id, "owner@contoso.example"],
      [PURCHASING.id, "Αγορές"],
      [SALES.id, "sales@contoso.example"],
    ]);
    const twins = [
      { ...OWNER, displayName: "Contoso" },
      { ...PURCHASING, displayName: "CONTOSO " },
      { ...SALES, displayName: "Πωλήσεις" },
    ];
    expect([...mailboxNames(twins).values()]).toEqual(["owner@contoso.example", "purchasing@contoso.example", "Πωλήσεις"]);
    expect(mailboxName(BOTH, PURCHASING.id)).toBe("Αγορές");
    for (const none of [null, undefined, "", GONE]) expect(mailboxName(BOTH, none)).toBeNull();
  });

  it("cuts the names where room is short to what tells the mailboxes apart: the part before a shared domain", () => {
    const plain = { ...PURCHASING, displayName: null };
    // Addresses at one domain: the local parts are enough, and each is the start of the full name.
    expect([...mailboxShortNames([OWNER, plain, SALES]).values()]).toEqual(["owner", "purchasing", "sales"]);
    for (const [id, short] of mailboxShortNames([OWNER, plain, SALES])) expect(mailboxNames([OWNER, plain, SALES]).get(id)!.startsWith(short)).toBe(true);
    // A name the user gave stays whole next to a cut address.
    expect([...mailboxShortNames([OWNER, PURCHASING]).values()]).toEqual(["owner", "Αγορές"]);
    // Different domains: the domain is what tells them apart, nothing is cut.
    const other = { ...plain, address: "purchasing@other.example" };
    expect([...mailboxShortNames([OWNER, other]).values()]).toEqual(["owner@contoso.example", "purchasing@other.example"]);
    // The domain is compared without regard to case.
    expect([...mailboxShortNames([OWNER, { ...plain, address: "purchasing@CONTOSO.Example" }]).values()]).toEqual(["owner", "purchasing"]);
    // A cut name must not become the name of another mailbox: then nothing is cut.
    const named = { ...plain, displayName: "Owner" };
    expect([...mailboxShortNames([OWNER, named, SALES]).values()]).toEqual(["owner@contoso.example", "Owner", "sales@contoso.example"]);
    // One mailbox called by its address among named ones is still cut; none at all gives nothing.
    expect([...mailboxShortNames([PURCHASING, SALES]).values()]).toEqual(["Αγορές", "sales"]);
    expect(mailboxShortNames([]).size).toBe(0);
  });

  it("names a task's mailbox on its row only when that tells something: several mailboxes, all of them on screen", () => {
    expect(rowMailboxName(BOTH, null, PURCHASING.id)).toBe("Αγορές");
    expect(rowMailboxName(BOTH, null, OWNER.id)).toBe("owner@contoso.example");
    // Inside a view every row is of the same mailbox.
    expect(rowMailboxName(BOTH, PURCHASING.id, PURCHASING.id)).toBeNull();
    // One mailbox, a task entered by hand without one, a mailbox that is not the user's.
    expect(rowMailboxName([OWNER], null, OWNER.id)).toBeNull();
    expect(rowMailboxName(BOTH, null, null)).toBeNull();
    expect(rowMailboxName(BOTH, null, GONE)).toBeNull();
    // A stale view is no view: the rows are named.
    expect(rowMailboxName(BOTH, GONE, PURCHASING.id)).toBe("Αγορές");
  });

  it("offers a new task the mailbox being looked at, and sends only a mailbox that is still the user's", () => {
    expect(newTaskMailbox(BOTH, PURCHASING.id)).toBe(PURCHASING.id);
    expect(newTaskMailbox(BOTH, null)).toBe("");
    expect(newTaskMailbox(BOTH, GONE)).toBe("");
    expect(newTaskMailbox([], PURCHASING.id)).toBe("");

    expect(chosenMailbox(BOTH, PURCHASING.id)).toBe(PURCHASING.id);
    expect(chosenMailbox(BOTH, "")).toBeNull();
    expect(chosenMailbox(BOTH, GONE)).toBeNull();
    // A user with one mailbox is never asked: the server puts the task there.
    expect(chosenMailbox([OWNER], OWNER.id)).toBeNull();
  });
});
