/**
 * Generates the synthetic .eml fixtures in this directory (run: `npx tsx test/fixtures/mail-core/build-fixtures.ts`).
 * All people, companies and addresses are invented. Output is ASCII-only (Greek text is QP/base64/RFC 2047
 * encoded) with CRLF line endings, so editors and git can't mangle the bytes. The .eml files are committed;
 * this script documents their readable source.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const CRLF = "\r\n";

// ── Encoding helpers ─────────────────────────────────────────────────────────

function wrap(s: string, width = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += width) lines.push(s.slice(i, i + width));
  return lines.join(CRLF);
}

const b64 = (bytes: Buffer) => wrap(bytes.toString("base64"));

function qp(bytes: Buffer): string {
  const out: string[] = [];
  let line = "";
  const push = (tok: string) => {
    if (line.length + tok.length > 75) {
      out.push(line + "=");
      line = "";
    }
    line += tok;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x0d && bytes[i + 1] === 0x0a) {
      out.push(line);
      line = "";
      i++;
      continue;
    }
    if (b === 0x0a) {
      out.push(line);
      line = "";
      continue;
    }
    const isLast = i + 1 >= bytes.length || bytes[i + 1] === 0x0d || bytes[i + 1] === 0x0a;
    if ((b >= 33 && b <= 126 && b !== 61) || (b === 32 && !isLast)) push(String.fromCharCode(b));
    else push("=" + b.toString(16).toUpperCase().padStart(2, "0"));
  }
  out.push(line);
  return out.join(CRLF);
}

const utf8 = (s: string) => Buffer.from(s.replace(/\r?\n/g, CRLF), "utf8");

/** Greek + ASCII → windows-1253 (or iso-8859-7) bytes. */
function greek8(s: string, charset: "windows-1253" | "iso-8859-7" = "windows-1253"): Buffer {
  const special: Record<string, number> = { "€": 0x80, "«": 0xab, "»": 0xbb, "–": 0x96, "’": 0x92, "·": 0xb7, "°": 0xb0 };
  const bytes: number[] = [];
  for (const ch of s.replace(/\r?\n/g, CRLF)) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) bytes.push(cp);
    else if (cp === 0x386) bytes.push(charset === "windows-1253" ? 0xa2 : 0xb6);
    else if (cp >= 0x388 && cp <= 0x3ce && cp !== 0x38b && cp !== 0x38d) bytes.push(cp - 0x2d0);
    else if (special[ch] !== undefined && charset === "windows-1253") bytes.push(special[ch]!);
    else bytes.push(0x3f);
  }
  return Buffer.from(bytes);
}

/** RFC 2047 B-encoding for non-ASCII header text (split at character boundaries). */
function enc(s: string): string {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let chunk = "";
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, "utf8") > 42) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join(CRLF + " ");
}

const addr = (name: string, email: string) => `${/^[\x20-\x7e]*$/.test(name) ? `"${name}"` : enc(name)} <${email}>`;

type Headers = Array<[string, string]>;

function renderHeaders(h: Headers): string {
  return h.map(([k, v]) => `${k}: ${v}`).join(CRLF);
}

function leaf(contentType: string, body: Buffer | string, opts: { cte?: "quoted-printable" | "base64" | "7bit"; extra?: Headers } = {}): string {
  const cte = opts.cte ?? "quoted-printable";
  const bytes = typeof body === "string" ? utf8(body) : body;
  const encoded = cte === "base64" ? b64(bytes) : cte === "quoted-printable" ? qp(bytes) : bytes.toString("latin1");
  return renderHeaders([["Content-Type", contentType], ["Content-Transfer-Encoding", cte], ...(opts.extra ?? [])]) + CRLF + CRLF + encoded;
}

function multipart(subtype: string, boundary: string, parts: string[], params = ""): string {
  return (
    `Content-Type: multipart/${subtype}; boundary="${boundary}"${params}` +
    CRLF +
    CRLF +
    parts.map((p) => `--${boundary}${CRLF}${p}`).join(CRLF) +
    CRLF +
    `--${boundary}--` +
    CRLF
  );
}

function message(h: Headers, body: string): string {
  return renderHeaders([...h, ["MIME-Version", "1.0"]]) + CRLF + body + (body.endsWith(CRLF) ? "" : CRLF);
}

function write(name: string, content: string) {
  if (!/^[\x00-\x7f]*$/.test(content)) throw new Error(`${name}: non-ASCII output`);
  writeFileSync(join(OUT, name), content.replace(/\r?\n/g, CRLF), "latin1");
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const htmlLines = (s: string) => s.split("\n").map((l) => (l ? `<p class=MsoNormal>${escapeHtml(l)}<o:p></o:p></p>` : `<p class=MsoNormal><o:p>&nbsp;</o:p></p>`)).join("\n");

// ── People (all invented) ────────────────────────────────────────────────────

const OWNER = addr("Νίκος Παπαδόπουλος", "owner@contoso.example");
const COLLEAGUE = addr("Γιώργος Αντωνίου", "g.antoniou@contoso.example");
const ALFA = addr("Γιάννης Γεωργίου", "g.georgiou@alfa-ilektroniki.example");
const VITA = addr("Μαρία Κωνσταντίνου", "m.konstantinou@vita-texniki.example");
const NORTHWIND = addr("John Carter", "j.carter@northwind-audio.example");
const DELTA = addr("Ελένη Δημητρίου", "eleni@delta-events.example");

const OUTLOOK_HEAD = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style><!--
p.MsoNormal {margin:0cm; font-size:11.0pt; font-family:"Calibri",sans-serif;}
--></style><!--[if gte mso 9]><xml><o:shapedefaults v:ext="edit" spidmax="1026" /></xml><![endif]--></head><body lang=EL link="#0563C1"><div class=WordSection1>`;

// ── 1. Greek Outlook reply (inbound, HTML + text, _MailAutoSig, disclaimer) ─

{
  const text = `Καλημέρα κύριε Παπαδόπουλε,

Ευχαριστούμε για την προσφορά. Μπορείτε να μας στείλετε και τα τεχνικά φυλλάδια των ηχείων μέχρι την Πέμπτη;

Με εκτίμηση,
Γιάννης Γεωργίου
Υπεύθυνος Προμηθειών
Άλφα Ηλεκτρονική Α.Ε.
Τ: 210 5551234 | Κ: 694 5551234
www.alfa-ilektroniki.example

Το παρόν μήνυμα και τυχόν συνημμένα του είναι εμπιστευτικά και προορίζονται αποκλειστικά για τον παραλήπτη. Αν το λάβατε κατά λάθος, παρακαλούμε ενημερώστε τον αποστολέα.

Από: Νίκος Παπαδόπουλος <owner@contoso.example>
Στάλθηκε: Τρίτη, 8 Σεπτεμβρίου 2026 3:45 μ.μ.
Προς: Γιάννης Γεωργίου <g.georgiou@alfa-ilektroniki.example>
Κοιν.: Γιώργος Αντωνίου <g.antoniou@contoso.example>
Θέμα: Προσφορά ηχείων για το συνεδριακό κέντρο

Κύριε Γεωργίου,

Σας επισυνάπτω την προσφορά για τα 20 ηχεία οροφής.

Νίκος`;
  const html = `${OUTLOOK_HEAD}
<p class=MsoNormal>Καλημέρα κύριε Παπαδόπουλε,<o:p></o:p></p>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
<p class=MsoNormal>Ευχαριστούμε για την προσφορά. Μπορείτε να μας στείλετε και τα τεχνικά φυλλάδια των ηχείων μέχρι την Πέμπτη;<o:p></o:p></p>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
<p class=MsoNormal><a name="_MailAutoSig"><span>Με εκτίμηση,</span></a><o:p></o:p></p>
<p class=MsoNormal><b>Γιάννης Γεωργίου</b><o:p></o:p></p>
<p class=MsoNormal>Υπεύθυνος Προμηθειών<o:p></o:p></p>
<p class=MsoNormal>Άλφα Ηλεκτρονική Α.Ε.<o:p></o:p></p>
<p class=MsoNormal>Τ: 210 5551234 | Κ: 694 5551234<o:p></o:p></p>
<p class=MsoNormal><span style="font-size:8.0pt;color:gray">Το παρόν μήνυμα και τυχόν συνημμένα του είναι εμπιστευτικά και προορίζονται αποκλειστικά για τον παραλήπτη.</span><o:p></o:p></p>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">
<p class=MsoNormal><b>Από:</b> Νίκος Παπαδόπουλος &lt;owner@contoso.example&gt; <br><b>Στάλθηκε:</b> Τρίτη, 8 Σεπτεμβρίου 2026 3:45 μ.μ.<br><b>Προς:</b> Γιάννης Γεωργίου &lt;g.georgiou@alfa-ilektroniki.example&gt;<br><b>Κοιν.:</b> Γιώργος Αντωνίου &lt;g.antoniou@contoso.example&gt;<br><b>Θέμα:</b> Προσφορά ηχείων για το συνεδριακό κέντρο<o:p></o:p></p></div></div>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
<p class=MsoNormal>Κύριε Γεωργίου,<o:p></o:p></p>
<p class=MsoNormal><o:p>&nbsp;</o:p></p>
<p class=MsoNormal>Σας επισυνάπτω την προσφορά για τα 20 ηχεία οροφής.<o:p></o:p></p>
<p class=MsoNormal>Νίκος<o:p></o:p></p>
</div></body></html>`;
  write(
    "el-outlook-reply.eml",
    message(
      [
        ["Return-Path", "<g.georgiou@alfa-ilektroniki.example>"],
        ["Delivered-To", "owner@contoso.example"],
        ["From", ALFA],
        ["To", OWNER],
        ["CC", COLLEAGUE],
        ["Subject", enc("ΑΠ: Προσφορά ηχείων για το συνεδριακό κέντρο")],
        ["Thread-Topic", enc("Προσφορά ηχείων για το συνεδριακό κέντρο")],
        ["Thread-Index", "AQHc8e2Qx1bXfT0uS0WmI3mZ5Gm1YrJ+AbCdEfGh"],
        ["Date", "Wed, 9 Sep 2026 10:02:11 +0300"],
        ["Message-ID", "<AM9P193MB1234ALFA0001@AM9P193MB1234.eurprd09.prod.outlook.example>"],
        ["References", "<owner-offer-1@contoso.example>"],
        ["In-Reply-To", "<owner-offer-1@contoso.example>"],
        ["X-Mailer", "Microsoft Outlook 16.0"],
      ],
      multipart("alternative", "b1_alfa", [leaf("text/plain; charset=\"utf-8\"", text), leaf("text/html; charset=\"utf-8\"", html)]),
    ),
  );
}

// ── 2. Owner's original offer (Sent copy, no trace, PDF + inline logo) ───────

{
  const text = `Κύριε Γεωργίου,

Σας επισυνάπτω την προσφορά για τα 20 ηχεία οροφής.

Νίκος`;
  const html = `${OUTLOOK_HEAD}
${htmlLines(text)}
<p class=MsoNormal><img width=120 height=40 src="cid:image001.png@01DB0000.00000000" alt="Contoso"><o:p></o:p></p>
</div></body></html>`;
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4170000000049454e44ae426082", "hex");
  const pdf = Buffer.from("%PDF-1.4\n% synthetic fixture\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n", "latin1");
  const related = multipart("related", "b2_rel", [
    multipart("alternative", "b2_alt", [leaf("text/plain; charset=\"utf-8\"", text), leaf("text/html; charset=\"utf-8\"", html)]).trimEnd(),
    leaf("image/png; name=\"image001.png\"", png, {
      cte: "base64",
      extra: [["Content-ID", "<image001.png@01DB0000.00000000>"], ["Content-Disposition", "inline; filename=\"image001.png\""]],
    }),
  ], "; type=\"multipart/alternative\"").trimEnd();
  write(
    "outbound-offer.eml",
    message(
      [
        ["From", OWNER],
        ["To", ALFA],
        ["CC", COLLEAGUE],
        ["Subject", enc("Προσφορά ηχείων για το συνεδριακό κέντρο")],
        ["Thread-Topic", enc("Προσφορά ηχείων για το συνεδριακό κέντρο")],
        ["Thread-Index", "AQHc8e2Qx1bXfT0uS0WmI3mZ5Gm1Yg=="],
        ["Date", "Tue, 8 Sep 2026 15:45:02 +0300"],
        ["Message-ID", "<owner-offer-1@contoso.example>"],
        ["X-Mailer", "Microsoft Outlook 16.0"],
      ],
      multipart("mixed", "b2_mix", [
        related,
        leaf("application/pdf; name=\"Prosfora_Alfa_v2.pdf\"", pdf, { cte: "base64", extra: [["Content-Disposition", "attachment; filename=\"Prosfora_Alfa_v2.pdf\""]] }),
      ]),
    ),
  );
}

// ── 3. English Outlook 365 reply with divRplyFwdMsg and two older messages ──

{
  const html = `<html><head><style type="text/css" style="display:none;"> P {margin-top:0;margin-bottom:0;} </style></head><body dir="ltr">
<div style="font-family: Aptos, sans-serif; font-size: 12pt;">Hi Nikos,</div>
<div style="font-family: Aptos, sans-serif; font-size: 12pt;"><br></div>
<div style="font-family: Aptos, sans-serif; font-size: 12pt;">Could you confirm the delivery of the 4 amplifiers for Monday 14/9? We need them installed before the event.</div>
<div style="font-family: Aptos, sans-serif; font-size: 12pt;"><br></div>
<div id="Signature"><p>Best regards,<br>John Carter<br>Procurement | Northwind Audio Ltd<br>+44 20 7946 0000</p></div>
<div id="appendonsend"></div>
<hr style="display:inline-block;width:98%" tabindex="-1">
<div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000"><b>From:</b> Nikos Papadopoulos &lt;owner@contoso.example&gt;<br><b>Sent:</b> Thursday, September 10, 2026 4:12 PM<br><b>To:</b> John Carter &lt;j.carter@northwind-audio.example&gt;<br><b>Subject:</b> RE: Amplifiers order NW-2291</font><div>&nbsp;</div></div>
<div><p>Dear John,</p><p>The amplifiers are in stock. We can deliver early next week.</p><p>Kind regards,<br>Nikos</p>
<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class=MsoNormal><b>From:</b> John Carter &lt;j.carter@northwind-audio.example&gt;<br><b>Sent:</b> Wednesday, September 9, 2026 11:30 AM<br><b>To:</b> Nikos Papadopoulos &lt;owner@contoso.example&gt;<br><b>Subject:</b> Amplifiers order NW-2291</p></div>
<p>Hello Nikos, please quote 4 x Class-D amplifiers, 2x500W.</p>
<p>This e-mail and any attachments are confidential and intended solely for the addressee. If you have received it in error please notify the sender.</p>
</div></body></html>`;
  const text = `Hi Nikos,

Could you confirm the delivery of the 4 amplifiers for Monday 14/9? We need them installed before the event.

Best regards,
John Carter
Procurement | Northwind Audio Ltd
+44 20 7946 0000

________________________________
From: Nikos Papadopoulos <owner@contoso.example>
Sent: Thursday, September 10, 2026 4:12 PM
To: John Carter <j.carter@northwind-audio.example>
Subject: RE: Amplifiers order NW-2291

Dear John,

The amplifiers are in stock. We can deliver early next week.

Kind regards,
Nikos

From: John Carter <j.carter@northwind-audio.example>
Sent: Wednesday, September 9, 2026 11:30 AM
To: Nikos Papadopoulos <owner@contoso.example>
Subject: Amplifiers order NW-2291

Hello Nikos, please quote 4 x Class-D amplifiers, 2x500W.`;
  write(
    "en-outlook-reply.eml",
    message(
      [
        ["Return-Path", "<j.carter@northwind-audio.example>"],
        ["Delivered-To", "owner@contoso.example"],
        ["From", NORTHWIND],
        ["To", addr("Nikos Papadopoulos", "owner@contoso.example")],
        ["Subject", "RE: RE: Amplifiers order NW-2291"],
        ["Date", "Fri, 11 Sep 2026 09:15:40 +0100"],
        ["Message-ID", "<DB9PR07MB0001NW@DB9PR07MB0001.eurprd07.prod.outlook.example>"],
        ["In-Reply-To", "<owner-nw-2@contoso.example>"],
        ["References", "<nw-1@northwind-audio.example> <owner-nw-2@contoso.example>"],
        ["Thread-Index", "AQHc8f1aBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQq"],
      ],
      multipart("alternative", "b3_alt", [leaf("text/plain; charset=\"us-ascii\"", text), leaf("text/html; charset=\"us-ascii\"", html)]),
    ),
  );
}

// ── 4. ΠΡΘ (Greek FW) forward from the owner to a colleague (Sent copy) ─────

{
  const text = `Γιώργο, μπορείς να το αναλάβεις; Θέλουν απάντηση μέχρι την Παρασκευή.

Νίκος

Από: Μαρία Κωνσταντίνου <m.konstantinou@vita-texniki.example>
Στάλθηκε: Πέμπτη, 10 Σεπτεμβρίου 2026 9:20 π.μ.
Προς: Νίκος Παπαδόπουλος <owner@contoso.example>
Θέμα: Παραγγελία 4471

Καλημέρα,

Θα θέλαμε να παραγγείλουμε 5 ασύρματα μικρόφωνα και 2 κονσόλες. Παρακαλούμε επιβεβαιώστε διαθεσιμότητα και χρόνο παράδοσης.

Μαρία Κωνσταντίνου
Βήτα Τεχνική Ο.Ε.`;
  write(
    "el-forward-prth.eml",
    message(
      [
        ["From", OWNER],
        ["To", COLLEAGUE],
        ["Subject", enc("ΠΡΘ: Παραγγελία 4471")],
        ["Date", "Thu, 10 Sep 2026 10:05:00 +0300"],
        ["Message-ID", "<owner-fwd-4471@contoso.example>"],
        ["Thread-Index", "AQHc8f9zVbVbVbVbVbVbVbVbVbVbVbVbVbVbVbVbVb"],
        ["X-Mailer", "Microsoft Outlook 16.0"],
      ],
      leaf("text/plain; charset=\"utf-8\"", text),
    ),
  );
}

// ── 5. Gmail reply, English (HTML with gmail_quote + signature) ──────────────

{
  const html = `<div dir="ltr">Hi Nikos,<div><br></div><div>Thanks, the price list works for us. Please send the invoice for the 2 subwoofers by Friday.</div><div><br></div><div>Cheers,</div><div><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr">Eleni Dimitriou<br>Delta Events<br>+30 697 000 0000</div></div></div></div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Wed, Sep 9, 2026 at 2:15&#8239;PM Nikos Papadopoulos &lt;<a href="mailto:owner@contoso.example">owner@contoso.example</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Dear Eleni,<br><br>Attached is our price list for 2027.<br><br>Best,<br>Nikos</div></blockquote></div>`;
  const text = `Hi Nikos,

Thanks, the price list works for us. Please send the invoice for the 2
subwoofers by Friday.

Cheers,
--
Eleni Dimitriou
Delta Events
+30 697 000 0000

On Wed, Sep 9, 2026 at 2:15 PM Nikos Papadopoulos <owner@contoso.example>
wrote:

> Dear Eleni,
>
> Attached is our price list for 2027.
>
> Best,
> Nikos
`;
  write(
    "gmail-reply-en.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["Return-Path", "<eleni@delta-events.example>"],
        ["From", addr("Eleni Dimitriou", "eleni@delta-events.example")],
        ["To", addr("Nikos Papadopoulos", "owner@contoso.example")],
        ["Subject", "Re: Price list 2027"],
        ["Date", "Thu, 10 Sep 2026 11:20:05 +0300"],
        ["Message-ID", "<CAF=delta0001+abc@mail.gmail.example>"],
        ["In-Reply-To", "<owner-pricelist-1@contoso.example>"],
        ["References", "<owner-pricelist-1@contoso.example>"],
      ],
      multipart("alternative", "b5_alt", [leaf("text/plain; charset=\"UTF-8\"", text), leaf("text/html; charset=\"UTF-8\"", html)]),
    ),
  );
}

// ── 6. Gmail reply, Greek, text/plain with wrapped attribution ───────────────

{
  const text = `Καλησπέρα Νίκο,

Εντάξει, θα περάσουμε να παραλάβουμε τα μικρόφωνα την Τρίτη το πρωί.

Ελένη

Στις Τετ 9 Σεπ 2026 στις 10:02 π.μ., ο/η Νίκος Παπαδόπουλος <
owner@contoso.example> έγραψε:

> Καλημέρα Ελένη,
>
> Τα μικρόφωνα είναι έτοιμα για παραλαβή από την αποθήκη μας.
>
> Νίκος
`;
  write(
    "gmail-reply-el.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", DELTA],
        ["To", OWNER],
        ["Subject", enc("Re: Παραλαβή μικροφώνων")],
        ["Date", "Wed, 9 Sep 2026 18:40:00 +0300"],
        ["Message-ID", "<CAF=delta0002+xyz@mail.gmail.example>"],
        ["In-Reply-To", "<owner-mics-1@contoso.example>"],
        ["References", "<owner-mics-1@contoso.example>"],
      ],
      leaf("text/plain; charset=\"UTF-8\"", text),
    ),
  );
}

// ── 7. Gmail forward (Fwd:, "Forwarded message" marker) ──────────────────────

{
  const html = `<div dir="ltr">Νίκο, δες παρακάτω το αίτημα του πελάτη για τον τιμοκατάλογο.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Μαρία Κωνσταντίνου</strong> <span dir="auto">&lt;<a href="mailto:m.konstantinou@vita-texniki.example">m.konstantinou@vita-texniki.example</a>&gt;</span><br>Date: Tue, Sep 8, 2026 at 5:30 PM<br>Subject: Τιμοκατάλογος 2027<br>To: Ελένη Δημητρίου &lt;<a href="mailto:eleni@delta-events.example">eleni@delta-events.example</a>&gt;<br></div><br><br><div dir="ltr">Καλησπέρα,<br><br>Θα μπορούσατε να μου στείλετε τον νέο τιμοκατάλογο για τα ηχεία;<br><br>Ευχαριστώ,<br>Μαρία</div></div>`;
  const text = `Νίκο, δες παρακάτω το αίτημα του πελάτη για τον τιμοκατάλογο.

---------- Forwarded message ---------
From: Μαρία Κωνσταντίνου <m.konstantinou@vita-texniki.example>
Date: Tue, Sep 8, 2026 at 5:30 PM
Subject: Τιμοκατάλογος 2027
To: Ελένη Δημητρίου <eleni@delta-events.example>


Καλησπέρα,

Θα μπορούσατε να μου στείλετε τον νέο τιμοκατάλογο για τα ηχεία;

Ευχαριστώ,
Μαρία
`;
  write(
    "gmail-forward.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", DELTA],
        ["To", OWNER],
        ["Subject", enc("Fwd: Τιμοκατάλογος 2027")],
        ["Date", "Wed, 9 Sep 2026 09:10:00 +0300"],
        ["Message-ID", "<CAF=delta0003+fwd@mail.gmail.example>"],
      ],
      multipart("alternative", "b7_alt", [leaf("text/plain; charset=\"UTF-8\"", text), leaf("text/html; charset=\"UTF-8\"", html)]),
    ),
  );
}

// ── 8. Apple Mail reply (blockquote type=cite, "Sent from my iPhone") ───────

{
  const html = `<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body dir="auto"><div dir="ltr">Great, see you on Monday at 10:00.</div><div dir="ltr"><br><div id="AppleMailSignature" dir="ltr">Sent from my iPhone</div><div dir="ltr"><br><blockquote type="cite">On 9 Sep 2026, at 16:20, Nikos Papadopoulos &lt;owner@contoso.example&gt; wrote:<br><br></blockquote></div><blockquote type="cite"><div dir="ltr">Hi John, can we meet on Monday to finalize the installation plan?<br>Nikos</div></blockquote></div></body></html>`;
  write(
    "apple-mail-reply.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", NORTHWIND],
        ["To", addr("Nikos Papadopoulos", "owner@contoso.example")],
        ["Subject", "Re: Installation plan"],
        ["Date", "Wed, 9 Sep 2026 17:01:00 +0300"],
        ["Message-ID", "<A1B2C3D4-0000-4000-8000-APPLE0000001@northwind-audio.example>"],
        ["In-Reply-To", "<owner-install-1@contoso.example>"],
        ["References", "<owner-install-1@contoso.example>"],
      ],
      leaf("text/html; charset=utf-8", html),
    ),
  );
}

// ── 9. Thunderbird-style plain reply, nested quotes and "-- " signature ─────

{
  const text = `Hello Nikos,

Yes, we accept the revised quotation. Please proceed with the order.

--
John Carter
Northwind Audio Ltd

On 10/9/26 14:05, Nikos Papadopoulos wrote:
> Hello John,
>
> Attached is the revised quotation with the 5% discount.
>
> On 9/9/26 11:30, John Carter wrote:
>> Could you do better on the price?
`;
  write(
    "thunderbird-reply.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", NORTHWIND],
        ["To", addr("Nikos Papadopoulos", "owner@contoso.example")],
        ["Subject", "Re: Revised quotation"],
        ["Date", "Fri, 11 Sep 2026 08:30:00 +0100"],
        ["Message-ID", "<tb-0001@northwind-audio.example>"],
        ["In-Reply-To", "<owner-revq-1@contoso.example>"],
        ["References", "<nw-price-0@northwind-audio.example> <owner-revq-1@contoso.example>"],
        ["User-Agent", "Mozilla Thunderbird"],
      ],
      leaf("text/plain; charset=UTF-8; format=flowed", text, { cte: "7bit" }),
    ),
  );
}

// ── 10. Old Outlook plain text "-----Original Message-----" ──────────────────

{
  const text = `Nikos,

Please send us the signed contract back by Tuesday.

Thanks,
John

-----Original Message-----
From: Nikos Papadopoulos [mailto:owner@contoso.example]
Sent: Tuesday, September 08, 2026 12:10 PM
To: John Carter
Subject: Maintenance contract

John, the contract is attached.
`;
  write(
    "outlook-original-message.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", NORTHWIND],
        ["To", addr("Nikos Papadopoulos", "owner@contoso.example")],
        ["Subject", "RE: Maintenance contract"],
        ["Date", "Wed, 9 Sep 2026 13:00:00 +0100"],
        ["Message-ID", "<ol-0001@northwind-audio.example>"],
      ],
      leaf("text/plain; charset=\"us-ascii\"", text, { cte: "7bit" }),
    ),
  );
}

// ── 11. Greek plain-text header block with underscore rule ──────────────────

{
  const text = `Καλησπέρα,

Σας ενημερώνω ότι η πληρωμή έγινε σήμερα. Παρακαλώ στείλτε το τιμολόγιο.

Μαρία

________________________________
Από: Νίκος Παπαδόπουλος <owner@contoso.example>
Στάλθηκε: Τετάρτη, 9 Σεπτεμβρίου 2026 10:02 π.μ.
Προς: Μαρία Κωνσταντίνου <m.konstantinou@vita-texniki.example>
Κοιν.: Γιώργος Αντωνίου <g.antoniou@contoso.example>
Θέμα: Προκαταβολή παραγγελίας 4471

Καλημέρα κυρία Κωνσταντίνου, η προκαταβολή είναι 30%.
`;
  write(
    "el-plain-header-block.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", VITA],
        ["To", OWNER],
        ["Subject", enc("ΑΠ: Προκαταβολή παραγγελίας 4471")],
        ["Date", "Thu, 10 Sep 2026 17:45:00 +0300"],
        ["Message-ID", "<vita-0002@vita-texniki.example>"],
      ],
      leaf("text/plain; charset=\"utf-8\"", text),
    ),
  );
}

// ── 12. Inline (interleaved) answers ─────────────────────────────────────────

{
  const text = `On Thu, 10 Sep 2026 at 12:00, Nikos Papadopoulos <owner@contoso.example> wrote:
> Can you confirm the venue address?
Yes: Olympia Hall, gate B.
> And who will sign the delivery note?
Our technician, Mr. Petrou.

Regards,
John Carter
`;
  write(
    "inline-reply.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", NORTHWIND],
        ["To", addr("Nikos Papadopoulos", "owner@contoso.example")],
        ["Subject", "Re: Delivery details"],
        ["Date", "Thu, 10 Sep 2026 13:10:00 +0100"],
        ["Message-ID", "<inline-0001@northwind-audio.example>"],
        ["In-Reply-To", "<owner-delivery-1@contoso.example>"],
      ],
      leaf("text/plain; charset=\"us-ascii\"", text, { cte: "7bit" }),
    ),
  );
}

// ── 13. Postfix bounce (RFC 3464 + text/rfc822-headers) ──────────────────────

{
  const human = `This is the mail system at host mail.contoso.example.

I'm sorry to have to inform you that your message could not
be delivered to one or more recipients.

<g.georgiou@alfa-ilektroniki.example>: host mx.alfa-ilektroniki.example said: 550 5.1.1 User unknown
`;
  const dsn = `Reporting-MTA: dns; mail.contoso.example
X-Postfix-Queue-ID: 4F1A2B3C4D
Arrival-Date: Tue,  8 Sep 2026 15:45:05 +0300 (EEST)

Final-Recipient: rfc822; g.georgiou@alfa-ilektroniki.example
Original-Recipient: rfc822;g.georgiou@alfa-ilektroniki.example
Action: failed
Status: 5.1.1
Remote-MTA: dns; mx.alfa-ilektroniki.example
Diagnostic-Code: smtp; 550 5.1.1 <g.georgiou@alfa-ilektroniki.example>: Recipient
    address rejected: User unknown
`;
  const orig = `From: Nikos Papadopoulos <owner@contoso.example>
To: g.georgiou@alfa-ilektroniki.example
Subject: =?UTF-8?B?zqDPgc6/z4PPhs6/z4HOrCDOt8+HzrXOr8+Jzr0=?=
Date: Tue, 8 Sep 2026 15:45:02 +0300
Message-ID: <owner-offer-1@contoso.example>
`;
  write(
    "bounce-postfix.eml",
    message(
      [
        ["Return-Path", "<>"],
        ["Delivered-To", "owner@contoso.example"],
        ["From", "MAILER-DAEMON@mail.contoso.example (Mail Delivery System)"],
        ["To", "owner@contoso.example"],
        ["Subject", "Undelivered Mail Returned to Sender"],
        ["Auto-Submitted", "auto-replied"],
        ["Date", "Tue,  8 Sep 2026 15:45:09 +0300 (EEST)"],
        ["Message-ID", "<20260908124509.4F1A2B3C4D@mail.contoso.example>"],
      ],
      multipart(
        "report",
        "b13_rep",
        [
          leaf("text/plain; charset=us-ascii", human, { cte: "7bit", extra: [["Content-Description", "Notification"]] }),
          leaf("message/delivery-status", dsn, { cte: "7bit", extra: [["Content-Description", "Delivery report"]] }),
          leaf("text/rfc822-headers", orig, { cte: "7bit", extra: [["Content-Description", "Undelivered Message Headers"]] }),
        ],
        "; report-type=delivery-status",
      ),
    ),
  );
}

// ── 14. Exchange NDR with the full original as message/rfc822 ────────────────

{
  const dsn = `Reporting-MTA: dns;AM9P193MB9999.eurprd09.prod.outlook.example
Received-From-MTA: dns;mail.contoso.example
Arrival-Date: Wed, 9 Sep 2026 08:00:00 +0000

Final-Recipient: rfc822;old.buyer@northwind-audio.example
Action: failed
Status: 5.1.10
Diagnostic-Code: smtp;550 5.1.10 RESOLVER.ADR.RecipientNotFound; Recipient not found by SMTP address lookup
`;
  const original = `From: Nikos Papadopoulos <owner@contoso.example>
To: old.buyer@northwind-audio.example
Subject: Quotation Q-2026-118
Date: Wed, 9 Sep 2026 10:59:50 +0300
Message-ID: <owner-q118@contoso.example>
Content-Type: text/plain; charset=us-ascii

Please find attached the quotation.
`;
  write(
    "bounce-exchange.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", addr("Microsoft Outlook", "postmaster@northwind-audio.example")],
        ["To", "owner@contoso.example"],
        ["Subject", "Undeliverable: Quotation Q-2026-118"],
        ["Date", "Wed, 9 Sep 2026 08:00:03 +0000"],
        ["Message-ID", "<ndr-0001@northwind-audio.example>"],
        ["X-MS-Exchange-Message-Is-Ndr", ""],
      ],
      multipart(
        "report",
        "b14_rep",
        [
          leaf("text/plain; charset=us-ascii", "Delivery has failed to these recipients or groups:\n\nold.buyer@northwind-audio.example\nThe email address you entered couldn't be found.\n", { cte: "7bit" }),
          leaf("message/delivery-status", dsn, { cte: "7bit" }),
          leaf("message/rfc822", original, { cte: "7bit" }),
        ],
        "; report-type=delivery-status",
      ),
    ),
  );
}

// ── 15. qmail-style plain bounce (heuristic) ─────────────────────────────────

{
  const text = `Hi. This is the qmail-send program at mx.vita-texniki.example.
I'm afraid I wasn't able to deliver your message to the following addresses.
This is a permanent error; I've given up. Sorry it didn't work out.

<accounts@vita-texniki.example>:
Sorry, no mailbox here by that name. (#5.1.1)

--- Below this line is a copy of the message.

Return-Path: <owner@contoso.example>
From: Nikos Papadopoulos <owner@contoso.example>
To: accounts@vita-texniki.example
Subject: Invoice 2026-0457
Message-ID: <owner-inv-457@contoso.example>

Please find the invoice attached.
`;
  write(
    "bounce-qmail.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", "MAILER-DAEMON@mx.vita-texniki.example"],
        ["To", "owner@contoso.example"],
        ["Subject", "failure notice"],
        ["Date", "Thu, 10 Sep 2026 12:00:00 +0300"],
        ["Message-ID", "<qmail-bounce-1@mx.vita-texniki.example>"],
      ],
      leaf("text/plain; charset=us-ascii", text, { cte: "7bit" }),
    ),
  );
}

// ── 16. Out-of-office (RFC 3834) in Greek ────────────────────────────────────

{
  write(
    "ooo-auto-submitted.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", ALFA],
        ["To", OWNER],
        ["Subject", enc("Αυτόματη απάντηση: Προσφορά ηχείων για το συνεδριακό κέντρο")],
        ["Auto-Submitted", "auto-replied"],
        ["Date", "Tue, 8 Sep 2026 15:46:00 +0300"],
        ["Message-ID", "<ooo-0001@alfa-ilektroniki.example>"],
        ["In-Reply-To", "<owner-offer-1@contoso.example>"],
        ["References", "<owner-offer-1@contoso.example>"],
      ],
      leaf(
        "text/plain; charset=\"utf-8\"",
        "Θα βρίσκομαι εκτός γραφείου έως τις 14 Σεπτεμβρίου χωρίς πρόσβαση στο email. Για επείγοντα θέματα επικοινωνήστε με το 210 5551200.",
      ),
    ),
  );
}

// ── 17. Out-of-office (English subject + Precedence: bulk → OOO wins) ───────

{
  write(
    "ooo-exchange.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", NORTHWIND],
        ["To", addr("Nikos Papadopoulos", "owner@contoso.example")],
        ["Subject", "Automatic reply: Amplifiers order NW-2291"],
        ["Precedence", "bulk"],
        ["X-Auto-Response-Suppress", "All"],
        ["Date", "Thu, 10 Sep 2026 16:12:30 +0100"],
        ["Message-ID", "<oof-0001@northwind-audio.example>"],
      ],
      leaf("text/plain; charset=\"us-ascii\"", "I am out of the office until Monday 14 September with limited access to email.", { cte: "7bit" }),
    ),
  );
}

// ── 18. Outlook meeting invite (METHOD:REQUEST, TZID GTB Standard Time) ─────

{
  const ics = `BEGIN:VCALENDAR
METHOD:REQUEST
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VTIMEZONE
TZID:GTB Standard Time
BEGIN:STANDARD
DTSTART:16010101T040000
TZOFFSETFROM:+0300
TZOFFSETTO:+0200
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:16010101T030000
TZOFFSETFROM:+0200
TZOFFSETTO:+0300
RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
ORGANIZER;CN="Γιάννης Γεωργίου":mailto:g.georgiou@alfa-ilektroniki.example
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Νίκος Παπαδόπου
 λος:mailto:owner@contoso.example
DESCRIPTION;LANGUAGE=el-GR:Συζήτηση για την εγκατάσταση των ηχείων.\\n
UID:040000008200E00074C5B7101A82E00800000000A0B1C2D3E4F5000000000000000010000000
SUMMARY;LANGUAGE=el-GR:Συνάντηση για την εγκατάσταση ηχείων στο συνεδριακό κ
 έντρο
DTSTART;TZID=GTB Standard Time:20260915T100000
DTEND;TZID=GTB Standard Time:20260915T110000
CLASS:PUBLIC
PRIORITY:5
DTSTAMP:20260909T080000Z
TRANSP:OPAQUE
STATUS:CONFIRMED
SEQUENCE:0
LOCATION;LANGUAGE=el-GR:Γραφεία Άλφα\\, Λεωφ. Κηφισίας 100
END:VEVENT
END:VCALENDAR
`;
  const text = `Συζήτηση για την εγκατάσταση των ηχείων.`;
  write(
    "calendar-invite.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", ALFA],
        ["To", OWNER],
        ["Subject", enc("Συνάντηση για την εγκατάσταση ηχείων στο συνεδριακό κέντρο")],
        ["Date", "Wed, 9 Sep 2026 11:00:00 +0300"],
        ["Message-ID", "<invite-0001@alfa-ilektroniki.example>"],
        ["X-Auto-Response-Suppress", "RN, NRN, OOF"],
      ],
      multipart("alternative", "b18_alt", [
        leaf("text/plain; charset=\"utf-8\"", text),
        leaf("text/html; charset=\"utf-8\"", `<html><body><p>${text}</p></body></html>`),
        leaf("text/calendar; charset=\"utf-8\"; method=REQUEST", ics, { cte: "base64" }),
      ]),
    ),
  );
}

// ── 19. Calendar reply (Αποδεκτό: = Accepted:, METHOD:REPLY) ────────────────

{
  const ics = `BEGIN:VCALENDAR
METHOD:REPLY
PRODID:Microsoft Exchange Server 2010
VERSION:2.0
BEGIN:VEVENT
ATTENDEE;PARTSTAT=ACCEPTED:mailto:m.konstantinou@vita-texniki.example
SUMMARY:Αποδεκτό: Παρουσίαση νέων κονσολών
DTSTART:20260916T090000Z
DTEND:20260916T100000Z
UID:vita-meeting-0001
ORGANIZER:mailto:owner@contoso.example
END:VEVENT
END:VCALENDAR
`;
  write(
    "calendar-reply.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", VITA],
        ["To", OWNER],
        ["Subject", enc("Αποδεκτό: Παρουσίαση νέων κονσολών")],
        ["Date", "Thu, 10 Sep 2026 08:00:00 +0300"],
        ["Message-ID", "<vita-accept-0001@vita-texniki.example>"],
      ],
      multipart("alternative", "b19_alt", [leaf("text/plain; charset=\"utf-8\"", ""), leaf("text/calendar; charset=\"utf-8\"; method=REPLY", ics, { cte: "base64" })]),
    ),
  );
}

// ── 20. Newsletter ───────────────────────────────────────────────────────────

{
  const html = `<!DOCTYPE html><html><head><title>Προσφορές</title><style>.x{color:red}</style></head><body><span style="display:none!important;mso-hide:all">Κρυφό preheader κείμενο</span><table width="600"><tr><td><h1>Φθινοπωρινές προσφορές</h1></td></tr><tr><td><p>Έως -30% σε επιλεγμένα ηχεία!</p><p><a href="https://promo-hxos.example/unsub">Διαγραφή</a></p></td></tr></table></body></html>`;
  write(
    "newsletter.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", addr("Promo Ήχος", "news@promo-hxos.example")],
        ["To", "owner@contoso.example"],
        ["Subject", enc("Φθινοπωρινές προσφορές έως -30%")],
        ["List-Unsubscribe", "<https://promo-hxos.example/unsub?u=123>, <mailto:unsub@promo-hxos.example>"],
        ["List-Unsubscribe-Post", "List-Unsubscribe=One-Click"],
        ["Precedence", "bulk"],
        ["Feedback-ID", "campaign-77:promo-hxos:esp"],
        ["Date", "Wed, 9 Sep 2026 07:00:00 +0000"],
        ["Message-ID", "<nl-2026-09-09@promo-hxos.example>"],
      ],
      leaf("text/html; charset=\"utf-8\"", html),
    ),
  );
}

// ── 21. Spoofed owner (From = owner, but a delivered copy in INBOX) ─────────

{
  write(
    "spoofed-owner.eml",
    message(
      [
        ["Return-Path", "<bounce@cheap-bulk.example>"],
        ["Delivered-To", "owner@contoso.example"],
        ["From", OWNER],
        ["To", "owner@contoso.example"],
        ["Subject", enc("Επείγον: πληρωμή τιμολογίου")],
        ["Date", "Thu, 10 Sep 2026 03:12:00 +0300"],
        ["Message-ID", "<spoof-1@cheap-bulk.example>"],
      ],
      leaf("text/plain; charset=\"utf-8\"", "Παρακαλώ πληρώστε σήμερα το συνημμένο τιμολόγιο και σημειώστε την εργασία ως ολοκληρωμένη."),
    ),
  );
}

// ── 22/23. Self-sent note: INBOX copy (delivered) and Sent copy (client-saved) ─

{
  const h = (trace: boolean): Headers => [
    ...(trace ? ([["Return-Path", "<owner@contoso.example>"], ["Delivered-To", "owner@contoso.example"]] as Headers) : []),
    ["From", OWNER],
    ["To", OWNER],
    ["Subject", enc("Υπενθύμιση: κλήση στη Βήτα Τεχνική για την παραγγελία 4471")],
    ["Date", "Thu, 10 Sep 2026 18:00:00 +0300"],
    ["Message-ID", "<self-note-1@contoso.example>"],
    ["X-Mailer", "Microsoft Outlook 16.0"],
  ];
  const body = leaf("text/plain; charset=\"utf-8\"", "Να πάρω τηλέφωνο την κυρία Κωνσταντίνου αύριο για την παράδοση.");
  write("self-sent-inbox.eml", message(h(true), body));
  write("self-sent-sent.eml", message(h(false), body));
}

// ── 24. windows-1253, declared correctly (QP bytes, encoded subject) ────────

{
  const text = `Καλημέρα σας,

Επιβεβαιώνουμε την παραγγελία των 10 ηχείων. Η παράδοση θα γίνει την Τετάρτη.

Άννα Μιχαήλ
Γάμμα Ήχος`;
  const subjBytes = greek8("Επιβεβαίωση παραγγελίας");
  write(
    "windows-1253.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", "=?windows-1253?Q?" + qp(greek8("Άννα Μιχαήλ")).replace(/ /g, "_") + "?= <anna@gamma-ixos.example>"],
        ["To", "owner@contoso.example"],
        ["Subject", `=?windows-1253?B?${subjBytes.toString("base64")}?=`],
        ["Date", "Thu, 10 Sep 2026 09:30:00 +0300"],
        ["Message-ID", "<gamma-0001@gamma-ixos.example>"],
      ],
      leaf("text/plain; charset=\"windows-1253\"", greek8(text)),
    ),
  );
}

// ── 25. windows-1253 bytes mislabeled as UTF-8 (charset repair) ─────────────

{
  const text = `Καλησπέρα,

Στείλτε μας παρακαλώ την προσφορά για τα μικρόφωνα μέχρι αύριο.

Δημήτρης`;
  write(
    "mislabeled-1253.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", addr("Dimitris", "d.ioannou@epsilon-studio.example")],
        ["To", "owner@contoso.example"],
        ["Subject", enc("Προσφορά μικροφώνων")],
        ["Date", "Thu, 10 Sep 2026 19:10:00 +0300"],
        ["Message-ID", "<eps-0001@epsilon-studio.example>"],
        ["X-Mailer", "OldMailer 1.0"],
      ],
      leaf("text/plain; charset=\"utf-8\"", greek8(text)),
    ),
  );
}

// ── 26. iso-8859-7 HTML (base64), declared correctly ────────────────────────

{
  const html = `<html><body><p>Αγαπητέ κύριε Παπαδόπουλε,</p><p>Σας ενημερώνουμε ότι η επισκευή της κονσόλας ολοκληρώθηκε.</p></body></html>`;
  write(
    "iso-8859-7-html.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", addr("Service Zeta", "service@zeta-repairs.example")],
        ["To", "owner@contoso.example"],
        ["Subject", "=?iso-8859-7?B?" + greek8("Επισκευή κονσόλας", "iso-8859-7").toString("base64") + "?="],
        ["Date", "Fri, 11 Sep 2026 10:00:00 +0300"],
        ["Message-ID", "<zeta-0001@zeta-repairs.example>"],
      ],
      leaf("text/html; charset=iso-8859-7", greek8(html, "iso-8859-7"), { cte: "base64" }),
    ),
  );
}

// ── 27. No Message-ID ────────────────────────────────────────────────────────

{
  write(
    "no-message-id.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", addr("Web Form", "forms@eta-website.example")],
        ["To", "owner@contoso.example"],
        ["Subject", enc("Νέο αίτημα επικοινωνίας από την ιστοσελίδα")],
        ["Date", "Fri, 11 Sep 2026 11:11:11 +0300"],
      ],
      leaf("text/plain; charset=\"utf-8\"", "Όνομα: Ηλίας Λαμπρόπουλος\nΜήνυμα: Θα ήθελα προσφορά για ηχητική κάλυψη γάμου στις 3 Οκτωβρίου."),
    ),
  );
}

// ── 28. S/MIME encrypted ─────────────────────────────────────────────────────

{
  write(
    "smime-encrypted.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", addr("Legal Theta", "legal@theta-law.example")],
        ["To", "owner@contoso.example"],
        ["Subject", "Contract draft (encrypted)"],
        ["Date", "Fri, 11 Sep 2026 12:00:00 +0300"],
        ["Message-ID", "<theta-0001@theta-law.example>"],
        ["Content-Disposition", "attachment; filename=\"smime.p7m\""],
      ],
      leaf("application/pkcs7-mime; smime-type=enveloped-data; name=\"smime.p7m\"", Buffer.from("MIAGCSqGSIb3DQEHA6CAMIACAQAxggFAMIIBPAIBADAkMBAxDjAMBgNVBAMMBXRoZXRh", "latin1"), { cte: "base64" }),
    ),
  );
}

// ── 29. TNEF (winmail.dat) ───────────────────────────────────────────────────

{
  write(
    "tnef.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", VITA],
        ["To", OWNER],
        ["Subject", enc("Τεχνικές προδιαγραφές")],
        ["Date", "Fri, 11 Sep 2026 13:00:00 +0300"],
        ["Message-ID", "<vita-tnef-0001@vita-texniki.example>"],
      ],
      multipart("mixed", "b29_mix", [
        leaf("text/plain; charset=\"utf-8\"", "Σας στέλνω συνημμένες τις τεχνικές προδιαγραφές."),
        leaf("application/ms-tnef; name=\"winmail.dat\"", Buffer.from([0x78, 0x9f, 0x3e, 0x22, 0x01, 0x00]), { cte: "base64", extra: [["Content-Disposition", "attachment; filename=\"winmail.dat\""]] }),
      ]),
    ),
  );
}

// ── 30. Forward as attachment (message/rfc822) ───────────────────────────────

{
  const inner = message(
    [
      ["From", VITA],
      ["To", OWNER],
      ["Subject", enc("Παράπονο για καθυστέρηση παράδοσης")],
      ["Date", "Wed, 9 Sep 2026 14:00:00 +0300"],
      ["Message-ID", "<vita-complaint-1@vita-texniki.example>"],
    ],
    leaf("text/plain; charset=\"utf-8\"", "Η παράδοση καθυστερεί ήδη μία εβδομάδα. Παρακαλούμε ενημερώστε μας άμεσα για τη νέα ημερομηνία."),
  );
  write(
    "forward-as-attachment.eml",
    message(
      [
        ["From", OWNER],
        ["To", COLLEAGUE],
        ["Subject", enc("ΠΡΘ: Παράπονο για καθυστέρηση παράδοσης")],
        ["Date", "Wed, 9 Sep 2026 15:00:00 +0300"],
        ["Message-ID", "<owner-fwdatt-1@contoso.example>"],
      ],
      multipart("mixed", "b30_mix", [
        leaf("text/plain; charset=\"utf-8\"", "Γιώργο, δες το συνημμένο και απάντησε στην πελάτισσα σήμερα."),
        renderHeaders([["Content-Type", "message/rfc822"], ["Content-Disposition", "attachment; filename=\"complaint.eml\""]]) + CRLF + CRLF + inner,
      ]),
    ),
  );
}

// ── 31. Owner's outbound promise (Sent copy, Greek Outlook reply) ────────────

{
  const text = `Καλημέρα κυρία Κωνσταντίνου,

Θα σας στείλω την ανανεωμένη προσφορά μέχρι την Παρασκευή.

Με εκτίμηση,
Νίκος Παπαδόπουλος
Contoso

Από: Μαρία Κωνσταντίνου <m.konstantinou@vita-texniki.example>
Στάλθηκε: Τετάρτη, 9 Σεπτεμβρίου 2026 10:02 π.μ.
Προς: Νίκος Παπαδόπουλος <owner@contoso.example>
Θέμα: Ανανεωμένη προσφορά κονσολών

Καλημέρα, μπορείτε να μας στείλετε ανανεωμένη προσφορά με έκπτωση 5%;`;
  write(
    "outbound-promise.eml",
    message(
      [
        ["From", OWNER],
        ["To", VITA],
        ["Subject", enc("ΑΠ: Ανανεωμένη προσφορά κονσολών")],
        ["Date", "Wed, 9 Sep 2026 12:30:00 +0300"],
        ["Message-ID", "<owner-promise-1@contoso.example>"],
        ["In-Reply-To", "<vita-renew-1@vita-texniki.example>"],
        ["References", "<vita-renew-1@vita-texniki.example>"],
        ["X-Mailer", "Microsoft Outlook 16.0"],
      ],
      leaf("text/plain; charset=\"utf-8\"", text),
    ),
  );
}

// ── 32. Courier notification from a no-reply address ─────────────────────────

{
  write(
    "noreply-notification.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", addr("Ταχύ Courier", "no-reply@tachy-courier.example")],
        ["To", "owner@contoso.example"],
        ["Subject", enc("Η αποστολή σας 7781234 παραδόθηκε")],
        ["Date", "Thu, 10 Sep 2026 14:22:00 +0300"],
        ["Message-ID", "<track-7781234@tachy-courier.example>"],
      ],
      leaf("text/plain; charset=\"utf-8\"", "Η αποστολή 7781234 παραδόθηκε στον παραλήπτη στις 14:15."),
    ),
  );
}

// ── 33. The platform's own digest (loop prevention) ──────────────────────────

{
  write(
    "platform-digest.eml",
    message(
      [
        ["From", OWNER],
        ["To", OWNER],
        ["Subject", enc("MailMe — Εκκρεμότητες Πέμπτης 10/9")],
        ["Date", "Thu, 10 Sep 2026 07:30:00 +0300"],
        ["Message-ID", "<digest.user-1.2026-09-10@mailme.local>"],
        ["Auto-Submitted", "auto-generated"],
        ["X-Auto-Response-Suppress", "All"],
        ["X-MailMe-Kind", "digest"],
      ],
      leaf("text/html; charset=\"utf-8\"", "<html><body><h2>Σήμερα</h2><p>Άλφα — Αποστολή τεχνικών φυλλαδίων</p></body></html>"),
    ),
  );
}

// ── 34. Sensitive data (redaction) ───────────────────────────────────────────

{
  write(
    "sensitive-data.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", VITA],
        ["To", OWNER],
        ["Subject", enc("Στοιχεία πληρωμής και πρόσβασης")],
        ["Date", "Fri, 11 Sep 2026 09:00:00 +0300"],
        ["Message-ID", "<vita-sensitive-1@vita-texniki.example>"],
      ],
      leaf(
        "text/plain; charset=\"utf-8\"",
        `Καλημέρα,

Το IBAN μας είναι GR16 0110 1250 0000 0001 2300 695 για την προκαταβολή.
Η εταιρική κάρτα είναι 4111 1111 1111 1111 (λήγει 12/28).
Για την πύλη προμηθευτών: χρήστης vita-contoso, κωδικός: Xy7#kP9q
Your verification code is 482913.

Ο κωδικός προϊόντος είναι ΚΝ-2291 και ο ταχυδρομικός κωδικός 11526.

Μαρία`,
      ),
    ),
  );
}

// ── 35/36. Thread-Index root link (no References, different subjects) ───────

{
  const root = Buffer.concat([Buffer.from("01dc41a0b2c3", "hex"), Buffer.from("0f1e2d3c4b5a69788796a5b4c3d2e1f0", "hex")]);
  const child = Buffer.concat([root, Buffer.from("0000a1b2c3", "hex")]);
  write(
    "thread-index-1.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", ALFA],
        ["To", OWNER],
        ["Subject", enc("Εγγύηση ενισχυτών")],
        ["Thread-Index", root.toString("base64")],
        ["Date", "Mon, 7 Sep 2026 09:00:00 +0300"],
        ["Message-ID", "<ti-0001@alfa-ilektroniki.example>"],
      ],
      leaf("text/plain; charset=\"utf-8\"", "Ποια είναι η διάρκεια εγγύησης για τους ενισχυτές;"),
    ),
  );
  write(
    "thread-index-2.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", ALFA],
        ["To", OWNER],
        ["Subject", enc("ΑΠ: Εγγύηση ενισχυτών - συμπλήρωση")],
        ["Thread-Index", child.toString("base64")],
        ["Date", "Tue, 8 Sep 2026 09:00:00 +0300"],
        ["Message-ID", "<ti-0002@alfa-ilektroniki.example>"],
      ],
      leaf("text/plain; charset=\"utf-8\"", "Επίσης, καλύπτεται η εγκατάσταση;"),
    ),
  );
}

// ── 37/38. Subject + participant link (LOW), 10 days apart ───────────────────

{
  const mk = (id: string, date: string, body: string) =>
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", VITA],
        ["To", OWNER],
        ["Subject", enc("Ανανέωση συμβολαίου συντήρησης")],
        ["Date", date],
        ["Message-ID", `<${id}@vita-texniki.example>`],
      ],
      leaf("text/plain; charset=\"utf-8\"", body),
    );
  write("subject-link-1.eml", mk("vita-renewal-a", "Mon, 31 Aug 2026 10:00:00 +0300", "Πότε λήγει το συμβόλαιο συντήρησης;"));
  write("subject-link-2.eml", mk("vita-renewal-b", "Thu, 10 Sep 2026 10:00:00 +0300", "Επανέρχομαι για την ανανέωση του συμβολαίου."));
}

// ── 39/40. Generic subject «Προσφορά» (Offer): never linked by subject alone ─

{
  const mk = (id: string, date: string, body: string) =>
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", ALFA],
        ["To", OWNER],
        ["Subject", enc("Προσφορά")],
        ["Date", date],
        ["Message-ID", `<${id}@alfa-ilektroniki.example>`],
      ],
      leaf("text/plain; charset=\"utf-8\"", body),
    );
  write("generic-subject-1.eml", mk("gen-a", "Mon, 7 Sep 2026 12:00:00 +0300", "Θα θέλαμε προσφορά για προβολείς."));
  write("generic-subject-2.eml", mk("gen-b", "Wed, 9 Sep 2026 12:00:00 +0300", "Θα θέλαμε προσφορά για καλώδια ήχου."));
}

// ── 41. Reply with nothing new (EMPTY) ───────────────────────────────────────

{
  write(
    "empty-reply.eml",
    message(
      [
        ["Delivered-To", "owner@contoso.example"],
        ["From", ALFA],
        ["To", OWNER],
        ["Subject", enc("ΑΠ: Προσφορά ηχείων για το συνεδριακό κέντρο")],
        ["Date", "Wed, 9 Sep 2026 16:00:00 +0300"],
        ["Message-ID", "<empty-0001@alfa-ilektroniki.example>"],
        ["In-Reply-To", "<owner-offer-1@contoso.example>"],
      ],
      leaf(
        "text/plain; charset=\"utf-8\"",
        `
Από: Νίκος Παπαδόπουλος <owner@contoso.example>
Στάλθηκε: Τρίτη, 8 Σεπτεμβρίου 2026 3:45 μ.μ.
Προς: Γιάννης Γεωργίου <g.georgiou@alfa-ilektroniki.example>
Θέμα: Προσφορά ηχείων για το συνεδριακό κέντρο

Κύριε Γεωργίου, σας επισυνάπτω την προσφορά.`,
      ),
    ),
  );
}

// ── 42. Draft (Outlook-saved, unsent promise) ────────────────────────────────

{
  write(
    "draft.eml",
    message(
      [
        ["From", OWNER],
        ["To", ALFA],
        ["Subject", enc("Τεχνικά φυλλάδια")],
        ["Date", "Thu, 10 Sep 2026 20:00:00 +0300"],
        ["Message-ID", "<owner-draft-1@contoso.example>"],
        ["X-Mailer", "Microsoft Outlook 16.0"],
      ],
      leaf("text/plain; charset=\"utf-8\"", "Θα σας στείλω τα φυλλάδια αύριο το πρωί."),
    ),
  );
}

console.log("fixtures written to", OUT);
