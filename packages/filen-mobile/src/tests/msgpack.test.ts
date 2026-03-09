import { vi, describe, it, expect } from "vitest"
import { Packr } from "msgpackr"

// uniffi-bindgen-react-native declares "type": "module" but ships CJS code,
// breaking Node imports. The real UniffiEnum is just an empty class with a
// variadic constructor — this mock is byte-for-byte identical to the real thing.
// Real SDK tagged union classes (DirMeta, ParentUuid, etc.) can't be imported
// in Node either, since they require native Rust modules at the top level.
const { UniffiEnum } = vi.hoisted(() => ({
	UniffiEnum: class UniffiEnum {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		protected constructor(..._args: any[]) {}
	}
}))

vi.mock("uniffi-bindgen-react-native", () => ({
	UniffiEnum
}))

// Must import after vi.mock so the mock is active when msgpack.ts loads
// eslint-disable-next-line import/first
import { pack, unpack } from "@/lib/msgpack"

const uniffiTypeNameSymbol = Symbol.for("typeName")

// Mirrors the exact pattern uniffi-bindgen-react-native generates for
// tagged union variants: extends UniffiEnum, sets [uniffiTypeNameSymbol],
// tag, inner as Object.freeze([value]), and calls super(typeName, variantName).
class MockVariant extends UniffiEnum {
	readonly [uniffiTypeNameSymbol] = "TestType"
	readonly tag = "Variant1"
	readonly inner: Readonly<[string]>

	constructor(value: string) {
		super("TestType", "Variant1")

		this.inner = Object.freeze([value])
	}
}

class MockOuter extends UniffiEnum {
	readonly [uniffiTypeNameSymbol] = "OuterType"
	readonly tag = "Wrapper"
	readonly inner: Readonly<[MockVariant]>

	constructor(value: MockVariant) {
		super("OuterType", "Wrapper")

		this.inner = Object.freeze([value])
	}
}

describe("msgpack", () => {
	describe("BigInt", () => {
		it("round-trips standalone BigInt", () => {
			const result = unpack(pack(123n))

			expect(result).toBe(123n)
			expect(typeof result).toBe("bigint")
		})

		it("round-trips BigInt fields in objects", () => {
			const obj = { id: 42n, timestamp: 1709000000000n, name: "test" }
			const result = unpack(pack(obj))

			expect(result.id).toBe(42n)
			expect(typeof result.id).toBe("bigint")
			expect(result.timestamp).toBe(1709000000000n)
			expect(typeof result.timestamp).toBe("bigint")
			expect(result.name).toBe("test")
		})

		it("round-trips zero and negative BigInt", () => {
			const result = unpack(pack({ zero: 0n, neg: -42n }))

			expect(result.zero).toBe(0n)
			expect(result.neg).toBe(-42n)
		})

		it("round-trips very large BigInt values", () => {
			const large = 9007199254740993n // Number.MAX_SAFE_INTEGER + 2
			const result = unpack(pack(large))

			expect(result).toBe(large)
			expect(typeof result).toBe("bigint")
		})

		it("round-trips BigInt in nested objects", () => {
			const obj = {
				user: {
					id: 99n,
					stats: {
						fileCount: 1000n,
						totalSize: 5368709120n
					}
				}
			}

			const result = unpack(pack(obj))

			expect(result.user.id).toBe(99n)
			expect(result.user.stats.fileCount).toBe(1000n)
			expect(result.user.stats.totalSize).toBe(5368709120n)
		})

		it("round-trips BigInt in arrays", () => {
			const arr = [1n, 2n, 3n]
			const result = unpack(pack(arr))

			expect(result).toEqual([1n, 2n, 3n])

			for (const val of result) {
				expect(typeof val).toBe("bigint")
			}
		})

		it("unpacks standard int64 as bigint (backward compat with old data)", () => {
			const defaultPackr = new Packr()
			const oldData = defaultPackr.pack({ id: 42n })

			const result = unpack(oldData)

			expect(typeof result.id).toBe("bigint")
			expect(result.id).toBe(42n)
		})
	})

	describe("UniFFI tagged unions", () => {
		it("preserves [uniffiTypeNameSymbol] through round-trip", () => {
			const instance = new MockVariant("hello")
			const result = unpack(pack(instance))

			expect(result[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.tag).toBe("Variant1")
			expect(result.inner).toEqual(["hello"])
		})

		it("preserves symbols in nested tagged unions", () => {
			const inner = new MockVariant("nested")
			const outer = new MockOuter(inner)
			const result = unpack(pack(outer))

			expect(result[uniffiTypeNameSymbol]).toBe("OuterType")
			expect(result.tag).toBe("Wrapper")
			expect(result.inner[0][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.inner[0].tag).toBe("Variant1")
			expect(result.inner[0].inner).toEqual(["nested"])
		})

		it("does not add symbol to plain objects with tag/inner shape", () => {
			const plain = { tag: "Foo", inner: ["bar"] }
			const result = unpack(pack(plain))

			expect(result.tag).toBe("Foo")
			expect(result[uniffiTypeNameSymbol]).toBeUndefined()
		})

		it("preserves tagged union with empty inner", () => {
			const instance = new MockVariant("")
			const result = unpack(pack(instance))

			expect(result[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.tag).toBe("Variant1")
			expect(result.inner).toEqual([""])
		})

		it("preserves tagged unions inside arrays within objects", () => {
			const obj = {
				items: [new MockVariant("first"), new MockVariant("second")],
				count: 2
			}

			const result = unpack(pack(obj))

			expect(result.count).toBe(2)
			expect(result.items).toHaveLength(2)
			expect(result.items[0][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.items[0].inner).toEqual(["first"])
			expect(result.items[1][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.items[1].inner).toEqual(["second"])
		})

		it("preserves tagged union with BigInt in same object", () => {
			const obj = {
				id: 42n,
				meta: new MockVariant("value")
			}
			const result = unpack(pack(obj))

			expect(result.id).toBe(42n)
			expect(typeof result.id).toBe("bigint")
			expect(result.meta[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.meta.inner).toEqual(["value"])
		})
	})

	describe("mixed data", () => {
		it("handles objects with BigInt and tagged unions together", () => {
			const variant = new MockVariant("data")

			const obj = {
				timestamp: 1709000000000n,
				userId: 42n,
				meta: variant,
				name: "test"
			}

			const result = unpack(pack(obj))

			expect(typeof result.timestamp).toBe("bigint")
			expect(result.timestamp).toBe(1709000000000n)
			expect(result.meta[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.meta.tag).toBe("Variant1")
			expect(result.name).toBe("test")
		})

		it("handles arrays of tagged unions", () => {
			const arr = [new MockVariant("a"), new MockVariant("b")]
			const result = unpack(pack(arr))

			expect(result).toHaveLength(2)
			expect(result[0][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result[0].inner).toEqual(["a"])
			expect(result[1][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result[1].inner).toEqual(["b"])
		})

		it("handles deeply nested structure with all custom types", () => {
			const obj = {
				users: [
					{
						id: 1n,
						meta: new MockOuter(new MockVariant("deep")),
						tags: [new MockVariant("tag1")]
					}
				],
				total: 100n
			}

			const result = unpack(pack(obj))

			expect(result.total).toBe(100n)
			expect(result.users[0].id).toBe(1n)
			expect(result.users[0].meta[uniffiTypeNameSymbol]).toBe("OuterType")
			expect(result.users[0].meta.inner[0][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.users[0].meta.inner[0].inner).toEqual(["deep"])
			expect(result.users[0].tags[0][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.users[0].tags[0].inner).toEqual(["tag1"])
		})
	})

	describe("standard types", () => {
		it("round-trips Uint8Array as binary", () => {
			const bytes = new Uint8Array([1, 2, 3, 4])
			const result = unpack(pack(bytes))

			expect(new Uint8Array(result)).toEqual(bytes)
		})

		it("round-trips empty Uint8Array", () => {
			const bytes = new Uint8Array([])
			const result = unpack(pack(bytes))

			expect(new Uint8Array(result)).toEqual(bytes)
		})

		it("round-trips null", () => {
			expect(unpack(pack(null))).toBeNull()
		})

		it("encodes undefined as null (encodeUndefinedAsNil)", () => {
			expect(unpack(pack(undefined))).toBeNull()
		})

		it("preserves undefined fields as null in objects", () => {
			const obj = { name: "test", hash: undefined, size: 42 }
			const result = unpack(pack(obj))

			expect(result.name).toBe("test")
			expect(result.hash).toBeNull()
			expect(result.size).toBe(42)
			expect("hash" in result).toBe(true)
		})

		it("round-trips strings", () => {
			expect(unpack(pack("hello"))).toBe("hello")
		})

		it("round-trips empty string", () => {
			expect(unpack(pack(""))).toBe("")
		})

		it("round-trips unicode strings", () => {
			const str = "Hello \u{1F600} world \u00E9\u00E8\u00EA"

			expect(unpack(pack(str))).toBe(str)
		})

		it("round-trips booleans", () => {
			expect(unpack(pack(true))).toBe(true)
			expect(unpack(pack(false))).toBe(false)
		})

		it("round-trips numbers", () => {
			expect(unpack(pack(0))).toBe(0)
			expect(unpack(pack(-1))).toBe(-1)
			expect(unpack(pack(3.14))).toBeCloseTo(3.14)
			expect(unpack(pack(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
		})

		it("round-trips empty object", () => {
			const result = unpack(pack({}))

			expect(result).toEqual({})
		})

		it("round-trips empty array", () => {
			const result = unpack(pack([]))

			expect(result).toEqual([])
		})

		it("round-trips arrays with mixed types", () => {
			const arr = [1, "two", 3n, null, true]
			const result = unpack(pack(arr))

			expect(result[0]).toBe(1)
			expect(result[1]).toBe("two")
			expect(result[2]).toBe(3n)
			expect(result[3]).toBeNull()
			expect(result[4]).toBe(true)
		})

		it("round-trips Map entries serialized as arrays", () => {
			const entries: [string, number][] = [["a", 1], ["b", 2], ["c", 3]]
			const result = unpack(pack(entries))

			expect(result).toEqual(entries)

			const restored = new Map(result)

			expect(restored.get("a")).toBe(1)
			expect(restored.get("b")).toBe(2)
			expect(restored.get("c")).toBe(3)
		})
	})

	describe("moreTypes", () => {
		it("round-trips Set", () => {
			const set = new Set(["a", "b", "c"])
			const result = unpack(pack(set))

			expect(result).toBeInstanceOf(Set)
			expect(result.size).toBe(3)
			expect(result.has("a")).toBe(true)
			expect(result.has("b")).toBe(true)
			expect(result.has("c")).toBe(true)
		})

		it("round-trips Map", () => {
			const map = new Map<string, number>([["x", 1], ["y", 2]])
			const result = unpack(pack(map))

			expect(result).toBeInstanceOf(Map)
			expect(result.size).toBe(2)
			expect(result.get("x")).toBe(1)
			expect(result.get("y")).toBe(2)
		})

		it("round-trips Date", () => {
			const date = new Date("2025-06-15T12:00:00Z")
			const result = unpack(pack(date))

			expect(result).toBeInstanceOf(Date)
			expect(result.getTime()).toBe(date.getTime())
		})

		it("round-trips Uint8Array with identity (not just Buffer)", () => {
			const bytes = new Uint8Array([10, 20, 30])
			const result = unpack(pack(bytes))

			expect(result).toBeInstanceOf(Uint8Array)
			expect(result).toEqual(bytes)
		})

		it("round-trips Float64Array", () => {
			const arr = new Float64Array([1.1, 2.2, 3.3])
			const result = unpack(pack(arr))

			expect(result).toBeInstanceOf(Float64Array)
			expect(result[0]).toBeCloseTo(1.1)
			expect(result[1]).toBeCloseTo(2.2)
			expect(result[2]).toBeCloseTo(3.3)
		})

		it("round-trips Set with BigInt values", () => {
			const set = new Set([1n, 2n, 3n])
			const result = unpack(pack(set))

			expect(result).toBeInstanceOf(Set)
			expect(result.has(1n)).toBe(true)
			expect(result.has(2n)).toBe(true)
		})

		it("round-trips Map with BigInt values", () => {
			const map = new Map([["size", 1024n], ["count", 42n]])
			const result = unpack(pack(map))

			expect(result).toBeInstanceOf(Map)
			expect(result.get("size")).toBe(1024n)
			expect(result.get("count")).toBe(42n)
		})

		it("round-trips nested moreTypes in objects", () => {
			const obj = {
				tags: new Set(["urgent", "draft"]),
				metadata: new Map([["key", "val"]]),
				created: new Date("2025-01-01T00:00:00Z"),
				hash: new Uint8Array([0xff, 0x00])
			}
			const result = unpack(pack(obj))

			expect(result.tags).toBeInstanceOf(Set)
			expect(result.tags.has("urgent")).toBe(true)
			expect(result.metadata).toBeInstanceOf(Map)
			expect(result.metadata.get("key")).toBe("val")
			expect(result.created).toBeInstanceOf(Date)
			expect(result.hash).toBeInstanceOf(Uint8Array)
			expect(result.hash).toEqual(new Uint8Array([0xff, 0x00]))
		})
	})

	describe("copyBuffers", () => {
		it("unpacked binary data is independent of source buffer", () => {
			const original = new Uint8Array([1, 2, 3, 4, 5])
			const packed = pack(original)
			const result = unpack(packed)

			// Mutate the packed buffer — result should be unaffected
			packed.fill(0)

			expect(result).toBeInstanceOf(Uint8Array)
			expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
		})
	})

	describe("idempotency", () => {
		it("double pack/unpack produces identical result", () => {
			const obj = {
				id: 42n,
				meta: new MockVariant("test"),
				items: [new MockVariant("a")],
				name: "hello"
			}

			const first = unpack(pack(obj))
			const second = unpack(pack(first))

			expect(second.id).toBe(42n)
			expect(second.name).toBe("hello")
			expect(second.meta.tag).toBe("Variant1")
			expect(second.meta.inner).toEqual(["test"])
			expect(second.items[0].inner).toEqual(["a"])
		})
	})
})
