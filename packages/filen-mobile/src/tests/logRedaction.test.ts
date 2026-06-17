import { describe, it, expect } from "vitest"
import { redact } from "@/lib/logRedaction"

describe("logRedaction", () => {
	describe("secrets are stripped", () => {
		it("masks values under secret-named keys (case-insensitive, substring)", () => {
			const out = redact({
				apiKey: "abc123",
				masterKeys: ["k1", "k2"],
				privateKey: "pk",
				publicKey: "pub",
				password: "hunter2",
				twoFactorCode: "000000",
				authToken: "t",
				sessionToken: "s",
				stringifiedClient: "{...}"
			}) as Record<string, unknown>

			expect(out["apiKey"]).toBe("[redacted]")
			expect(out["masterKeys"]).toBe("[redacted]")
			expect(out["privateKey"]).toBe("[redacted]")
			expect(out["publicKey"]).toBe("[redacted]")
			expect(out["password"]).toBe("[redacted]")
			expect(out["twoFactorCode"]).toBe("[redacted]")
			expect(out["authToken"]).toBe("[redacted]")
			expect(out["sessionToken"]).toBe("[redacted]")
			expect(out["stringifiedClient"]).toBe("[redacted]")
		})

		it("masks a bare `key` field (per-file encryption key in this app)", () => {
			const out = redact({ key: "AES-KEY-MATERIAL", name: "report.pdf" }) as Record<string, unknown>

			expect(out["key"]).toBe("[redacted]")
			expect(out["name"]).toBe("report.pdf")
		})

		it("masks a stringified-client / PEM / long-blob string VALUE even without a telltale key name", () => {
			expect(redact('{"masterKeys":["x"],"apiKey":"y"}')).toBe("[redacted]")
			expect(redact("-----BEGIN PRIVATE KEY-----\nMIIB...")).toBe("[redacted]")
			expect(redact("A".repeat(200))).toBe("[redacted]")
		})

		it("masks the StringifiedClient.authInfo field (V1/V2 master keys / V3 DEK)", () => {
			const out = redact({
				email: "user@example.com",
				apiKey: "a",
				authInfo: "deadbeef".repeat(8),
				baseFolderUUID: "550e8400-e29b-41d4-a716-446655440000"
			}) as Record<string, unknown>

			expect(out["authInfo"]).toBe("[redacted]")
			expect(out["apiKey"]).toBe("[redacted]")
			// Non-secret identifiers are kept.
			expect(out["baseFolderUUID"]).toBe("550e8400-e29b-41d4-a716-446655440000")
			expect(out["email"]).toBe("user@example.com")
		})

		it("masks a standalone 64-char hex key value under an unforeseen key name", () => {
			// A 64-hex master key / DEK that slipped under a non-secret-named field still gets caught
			// by the value heuristic (it evaded the old 128-char blob threshold).
			const masterKey = "a1b2c3d4".repeat(8) // 64 hex chars

			expect((redact({ blob: masterKey }) as Record<string, unknown>)["blob"]).toBe("[redacted]")
			// A UUID (hex with dashes, 36 chars) is NOT a bare 64-hex key → kept.
			expect((redact({ id: "550e8400-e29b-41d4-a716-446655440000" }) as Record<string, unknown>)["id"]).toBe(
				"550e8400-e29b-41d4-a716-446655440000"
			)
		})

		it("redacts a `queryKey` field (accepted over-redaction; key$ matches it) but keeps safe alternatives", () => {
			const out = redact({ queryKey: ["drive", "uuid-123"], queryHash: "h:abc", rowId: "reactQuery_v1:xyz", status: "error" }) as Record<string, unknown>

			expect(out["queryKey"]).toBe("[redacted]")
			// queryHash / rowId are the non-secret-matching names used for diagnostic identifiers (key/queryKey are redacted).
			expect(out["queryHash"]).toBe("h:abc")
			expect(out["rowId"]).toBe("reactQuery_v1:xyz")
			expect(out["status"]).toBe("error")
		})
	})

	describe("user data is intentionally kept (the diagnostic signal)", () => {
		it("keeps file/dir names, paths, sizes, uuids, and normal strings", () => {
			const out = redact({
				name: "Résumé 2024 .pdf",
				path: "/Vacation Photos/IMG_0001.heic",
				uuid: "550e8400-e29b-41d4-a716-446655440000",
				size: 12345,
				query: "tax documents"
			}) as Record<string, unknown>

			expect(out["name"]).toBe("Résumé 2024 .pdf")
			expect(out["path"]).toBe("/Vacation Photos/IMG_0001.heic")
			expect(out["uuid"]).toBe("550e8400-e29b-41d4-a716-446655440000")
			expect(out["size"]).toBe(12345)
			expect(out["query"]).toBe("tax documents")
		})

		it("keeps a realistic DriveItem shape's name but strips its encryption key", () => {
			const driveItem = {
				type: "file",
				data: {
					uuid: "abc",
					size: 100,
					decryptedMeta: {
						name: "weird‮name .pdf",
						mime: "application/pdf",
						key: "ENCRYPTION-KEY"
					}
				}
			}

			const out = redact(driveItem) as { data: { decryptedMeta: Record<string, unknown> } }

			expect(out.data.decryptedMeta["name"]).toBe("weird‮name .pdf")
			expect(out.data.decryptedMeta["mime"]).toBe("application/pdf")
			expect(out.data.decryptedMeta["key"]).toBe("[redacted]")
		})
	})

	describe("structural safety", () => {
		it("recurses through arrays and nested objects", () => {
			const out = redact({ items: [{ name: "a", apiKey: "x" }, { name: "b" }] }) as {
				items: Record<string, unknown>[]
			}

			expect(out.items[0]!["name"]).toBe("a")
			expect(out.items[0]!["apiKey"]).toBe("[redacted]")
			expect(out.items[1]!["name"]).toBe("b")
		})

		it("handles circular references without throwing", () => {
			const a: Record<string, unknown> = { name: "a" }

			a["self"] = a

			expect(() => redact(a)).not.toThrow()

			const out = redact(a) as Record<string, unknown>

			expect(out["name"]).toBe("a")
			expect(out["self"]).toBe("[circular]")
		})

		it("keeps an Error's message and stack (stacks are code paths, not user data)", () => {
			const err = new Error("disk full at /Users/x/file.txt")
			const out = redact(err) as { name: string; message: string; stack?: string }

			expect(out.name).toBe("Error")
			expect(out.message).toBe("disk full at /Users/x/file.txt")
			expect(typeof out.stack).toBe("string")
		})

		it("truncates very long (non-secret) strings instead of dropping them", () => {
			const long = `word ${"x ".repeat(2000)}`
			const out = redact(long) as string

			expect(out.length).toBeLessThan(long.length)
			expect(out.startsWith("word ")).toBe(true)
		})

		it("passes through primitives unchanged", () => {
			expect(redact(42)).toBe(42)
			expect(redact(true)).toBe(true)
			expect(redact(null)).toBe(null)
			expect(redact(undefined)).toBe(undefined)
		})

		it("stringifies bigint (JSON.stringify throws on raw bigint; filen uses it for sizes)", () => {
			expect(redact(100n)).toBe("100n")

			const out = redact({ size: 9007199254740993n, count: 2 }) as Record<string, unknown>

			expect(out["size"]).toBe("9007199254740993n")
			expect(out["count"]).toBe(2)

			// The redacted output must be JSON-serializable (no raw bigint survives).
			expect(() => JSON.stringify(out)).not.toThrow()
		})
	})

	describe("handles exotic data robustly (full-pipeline coverage)", () => {
		it("summarizes typed arrays instead of dumping a giant index-object", () => {
			const out = redact({ buf: new Uint8Array([1, 2, 3, 4]) }) as Record<string, unknown>

			expect(out["buf"]).toBe("[Uint8Array byteLength=4]")
			expect(() => JSON.stringify(out)).not.toThrow()
		})

		it("summarizes a raw ArrayBuffer", () => {
			const out = redact({ b: new ArrayBuffer(16) }) as Record<string, unknown>

			expect(out["b"]).toBe("[ArrayBuffer byteLength=16]")
		})

		it("never throws on a getter that throws — yields [unreadable] for that field", () => {
			const value = {
				ok: "fine",
				get bad(): string {
					throw new Error("boom")
				}
			}

			let out: Record<string, unknown> = {}

			expect(() => {
				out = redact(value) as Record<string, unknown>
			}).not.toThrow()

			expect(out["ok"]).toBe("fine")
			expect(out["bad"]).toBe("[unreadable]")
		})

		it("preserves a UniFFI tagged-union's type name + variant tag", () => {
			class FakeEnum {
				public readonly tag = "Io"
				public readonly inner = { code: 2 }
			}

			const fake = new FakeEnum()
			;(fake as unknown as Record<symbol, unknown>)[Symbol.for("typeName")] = "ErrorKind"

			const out = redact({ err: fake }) as Record<string, unknown>
			const err = out["err"] as Record<string, unknown>

			expect(err["__type"]).toBe("ErrorKind")
			expect(err["tag"]).toBe("Io")
			expect(err["inner"]).toEqual({ code: 2 })
		})
	})

	describe("depth + blob guards", () => {
		it("caps nesting deeper than MAX_DEPTH at [depth]", () => {
			let nested: unknown = { leaf: "bottom" }

			for (let i = 0; i < 12; i++) {
				nested = { child: nested }
			}

			const out = JSON.stringify(redact(nested))

			expect(out).toContain("[depth]")
			expect(out).not.toContain("bottom")
		})

		it("redacts a 128+ char high-entropy blob but keeps a 127-char string", () => {
			expect(redact("z".repeat(127))).toBe("z".repeat(127))
			expect(redact("z".repeat(128))).toBe("[redacted]")
		})
	})
})
