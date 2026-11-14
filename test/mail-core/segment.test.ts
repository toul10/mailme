import { describe, expect, it } from "vitest";
import { segmentBody } from "../../src/mail/segment.js";
import { htmlToItems, htmlToPlainText, decodeEntities } from "../../src/mail/html.js";

const kinds = (segs: ReturnType<typeof segmentBody>) => segs.map((s) => s.kind);
const text = (textPlain: string, opts = {}) => segmentBody({ textPlain, textHtml: null }, opts);
const html = (textHtml: string, opts = {}) => segmentBody({ textPlain: null, textHtml }, opts);

describe("segmentBody — plain text markers", () => {
  it("splits an Outlook EN header block and parses author/date", () => {
    const segs = text(`Please see below.

From: Γιάννης Γεωργίου <g@alfa.example>
Sent: Wednesday, September 9, 2026 10:02 AM
To: Owner <owner@contoso.example>
Subject: Offer

Can you send the offer?`);
    expect(segs).toEqual([
      { id: "S1", kind: "NEW", text: "Please see below.", author: null, date: null, truncated: false },
      { id: "S2", kind: "QUOTED", text: "Can you send the offer?", author: "Γιάννης Γεωργίου <g@alfa.example>", date: "2026-09-09T07:02:00Z", truncated: false },
    ]);
  });

  it("needs ≥ 3 distinct label lines including From (two labels are just text)", () => {
    const segs = text(`Θέμα: παραγγελία 44
Από: αποθήκη

κείμενο`);
    expect(kinds(segs)).toEqual(["NEW"]);
    expect(segs[0]!.text).toContain("Θέμα: παραγγελία 44");
  });

  it("handles Greek labels, the Outlook underscore rule and wrapped To lists", () => {
    const segs = text(`Εντάξει.

________________________________
Από: Νίκος <owner@contoso.example>
Στάλθηκε: Τρίτη, 8 Σεπτεμβρίου 2026 3:45 μ.μ.
Προς: Α <a@x.example>; Β <b@x.example>;
    Γ <c@x.example>
Κοιν.: Δ <d@x.example>
Θέμα: Προσφορά

Σας στέλνω την προσφορά.`);
    expect(kinds(segs)).toEqual(["NEW", "QUOTED"]);
    expect(segs[0]!.text).toBe("Εντάξει.");
    expect(segs[1]).toMatchObject({ author: "Νίκος <owner@contoso.example>", date: "2026-09-08T12:45:00Z", text: "Σας στέλνω την προσφορά." });
  });

  it("recognizes -----Original Message----- / -----Αρχικό μήνυμα----- with [mailto:] authors", () => {
    const segs = text(`OK.

-----Αρχικό μήνυμα-----
Από: John Carter [mailto:j.carter@northwind.example]
Ημερομηνία: Τρίτη, 8 Σεπτεμβρίου 2026 12:10 μ.μ.
Προς: Nikos
Θέμα: Contract

Signed contract attached.`);
    expect(segs[1]).toMatchObject({ kind: "QUOTED", author: "John Carter <j.carter@northwind.example>", date: "2026-09-08T09:10:00Z" });
  });

  it("marks a separator without a header block as a QUOTED boundary", () => {
    const segs = text("Top\n\n-----Original Message-----\nold stuff");
    expect(kinds(segs)).toEqual(["NEW", "QUOTED"]);
    expect(segs[1]!.author).toBeNull();
  });

  it("parses one-line header blocks", () => {
    const segs = text("Ναι.\n\nFrom: A <a@x.example> Sent: Wednesday, September 9, 2026 10:02 AM To: B Subject: Test\nold");
    expect(segs[1]).toMatchObject({ kind: "QUOTED", author: "A <a@x.example>", date: "2026-09-09T07:02:00Z", text: "old" });
  });

  it("handles 'On … wrote:' with > quotes, wrapped attribution and nested levels", () => {
    const segs = text(`Top reply

On Wed, Sep 9, 2026 at 2:15 PM Nikos Papadopoulos <owner@contoso.example>
wrote:

> Level one
>
> On Tue, Sep 8, 2026 at 9:00 AM John <j@x.example> wrote:
>> Level two
`);
    expect(segs.map((s) => [s.kind, s.author, s.date, s.text])).toEqual([
      ["NEW", null, null, "Top reply"],
      ["QUOTED", "Nikos Papadopoulos <owner@contoso.example>", "2026-09-09T11:15:00Z", "Level one"],
      ["QUOTED", "John <j@x.example>", "2026-09-08T06:00:00Z", "Level two"],
    ]);
  });

  it("handles the Greek Gmail attribution «Στις … ο/η … έγραψε:»", () => {
    const segs = text("Εντάξει.\n\nΣτις Τετ 9 Σεπ 2026 στις 10:02 π.μ., ο/η Νίκος <owner@contoso.example> έγραψε:\n> Καλημέρα");
    expect(segs[1]).toMatchObject({ kind: "QUOTED", author: "Νίκος <owner@contoso.example>", date: "2026-09-09T07:02:00Z", text: "Καλημέρα" });
  });

  it("keeps interleaved answers as separate NEW segments and reuses the quote's author", () => {
    const segs = text("On Thu, 10 Sep 2026 at 12:00, N <n@x.example> wrote:\n> Q1?\nA1.\n> Q2?\nA2.");
    expect(segs.map((s) => [s.kind, s.text, s.author])).toEqual([
      ["QUOTED", "Q1?", "N <n@x.example>"],
      ["NEW", "A1.", null],
      ["QUOTED", "Q2?", "N <n@x.example>"],
      ["NEW", "A2.", null],
    ]);
  });

  it("treats bare > quotes without attribution as QUOTED", () => {
    expect(kinds(text("> quoted\n\nmy answer"))).toEqual(["QUOTED", "NEW"]);
  });

  it("distinguishes FORWARDED: explicit markers", () => {
    const segs = text(`FYI

---------- Forwarded message ---------
From: Μαρία <m@vita.example>
Date: Tue, Sep 8, 2026 at 5:30 PM
Subject: Τιμοκατάλογος
To: Ελένη <e@delta.example>

Στείλτε μου τον τιμοκατάλογο.`);
    expect(segs[1]).toMatchObject({ kind: "FORWARDED", author: "Μαρία <m@vita.example>", date: "2026-09-08T14:30:00Z" });
    expect(kinds(text("Δες.\n\n---------- Προωθημένο μήνυμα ---------\nΑπό: Α <a@x.example>\nDate: Τρί, 8 Σεπ 2026 στις 5:30 μ.μ.\nSubject: Θ\nTo: Β\n\nκείμενο"))).toEqual(["NEW", "FORWARDED"]);
    expect(kinds(text("See below\n\nBegin forwarded message:\n\nFrom: A <a@x.example>\nSubject: S\nDate: 9 September 2026 at 10:00:00 EEST\nTo: B\n\nbody"))).toEqual(["NEW", "FORWARDED"]);
  });

  it("distinguishes FORWARDED: FW/ΠΡΘ subject makes the first header block FORWARDED, later ones QUOTED", () => {
    const body = `Γιώργο, μπορείς να το αναλάβεις;

Από: Πελάτης <p@vita.example>
Στάλθηκε: Πέμπτη, 10 Σεπτεμβρίου 2026 9:20 π.μ.
Προς: Νίκος <owner@contoso.example>
Θέμα: ΑΠ: Παραγγελία

Θέλουμε 5 μικρόφωνα.

Από: Νίκος <owner@contoso.example>
Στάλθηκε: Τετάρτη, 9 Σεπτεμβρίου 2026 9:00 π.μ.
Προς: Πελάτης <p@vita.example>
Θέμα: Παραγγελία

Τι χρειάζεστε;`;
    expect(kinds(text(body, { subject: "ΠΡΘ: ΑΠ: Παραγγελία" }))).toEqual(["NEW", "FORWARDED", "QUOTED"]);
    expect(kinds(text(body, { subject: "ΑΠ: ΠΡΘ: Παραγγελία" }))).toEqual(["NEW", "QUOTED", "QUOTED"]);
    expect(kinds(text(body))).toEqual(["NEW", "QUOTED", "QUOTED"]);
  });

  it("drops an empty NEW part (pure forward) so the forwarded content is S1", () => {
    const segs = text("From: A <a@x.example>\nSent: Wednesday, September 9, 2026 10:02 AM\nTo: B\nSubject: S\n\nbody", { subject: "FW: S" });
    expect(segs.map((s) => [s.id, s.kind])).toEqual([["S1", "FORWARDED"]]);
  });

  it("uses the zone option for quoted dates", () => {
    const segs = text("x\n\nFrom: A\nSent: Wednesday, September 9, 2026 10:02 AM\nTo: B\nSubject: S\n\ny", { zone: "UTC" });
    expect(segs[1]!.date).toBe("2026-09-09T10:02:00Z");
  });
});

describe("segmentBody — HTML", () => {
  it("splits at Outlook's border-top header div (desktop) and parses the Greek header", () => {
    const segs = html(`<div class=WordSection1><p class=MsoNormal>Νέο κείμενο<o:p></o:p></p><p class=MsoNormal><o:p>&nbsp;</o:p></p>
<div style='border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm'><p class=MsoNormal><b>Από:</b> Α &lt;a@x.example&gt;<br><b>Στάλθηκε:</b> Τρίτη, 8 Σεπτεμβρίου 2026 3:45 μ.μ.<br><b>Προς:</b> Β<br><b>Θέμα:</b> Θ<o:p></o:p></p></div>
<p class=MsoNormal>Παλιό κείμενο<o:p></o:p></p></div>`);
    expect(segs.map((s) => [s.kind, s.text, s.author, s.date])).toEqual([
      ["NEW", "Νέο κείμενο", null, null],
      ["QUOTED", "Παλιό κείμενο", "Α <a@x.example>", "2026-09-08T12:45:00Z"],
    ]);
  });

  it("splits at divRplyFwdMsg even when labels are in an unknown language", () => {
    const segs = html(`<div>Nuevo</div><hr><div id="divRplyFwdMsg"><b>De:</b> A<br><b>Enviado:</b> x<br><b>Para:</b> B<br><b>Asunto:</b> y</div><div>Viejo</div>`);
    expect(kinds(segs)).toEqual(["NEW", "QUOTED"]);
    expect(segs[1]!.text).toBe("Viejo");
  });

  it("OWA forward: the empty appendonsend marker does not steal the FORWARDED slot", () => {
    const body = `<div>Γιώργο, δες το παρακάτω.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><b>From:</b> Πελάτης &lt;p@vita.example&gt;<br><b>Sent:</b> Thursday, September 10, 2026 9:20 AM<br><b>To:</b> Owner<br><b>Subject:</b> Παραγγελία</div><div>Θέλουμε 5 μικρόφωνα.</div><div style="border:none;border-top:solid #E1E1E1 1.0pt"><p><b>From:</b> Owner<br><b>Sent:</b> Wednesday, September 9, 2026 9:00 AM<br><b>To:</b> Πελάτης<br><b>Subject:</b> Παραγγελία</p></div><p>Τι χρειάζεστε;</p>`;
    const segs = html(body, { subject: "FW: Παραγγελία" });
    expect(segs.map((s) => [s.kind, s.text, s.author])).toEqual([
      ["NEW", "Γιώργο, δες το παρακάτω.", null],
      ["FORWARDED", "Θέλουμε 5 μικρόφωνα.", "Πελάτης <p@vita.example>"],
      ["QUOTED", "Τι χρειάζεστε;", "Owner"],
    ]);
    expect(segs[1]!.date).toBe("2026-09-10T06:20:00Z");
  });

  it("splits Gmail gmail_quote/gmail_attr/blockquote and drops gmail_signature", () => {
    const segs = html(`<div dir="ltr">Hello<div class="gmail_signature" data-smartmail="gmail_signature">-- <br>Sig Name<br>+30 210 0000000</div></div><div class="gmail_quote"><div class="gmail_attr">On Wed, Sep 9, 2026 at 2:15 PM A &lt;a@x.example&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid">Old<br></blockquote></div><div>trailing after quote</div>`);
    expect(segs.map((s) => [s.kind, s.text])).toEqual([
      ["NEW", "Hello"],
      ["QUOTED", "Old"],
      ["NEW", "trailing after quote"],
    ]);
    expect(segs[1]!.author).toBe("A <a@x.example>");
  });

  it("treats Gmail forward containers as FORWARDED", () => {
    const segs = html(`<div>FYI</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: A &lt;a@x.example&gt;<br>Date: Tue, Sep 8, 2026 at 5:30 PM<br>Subject: S<br>To: B<br></div><br>Forwarded body</div>`);
    expect(segs.map((s) => [s.kind, s.text, s.author])).toEqual([
      ["NEW", "FYI", null],
      ["FORWARDED", "Forwarded body", "A <a@x.example>"],
    ]);
  });

  it("does not treat an indentation-only blockquote as a quote", () => {
    const segs = html(`<div>Λίστα:</div><blockquote style="margin:0 0 0 40px;border:none;padding:0px"><div>- 5 ηχεία</div></blockquote>`);
    expect(kinds(segs)).toEqual(["NEW"]);
    expect(segs[0]!.text).toBe("Λίστα:\n- 5 ηχεία");
  });

  it("drops Outlook's _MailAutoSig signature, hidden elements, styles and comments", () => {
    const segs = html(`<html><head><style>p{}</style><title>t</title></head><body><!--[if gte mso 9]><xml>junk</xml><![endif]--><span style="display:none">preheader</span><p>Κείμενο</p><p><a name="_MailAutoSig">Με εκτίμηση,</a></p><p>Όνομα</p><p>Τ: 210 0000000</p></body></html>`);
    expect(segs.map((s) => s.text)).toEqual(["Κείμενο"]);
  });

  it("falls back to the text part when the HTML has no text", () => {
    const segs = segmentBody({ textPlain: "Plain body", textHtml: `<html><body><img src="cid:x"></body></html>` });
    expect(segs[0]!.text).toBe("Plain body");
  });

  it("renders tables, lists, entities and <pre>", () => {
    expect(htmlToPlainText(`<table><tr><td>Α</td><td>2 τεμ.</td></tr><tr><td>Β</td><td>5&nbsp;τεμ.</td></tr></table><ul><li>ένα</li><li>δύο</li></ul><pre>a\n  b</pre>`)).toBe(
      "Α | 2 τεμ.\nΒ | 5\xa0τεμ.\n- ένα\n- δύο\na\n  b",
    );
    expect(decodeEntities("&laquo;&#913;&#x3a0;&raquo; &amp; &unknown; &#150;")).toBe("«ΑΠ» & &unknown; –");
  });

  it("is linear on hostile input (deep nesting, unclosed tags)", () => {
    const hostile = "<div>".repeat(20000) + "x" + "<blockquote>".repeat(5000) + "</span>".repeat(20000) + "<a " + "b".repeat(50000);
    const t0 = Date.now();
    const items = htmlToItems(hostile);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(items.some((i) => i.t === "text" && i.text === "x")).toBe(true);
  });
});

describe("segmentBody — signatures, disclaimers, caps", () => {
  it("cuts a closing + name/contact block but keeps the closing line", () => {
    const segs = text(`Καλημέρα,

Θα σας στείλω την προσφορά αύριο.

Με εκτίμηση,
Νίκος Παπαδόπουλος
Sales Manager
Τ: 210 1234567
www.contoso.example`);
    expect(segs[0]!.text).toBe("Καλημέρα,\n\nΘα σας στείλω την προσφορά αύριο.\n\nΜε εκτίμηση,");
  });

  it("does not cut content that follows a closing-like word", () => {
    const t = "Γεια σου Γιάννη,\nΕυχαριστώ\nθα σου στείλω το τιμολόγιο αύριο";
    expect(text(t)[0]!.text).toBe(t);
    const t2 = "Ευχαριστώ,\nΤο τιμολόγιο θα σταλεί αύριο.";
    expect(text(t2)[0]!.text).toBe(t2);
    const t3 = "Hi,\nThanks,\nJohn\n\nP.S. Please also send the manual.";
    expect(text(t3)[0]!.text).toBe(t3);
  });

  it("cuts '-- ' signatures and mobile footers", () => {
    expect(text("Body\n\n-- \nJohn\nACME")[0]!.text).toBe("Body");
    expect(text("Εντάξει\n\nΣτάλθηκε από το iPhone μου")[0]!.text).toBe("Εντάξει");
    expect(text("OK\n\nSent from my iPhone")[0]!.text).toBe("OK");
    expect(text("OK\n\nGet Outlook for Android")[0]!.text).toBe("OK");
  });

  it("cuts legal disclaimers (EL/EN) but not ordinary sentences starting alike", () => {
    expect(
      text("Στείλτε μου το τιμολόγιο.\n\nΤο παρόν μήνυμα και τα συνημμένα του είναι εμπιστευτικά και προορίζονται αποκλειστικά για τον παραλήπτη.")[0]!.text,
    ).toBe("Στείλτε μου το τιμολόγιο.");
    expect(text("OK\n\nPlease consider the environment before printing this email.")[0]!.text).toBe("OK");
    expect(text("OK\n\nThis e-mail and any attachments are confidential and intended solely for the addressee.")[0]!.text).toBe("OK");
    const legit = "This email is to confirm our order. Please print the invoice and sign it.";
    expect(text(legit)[0]!.text).toBe(legit);
  });

  it("cuts a trailing contact block without a closing, unless it is introduced as content", () => {
    expect(text("Στείλτε μου την προσφορά.\n\nΓιάννης Γεωργίου\nΤ: 210 5551234\nΚ: 694 5551234\nwww.alfa.example")[0]!.text).toBe("Στείλτε μου την προσφορά.");
    const delivery = "Η παράδοση θα γίνει εδώ:\n\nΛεωφ. Κηφισίας 100\n115 26 Αθήνα\nΤηλ: 210 5551234";
    expect(text(delivery)[0]!.text).toBe(delivery);
  });

  it("strips disclaimers inside QUOTED segments too", () => {
    const segs = text("Top\n\nFrom: A\nSent: Wednesday, September 9, 2026 10:02 AM\nTo: B\nSubject: S\n\nOld body\n\nDisclaimer: this message is confidential.");
    expect(segs[1]!.text).toBe("Old body");
  });

  it("caps QUOTED segments and the total, NEW first", () => {
    const longQuote = "q".repeat(5000);
    const segs = text(`New text\n\nFrom: A\nSent: Wednesday, September 9, 2026 10:02 AM\nTo: B\nSubject: S\n\n${longQuote}`, { quotedCap: 100 });
    expect(segs[1]!.text.length).toBe(100);
    expect(segs[1]!.truncated).toBe(true);
    expect(segs[0]!.truncated).toBe(false);

    const bigNew = "n".repeat(300);
    const capped = text(`${bigNew}\n\nFrom: A\nSent: Wednesday, September 9, 2026 10:02 AM\nTo: B\nSubject: S\n\nquoted text`, { maxTotal: 200 });
    expect(capped.map((s) => [s.kind, s.text.length, s.truncated])).toEqual([["NEW", 200, true]]);
  });

  it("keeps long lines whole and stays fast on large or pathological plain text", () => {
    const long = "λέξη ".repeat(3000).trim();
    expect(text(long, { maxTotal: 100_000 })[0]!.text).toBe(long);
    const t0 = Date.now();
    segmentBody({ textPlain: ("From: x ".repeat(20000) + "\n").repeat(20) + "> ".repeat(50000), textHtml: null });
    segmentBody({ textPlain: "1 ".repeat(200_000), textHtml: null });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("returns [] for empty input and keeps ids sequential", () => {
    expect(segmentBody({ textPlain: null, textHtml: null })).toEqual([]);
    expect(segmentBody({ textPlain: "  \n\n ", textHtml: null })).toEqual([]);
    const segs = text("> a\nb\n> c\nd");
    expect(segs.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4"]);
  });
});
