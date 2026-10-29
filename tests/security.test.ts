import { randomBytes } from "node:crypto";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { randomToken, safeEqual, seal, sha256Hex, unseal } from "@/lib/crypto";
import { createSessionToken, LOCAL_SESSION_TTL_SEC, verifySessionToken } from "@/lib/auth/local-session";
import { rateLimit, resetRateLimits } from "@/lib/rate-limit";
import { redact } from "@/lib/logger";
import { csvEscape, detectTabularFile, parseTabular } from "@/lib/files/tabular";
import { chunkText, toOrTsQuery } from "@/lib/knowledge";
import { AppError } from "@/lib/errors";

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected function to throw");
}

async function catchAsync(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected promise to reject");
    },
    (e: unknown) => e,
  );
}

function expectAppError(err: unknown, code: string, status?: number) {
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (status !== undefined) expect((err as AppError).status).toBe(status);
}

// ---------------------------------------------------------------------------
// crypto.ts
// ---------------------------------------------------------------------------

describe("crypto", () => {
  const key = randomBytes(32).toString("base64");

  it("seal/unseal round-trips and uses a fresh IV each time", () => {
    const secret = "ya29.oauth-token-ü-✓";
    const a = seal(secret, key);
    const b = seal(secret, key);
    expect(a.ciphertext).not.toContain("oauth");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(Buffer.from(a.iv, "base64")).toHaveLength(12);
    expect(Buffer.from(a.authTag, "base64")).toHaveLength(16);
    expect(unseal(a, key)).toBe(secret);
    expect(unseal(b, key)).toBe(secret);
  });

  it("throws on tampered ciphertext", () => {
    const s = seal("top secret", key);
    const ct = Buffer.from(s.ciphertext, "base64");
    ct[0] ^= 0x01;
    expect(() => unseal({ ...s, ciphertext: ct.toString("base64") }, key)).toThrow();
  });

  it("throws on tampered auth tag", () => {
    const s = seal("top secret", key);
    const tag = Buffer.from(s.authTag, "base64");
    tag[tag.length - 1] ^= 0x80;
    expect(() => unseal({ ...s, authTag: tag.toString("base64") }, key)).toThrow();
  });

  it("throws with the wrong key", () => {
    const s = seal("top secret", key);
    expect(() => unseal(s, randomBytes(32).toString("base64"))).toThrow();
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => seal("x", randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => seal("x", randomBytes(33).toString("base64"))).toThrow(/32 bytes/);
    expect(() => unseal({ ciphertext: "", iv: "", authTag: "" }, "")).toThrow(/32 bytes/);
  });

  it("safeEqual compares in constant time and handles different lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });

  it("sha256Hex and randomToken", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });
});

// ---------------------------------------------------------------------------
// auth/local-session.ts
// ---------------------------------------------------------------------------

describe("local session tokens", () => {
  const secret = "s".repeat(32);
  const now = 1_790_000_000;
  const payload = { sub: "6f1c1f9a-0c2c-4b55-8d0a-1b2c3d4e5f60", email: "user@example.com" };

  it("verifies a valid token", () => {
    const token = createSessionToken(payload, secret, now);
    expect(verifySessionToken(token, secret, now + 60)).toEqual({ ...payload, exp: now + LOCAL_SESSION_TTL_SEC });
  });

  it("rejects an expired token", () => {
    const token = createSessionToken(payload, secret, now);
    expect(verifySessionToken(token, secret, now + LOCAL_SESSION_TTL_SEC - 1)).not.toBeNull();
    expect(verifySessionToken(token, secret, now + LOCAL_SESSION_TTL_SEC)).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const token = createSessionToken(payload, secret, now);
    const [, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, sub: "00000000-0000-0000-0000-000000000000", exp: now + 10 ** 9 })).toString("base64url");
    expect(verifySessionToken(`${forged}.${sig}`, secret, now)).toBeNull();
  });

  it("rejects a token signed with another secret", () => {
    const token = createSessionToken(payload, "x".repeat(32), now);
    expect(verifySessionToken(token, secret, now)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifySessionToken(undefined, secret, now)).toBeNull();
    expect(verifySessionToken("", secret, now)).toBeNull();
    expect(verifySessionToken("abc", secret, now)).toBeNull();
    expect(verifySessionToken("abc.", secret, now)).toBeNull();
    expect(verifySessionToken(".sig", secret, now)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rate-limit.ts
// ---------------------------------------------------------------------------

describe("rateLimit", () => {
  beforeEach(() => resetRateLimits());

  it("allows `limit` requests per window, then blocks with retryAfter", () => {
    const t0 = 1_000_000;
    expect(rateLimit("ip:1", 2, 60_000, t0)).toEqual({ ok: true, remaining: 1, retryAfterSec: 0 });
    expect(rateLimit("ip:1", 2, 60_000, t0 + 10)).toEqual({ ok: true, remaining: 0, retryAfterSec: 0 });
    expect(rateLimit("ip:1", 2, 60_000, t0 + 20_000)).toEqual({ ok: false, remaining: 0, retryAfterSec: 40 });
    // other keys are independent
    expect(rateLimit("ip:2", 2, 60_000, t0 + 20_000).ok).toBe(true);
  });

  it("resets when the window ends", () => {
    const t0 = 5_000;
    rateLimit("k", 1, 1000, t0);
    expect(rateLimit("k", 1, 1000, t0 + 999).ok).toBe(false);
    expect(rateLimit("k", 1, 1000, t0 + 1000)).toEqual({ ok: true, remaining: 0, retryAfterSec: 0 });
    expect(rateLimit("k", 1, 1000, t0 + 1001).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// logger.ts redact
// ---------------------------------------------------------------------------

describe("redact", () => {
  it("redacts secret-like keys at any depth and masks emails", () => {
    const out = redact({
      token: "t",
      access_token: "a",
      Authorization: "Bearer x",
      apiKey: "k1",
      api_key: "k2",
      "x-api-key": "k3",
      password: "p",
      webhookSecret: "w",
      cookie: "c",
      ciphertext: "ct",
      credentials: { user: "u" },
      user: { email: "alice@example.com", nested: { refresh_token: "r", note: "mail bob.smith@corp.co.uk now" } },
      list: [{ secret: "s", ok: "carol@x.io" }],
      count: 3,
      flag: true,
      nothing: null,
    }) as Record<string, unknown>;
    for (const k of ["token", "access_token", "Authorization", "apiKey", "api_key", "x-api-key", "password", "webhookSecret", "cookie", "ciphertext", "credentials"]) {
      expect(out[k]).toBe("[redacted]");
    }
    expect(out.user).toEqual({ email: "a***@example.com", nested: { refresh_token: "[redacted]", note: "mail b***@corp.co.uk now" } });
    expect(out.list).toEqual([{ secret: "[redacted]", ok: "c***@x.io" }]);
    expect(out.count).toBe(3);
    expect(out.flag).toBe(true);
    expect(out.nothing).toBeNull();
    expect(JSON.stringify(out)).not.toMatch(/alice@|bob\.smith@|carol@/);
  });

  it("limits depth, array length and string length", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain("[depth]");
    expect((redact(Array.from({ length: 100 }, (_, i) => i)) as unknown[]).length).toBe(50);
    expect((redact("a".repeat(5000)) as string).length).toBe(2000);
  });
});

// ---------------------------------------------------------------------------
// files/tabular.ts
// ---------------------------------------------------------------------------

describe("detectTabularFile", () => {
  const csv = Buffer.from("a,b\n1,2\n");
  const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);

  it("accepts csv and xlsx", () => {
    expect(detectTabularFile("data.csv", "text/csv", csv, 1000)).toBe("csv");
    expect(detectTabularFile("DATA.CSV", "", csv, 1000)).toBe("csv");
    expect(detectTabularFile("book.xlsx", XLSX_TYPE, zip, 1000)).toBe("xlsx");
    expect(detectTabularFile("book.xlsx", "application/octet-stream", zip, 1000)).toBe("xlsx");
  });

  it("rejects the wrong extension", () => {
    expectAppError(catchErr(() => detectTabularFile("data.txt", "text/plain", csv, 1000)), "INVALID_FILE_TYPE", 415);
    expectAppError(catchErr(() => detectTabularFile("data.csv.exe", "text/csv", csv, 1000)), "INVALID_FILE_TYPE", 415);
    expectAppError(catchErr(() => detectTabularFile("book.xls", "application/vnd.ms-excel", csv, 1000)), "INVALID_FILE_TYPE", 415);
  });

  it("rejects oversized and empty files", () => {
    expectAppError(catchErr(() => detectTabularFile("data.csv", "text/csv", Buffer.alloc(1001, 0x61), 1000)), "FILE_TOO_LARGE", 413);
    expectAppError(catchErr(() => detectTabularFile("data.csv", "text/csv", Buffer.alloc(0), 1000)), "EMPTY_FILE", 400);
  });

  it("rejects .xlsx whose bytes are not a zip", () => {
    expectAppError(catchErr(() => detectTabularFile("book.xlsx", XLSX_TYPE, csv, 1000)), "INVALID_FILE_TYPE", 415);
    expectAppError(catchErr(() => detectTabularFile("book.xlsx", "text/html", zip, 1000)), "INVALID_FILE_TYPE", 415);
  });

  it("rejects csv with NUL bytes, zip bytes or a non-csv mime type", () => {
    expectAppError(catchErr(() => detectTabularFile("data.csv", "text/csv", Buffer.from("a,b\n1,\u00002\n"), 1000)), "INVALID_FILE_TYPE", 415);
    expectAppError(catchErr(() => detectTabularFile("data.csv", "text/csv", zip, 1000)), "INVALID_FILE_TYPE", 415);
    expectAppError(catchErr(() => detectTabularFile("data.csv", "application/pdf", csv, 1000)), "INVALID_FILE_TYPE", 415);
  });
});

describe("parseTabular (csv)", () => {
  it("strips a UTF-8 BOM from the first header", async () => {
    const t = await parseTabular("bom.csv", "csv", Buffer.from("﻿Name,Amount\nAsha,10\n"), 100);
    expect(t.columns).toEqual(["Name", "Amount"]);
    expect(t.rows).toEqual([{ Name: "Asha", Amount: "10" }]);
  });

  it("keeps quoted commas, quotes and newlines inside a cell", async () => {
    const t = await parseTabular("q.csv", "csv", Buffer.from('Company,Note\n"Acme, Inc","He said ""hi""\nthen left"\n'), 100);
    expect(t.rows).toEqual([{ Company: "Acme, Inc", Note: 'He said "hi"\nthen left' }]);
  });

  it("renames duplicate and blank headers", async () => {
    const t = await parseTabular("d.csv", "csv", Buffer.from("Amount,amount,,Amount\n1,2,3,4\n"), 100);
    expect(t.columns).toEqual(["Amount", "amount_2", "column_3", "Amount_3"]);
    expect(t.rows[0]).toEqual({ Amount: "1", amount_2: "2", column_3: "3", Amount_3: "4" });
  });

  // Regression (fixed, uniqueHeaders): a renamed duplicate can collide
  // with a header that already exists, e.g. ["Amount","Amount","Amount_2"] becomes
  // ["Amount","Amount_2","Amount_2"], so one column silently overwrites the other in every row.
  it("renamed duplicate headers never collide with existing headers", async () => {
    const t = await parseTabular("c.csv", "csv", Buffer.from("Amount,Amount,Amount_2\n1,2,3\n"), 100);
    expect(new Set(t.columns.map((c) => c.toLowerCase())).size).toBe(3);
    expect(Object.values(t.rows[0]).sort()).toEqual(["1", "2", "3"]);
  });

  it("enforces the row limit", async () => {
    const err = await catchAsync(parseTabular("big.csv", "csv", Buffer.from("a\n1\n2\n3\n"), 2));
    expectAppError(err, "TOO_MANY_ROWS", 422);
    await expect(parseTabular("ok.csv", "csv", Buffer.from("a\n1\n2\n"), 2)).resolves.toMatchObject({ rows: [{ a: "1" }, { a: "2" }] });
  });

  it("rejects a header-only file and an unterminated quote", async () => {
    expectAppError(await catchAsync(parseTabular("h.csv", "csv", Buffer.from("a,b\n"), 10)), "EMPTY_DATASET", 422);
    expectAppError(await catchAsync(parseTabular("bad.csv", "csv", Buffer.from('a,b\n"open,2\n'), 10)), "CSV_PARSE_ERROR", 422);
  });

  it("fills missing trailing cells with null", async () => {
    const t = await parseTabular("s.csv", "csv", Buffer.from("a,b,c\n1,2\n"), 10);
    expect(t.rows).toEqual([{ a: "1", b: "2", c: null }]);
  });
});

describe("parseTabular (xlsx)", () => {
  async function workbook(build: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    build(wb.addWorksheet("Sheet1"));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("parses an in-memory workbook including a Date cell as YYYY-MM-DD", async () => {
    const buf = await workbook((ws) => {
      ws.addRow(["Order Date", "Product", "Revenue", "Paid"]);
      ws.addRow([new Date(Date.UTC(2026, 8, 15)), "Widget", 120.5, true]);
      ws.addRow([new Date(Date.UTC(2026, 0, 2)), "Gadget", 80, false]);
      ws.getCell("C4").value = { formula: "C2+C3", result: 200.5 };
      ws.getCell("B4").value = "  Total  ";
    });
    expect(detectTabularFile("sales.xlsx", XLSX_TYPE, buf, 5 * 1024 * 1024)).toBe("xlsx");
    const t = await parseTabular("sales.xlsx", "xlsx", buf, 100);
    expect(t.columns).toEqual(["Order Date", "Product", "Revenue", "Paid"]);
    expect(t.rows).toEqual([
      { "Order Date": "2026-09-15", Product: "Widget", Revenue: 120.5, Paid: true },
      { "Order Date": "2026-01-02", Product: "Gadget", Revenue: 80, Paid: false },
      { "Order Date": null, Product: "Total", Revenue: 200.5, Paid: null },
    ]);
  });

  it("rejects bytes that start with PK but are not a workbook", async () => {
    const err = await catchAsync(parseTabular("fake.xlsx", "xlsx", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), 100));
    expectAppError(err, "XLSX_PARSE_ERROR", 422);
  });
});

describe("csvEscape", () => {
  it("prefixes formula-like strings with a quote", () => {
    expect(csvEscape("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(csvEscape("+1 555 0100")).toBe("'+1 555 0100");
    expect(csvEscape("-cmd")).toBe("'-cmd");
    expect(csvEscape("@HYPERLINK(\"x\")")).toBe(`"'@HYPERLINK(""x"")"`);
    expect(csvEscape("\t=1")).toBe("'\t=1");
    expect(csvEscape("=1,2")).toBe(`"'=1,2"`);
  });

  it("leaves numbers and plain text alone", () => {
    expect(csvEscape(-5)).toBe("-5");
    expect(csvEscape(42)).toBe("42");
    expect(csvEscape(3.14)).toBe("3.14");
    expect(csvEscape("Acme")).toBe("Acme");
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  it("quotes commas, quotes and newlines", () => {
    expect(csvEscape("Acme, Inc")).toBe('"Acme, Inc"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });
});

// ---------------------------------------------------------------------------
// knowledge.ts
// ---------------------------------------------------------------------------

describe("chunkText", () => {
  it("returns nothing for blank text and one chunk for short text", () => {
    expect(chunkText("   \n\n ")).toEqual([]);
    expect(chunkText("Short answer.\r\n\r\n\r\n\r\nSecond para.")).toEqual(["Short answer.\n\nSecond para."]);
  });

  it("keeps chunks near the target size with overlap between them", () => {
    const sentence = (i: number) => `Sentence number ${i} explains the refund policy in plain words.`;
    const paragraphs = Array.from({ length: 30 }, (_, p) => Array.from({ length: 4 }, (_, s) => sentence(p * 4 + s)).join(" "));
    const text = paragraphs.join("\n\n");
    const target = 800;
    const overlap = 120;
    const chunks = chunkText(text, target, overlap);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.length).toBeGreaterThan(0);
      expect(c.length).toBeLessThanOrEqual(target + overlap + 3);
    }
    // every sentence survives chunking
    for (let i = 0; i < 120; i++) expect(chunks.some((c) => c.includes(sentence(i)))).toBe(true);
    // consecutive chunks overlap
    expect(chunks[1].startsWith(chunks[0].slice(-overlap))).toBe(true);
  });

  it("splits an oversized paragraph on sentence boundaries", () => {
    const para = Array.from({ length: 60 }, (_, i) => `This is sentence ${i}.`).join(" ");
    const chunks = chunkText(para, 200, 40);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200 + 40 + 1);
  });

  it("caps the number of chunks at 500", () => {
    const text = Array.from({ length: 700 }, (_, i) => `Paragraph ${i} ${"x".repeat(50)}.`).join("\n\n");
    expect(chunkText(text, 60, 0).length).toBe(500);
  });
});

describe("toOrTsQuery", () => {
  it("drops stopwords and short tokens, joins with |", () => {
    expect(toOrTsQuery("What is the refund policy for damaged items?")).toBe("refund | policy | damaged | items");
  });

  it("returns null when nothing useful remains", () => {
    expect(toOrTsQuery("is it a an the of to")).toBeNull();
    expect(toOrTsQuery("??? !!")).toBeNull();
  });

  it("sanitizes tsquery syntax and SQL characters", () => {
    const q = toOrTsQuery("refund'); DROP TABLE users; -- & | ! :* <-> (x)")!;
    expect(q).toBe("refund | drop | table | users");
    expect(q).toMatch(/^[a-z0-9 |]+$/);
  });

  it("dedupes and caps at 12 terms", () => {
    expect(toOrTsQuery("Refund REFUND refund shipping")).toBe("refund | shipping");
    const many = Array.from({ length: 20 }, (_, i) => `term${i}`).join(" ");
    expect(toOrTsQuery(many)!.split(" | ")).toHaveLength(12);
  });
});
