import { describe, expect, it } from "vitest";
import { decodeHeaderValue, decodeMimeWords, decodeWithRepair, parseStructuredHeader, walkMime, flattenParts, decodeTransfer } from "../../src/mail/mime-lite.js";

const greek1253 = Buffer.from([0xc1, 0xe3, 0xe1, 0xf0, 0xe7, 0xf4, 0xdd, 0x20, 0xa2, 0xed, 0xed, 0xe1]); // «Αγαπητέ Άννα» ("Dear Anna")

describe("charset repair", () => {
  it("keeps valid text in its declared charset", () => {
    expect(decodeWithRepair(Buffer.from("Καλημέρα", "utf8"), "utf-8")).toEqual({ text: "Καλημέρα", repairedAs: null });
    expect(decodeWithRepair(greek1253, "windows-1253")).toEqual({ text: "Αγαπητέ Άννα", repairedAs: null });
  });

  it("repairs windows-1253 bytes mislabeled as UTF-8 or missing a charset", () => {
    expect(decodeWithRepair(greek1253, "utf-8")).toEqual({ text: "Αγαπητέ Άννα", repairedAs: "windows-1253" });
    expect(decodeWithRepair(greek1253, null)).toEqual({ text: "Αγαπητέ Άννα", repairedAs: "windows-1253" });
  });

  it("repairs Greek bytes mislabeled as Latin-1 (mojibake), but leaves real Latin-1 alone", () => {
    expect(decodeWithRepair(greek1253, "iso-8859-1").text).toBe("Αγαπητέ Άννα");
    const french = Buffer.from("Réunion à Paris, déjà prévue", "latin1");
    expect(decodeWithRepair(french, "iso-8859-1")).toEqual({ text: "Réunion à Paris, déjà prévue", repairedAs: null });
  });

  it("repairs UTF-8 bytes declared as a single-byte charset", () => {
    expect(decodeWithRepair(Buffer.from("Προσφορά", "utf8"), "windows-1253")).toEqual({ text: "Προσφορά", repairedAs: "utf-8" });
  });
});

describe("header decoding", () => {
  it("decodes RFC 2047 words, joining adjacent words split mid-character", () => {
    const bytes = Buffer.from("Προσφορά", "utf8");
    const a = bytes.subarray(0, 3).toString("base64");
    const b = bytes.subarray(3).toString("base64");
    expect(decodeMimeWords(`=?UTF-8?B?${a}?= =?UTF-8?B?${b}?=`)).toBe("Προσφορά");
    expect(decodeMimeWords("=?utf-8?Q?=CE=91=CE=A0:_Test?= ok")).toBe("ΑΠ: Test ok");
    expect(decodeMimeWords("plain text")).toBe("plain text");
  });

  it("decodes raw 8-bit header bytes (UTF-8 or windows-1253)", () => {
    expect(decodeHeaderValue(Buffer.from("Προσφορά", "utf8").toString("latin1"))).toBe("Προσφορά");
    expect(decodeHeaderValue(greek1253.toString("latin1"))).toBe("Αγαπητέ Άννα");
  });

  it("parses structured headers with quotes and RFC 2231 continuations", () => {
    expect(parseStructuredHeader('multipart/report; report-type=delivery-status; boundary="a;b"')).toEqual({
      value: "multipart/report",
      params: { "report-type": "delivery-status", boundary: "a;b" },
    });
    expect(parseStructuredHeader("attachment; filename*0=\"long\"; filename*1=\"name.pdf\"").params.filename).toBe("longname.pdf");
  });
});

describe("walkMime", () => {
  it("splits nested multiparts and decodes transfer encodings", () => {
    const raw = [
      "Content-Type: multipart/mixed; boundary=X",
      "",
      "--X",
      "Content-Type: multipart/alternative; boundary=Y",
      "",
      "--Y",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "=CE=9A=CE=B1=CE=BB=CE=B7=CE=BC=CE=AD=CF=81=CE=B1 soft=",
      "break",
      "--Y--",
      "--X",
      "Content-Type: application/pdf; name=a.pdf",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("%PDF").toString("base64"),
      "--X--",
    ].join("\r\n");
    const parts = flattenParts(walkMime(raw));
    expect(parts.map((p) => p.contentType)).toEqual(["multipart/mixed", "multipart/alternative", "text/plain", "application/pdf"]);
    expect(decodeTransfer(parts[2]!).toString("utf8")).toBe("Καλημέρα softbreak");
    expect(decodeTransfer(parts[3]!).toString("latin1")).toBe("%PDF");
  });

  it("never throws on garbage", () => {
    expect(() => walkMime("\u{0000}\u{0001}garbage without headers")).not.toThrow();
    expect(walkMime("").contentType).toBe("text/plain");
  });
});
