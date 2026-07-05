import { describe, expect, it } from "vitest"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"

describe("envelope serializer (hardened $bigint marker with $str escaping)", () => {
	it("roundtrips bigints at any depth", () => {
		const v = { size: 123456789012345678n, neg: -1n, meta: { type: "decoded", data: { created: 1n } }, list: [2n, "x", 3] }
		expect(parseEnvelope(stringifyEnvelope(v))).toEqual(v)
	})
	it("roundtrips plain JSON untouched", () => {
		const v = { a: 1, b: "s", c: null, d: [true] }
		expect(parseEnvelope(stringifyEnvelope(v))).toEqual(v)
	})
	it("NO COLLISION: marker-shaped user strings roundtrip INTACT as strings", () => {
		const v = { s1: "$bigint:42n", s2: "$str:already-escaped", s3: "$bigint:not-digits-n" }
		expect(parseEnvelope(stringifyEnvelope(v))).toEqual(v)
	})
	it("rejects malformed bigint markers in foreign data (not written by us)", () => {
		expect(() => parseEnvelope('{"x":"$bigint:abcn"}')).toThrow()
	})
	it("throws on undefined root", () => {
		expect(() => stringifyEnvelope(undefined)).toThrow()
	})
})
