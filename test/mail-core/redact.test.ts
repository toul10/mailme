import { describe, expect, it } from "vitest";
import { isValidIban, luhnValid, redactSensitive } from "../../src/mail/redact.js";

describe("redactSensitive", () => {
  it("redacts Greek IBANs, grouped or compact", () => {
    const r = redactSensitive("IBAN: GR16 0110 1250 0000 0001 2300 695 και GR1601101250000000012300695.");
    expect(r.text).toBe("IBAN: [IBAN] και [IBAN].");
    expect(r.redactions).toBe(2);
  });

  it("redacts checksum-valid foreign IBANs and keeps invalid look-alikes", () => {
    expect(redactSensitive("Pay to DE89 3704 0044 0532 0130 00 today").text).toBe("Pay to [IBAN] today");
    expect(redactSensitive("Pay to DE89370400440532013000 ref A1").text).toBe("Pay to [IBAN] ref A1");
    expect(redactSensitive("Code DE12 3456 7890 1234 5678 90").text).toBe("Code DE12 3456 7890 1234 5678 90");
    expect(isValidIban("GB82 WEST 1234 5698 7654 32")).toBe(true);
    expect(isValidIban("GB82 WEST 1234 5698 7654 33")).toBe(false);
  });

  it("redacts Luhn-valid card numbers with a plausible issuer only", () => {
    expect(redactSensitive("Κάρτα 4111 1111 1111 1111 λήγει 12/28").text).toBe("Κάρτα [CARD] λήγει 12/28");
    expect(redactSensitive("MC 5555-5555-5555-4444.").text).toBe("MC [CARD].");
    expect(redactSensitive("Amex 378282246310005").text).toBe("Amex [CARD]");
    // EAN-13 barcode / order numbers / phone numbers stay.
    expect(redactSensitive("EAN 5201234567897").text).toBe("EAN 5201234567897");
    expect(redactSensitive("Order 4111111111111112").text).toBe("Order 4111111111111112");
    expect(redactSensitive("Τηλ. 0030 210 5551234").text).toBe("Τηλ. 0030 210 5551234");
    expect(luhnValid("79927398713")).toBe(true);
  });

  it("redacts labelled passwords and OTPs, keeping the label", () => {
    expect(redactSensitive("password: hunter2!").text).toBe("password: [SECRET]");
    expect(redactSensitive("Κωδικός πρόσβασης: Ab12cd34").text).toBe("Κωδικός πρόσβασης: [SECRET]");
    expect(redactSensitive("χρήστης vita, κωδικός: Xy7#kP9q").text).toBe("χρήστης vita, κωδικός: [SECRET]");
    expect(redactSensitive("OTP: 123456").text).toBe("OTP: [SECRET]");
    expect(redactSensitive("PIN: 4321").text).toBe("PIN: [SECRET]");
    expect(redactSensitive("Your verification code is 482913.").text).toBe("Your verification code is [SECRET].");
    expect(redactSensitive("ο κωδικός σας είναι 553201").text).toBe("ο κωδικός σας είναι [SECRET]");
    expect(redactSensitive("Κωδικός μιας χρήσης: 889911").text).toBe("Κωδικός μιας χρήσης: [SECRET]");
  });

  it("does not treat product/customer/postal codes as secrets", () => {
    const t = "Ο κωδικός προϊόντος είναι ΚΝ-2291, κωδικός: 11526, κωδικός: ABC-123, ταχυδρομικός κωδικός 11526.";
    expect(redactSensitive(t)).toEqual({ text: t, redactions: 0 });
    expect(redactSensitive("bypass: yes, passport: AB1234567").redactions).toBe(0);
  });

  it("is idempotent and handles empty input", () => {
    const once = redactSensitive("password: hunter2! GR16 0110 1250 0000 0001 2300 695");
    expect(redactSensitive(once.text).redactions).toBe(0);
    expect(redactSensitive("")).toEqual({ text: "", redactions: 0 });
  });
});
