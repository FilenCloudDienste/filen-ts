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
	it("revives a root marker string", () => {
		expect(parseEnvelope(stringifyEnvelope(42n))).toBe(42n)
		expect(parseEnvelope(stringifyEnvelope("$bigint:1n"))).toBe("$bigint:1n")
		expect(parseEnvelope(stringifyEnvelope("plain"))).toBe("plain")
		expect(parseEnvelope("null")).toBeNull()
	})
	it("revives nested arrays of bigints and escaped strings", () => {
		const v = [[1n, ["$str:x", [-2n, "$bigint:3n"]]], { a: [[4n]] }]
		expect(parseEnvelope(stringifyEnvelope(v))).toEqual(v)
	})
	it("revives markers written with the JSON escape for $", () => {
		expect(parseEnvelope('{"a":"\\u0024bigint:5n","b":["\\u0024str:$bigint:1n"]}')).toEqual({ a: 5n, b: ["$bigint:1n"] })
		expect(parseEnvelope('{"a":"\\u0024bigint:5n"}')).toEqual({ a: 5n })
	})
	it("keeps an own __proto__ key an own property without touching the prototype", () => {
		const parsed = parseEnvelope('{"__proto__":"$bigint:7n","x":{"__proto__":{"y":"$bigint:8n"}}}') as Record<string, unknown>
		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
		expect(Object.getOwnPropertyDescriptor(parsed, "__proto__")?.value).toBe(7n)
		const x = parsed["x"] as Record<string, unknown>
		expect(Object.getPrototypeOf(x)).toBe(Object.prototype)
		expect(Object.getOwnPropertyDescriptor(x, "__proto__")?.value).toEqual({ y: 8n })
	})
	it("preserves key order", () => {
		const parsed = parseEnvelope(stringifyEnvelope({ z: 1n, a: "$str:", m: 2, b: 3n })) as Record<string, unknown>
		expect(Object.keys(parsed)).toEqual(["z", "a", "m", "b"])
	})
	it("rejects both malformed bigint shapes with the same error", () => {
		expect(() => parseEnvelope('{"x":"$bigint:12"}')).toThrow("invalid $bigint envelope")
		expect(() => parseEnvelope('["$bigint:1.5n"]')).toThrow("invalid $bigint envelope")
		expect(() => parseEnvelope('"$bigint:abcn"')).toThrow("invalid $bigint envelope")
	})
	it("matches a JSON.parse reviver on a mixed payload", () => {
		const reviver = (raw: string): unknown =>
			JSON.parse(raw, (_k, v: unknown) => {
				if (typeof v !== "string") return v
				if (v.startsWith("$str:")) return v.slice(5)
				if (v.startsWith("$bigint:")) return BigInt(v.slice(8, -1))
				return v
			})
		const v = {
			items: Array.from({ length: 50 }, (_, i) => ({
				uuid: `u${String(i)}`,
				size: BigInt(i) * 1000n,
				name: i % 3 === 0 ? "$bigint:9n" : "$x",
				tags: [i, `$str:${String(i)}`, null]
			})),
			root: { nested: { deep: [[[-1n]]] } },
			empty: {},
			none: []
		}
		const raw = stringifyEnvelope(v)
		expect(parseEnvelope(raw)).toStrictEqual(reviver(raw))
		expect(parseEnvelope(raw)).toStrictEqual(v)
	})
	it("throws on undefined root", () => {
		expect(() => stringifyEnvelope(undefined)).toThrow()
	})
})
