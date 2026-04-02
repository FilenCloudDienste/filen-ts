import { vi, describe, it, expect } from "vitest"
import { Packr } from "msgpackr"

// uniffi-bindgen-react-native declares "type": "module" but ships CJS code,
// breaking Node imports. The real UniffiEnum is just an empty class with a
// variadic constructor — this mock is byte-for-byte identical to the real thing.
// Real SDK tagged union classes (DirMeta, ParentUuid, etc.) can't be imported
// in Node either, since they require native Rust modules at the top level.
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

// Must import after vi.mock so the mock is active when msgpack.ts loads
import { pack, unpack } from "@/lib/msgpack"

const { UniffiEnum } = await import("@/tests/mocks/uniffiBindgenReactNative")

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

// Unit variant — no inner property at all, matching real SDK unit variants
// like ParentUuid.Trash, CreatedTime.Keep, DirColor.Default.
class MockUnitVariant extends UniffiEnum {
	readonly [uniffiTypeNameSymbol] = "TestType"
	readonly tag = "UnitTag"

	constructor() {
		super("TestType", "UnitTag")
	}
}

// Named-fields variant — inner is a frozen object, not a tuple.
class MockNamedFieldsVariant extends UniffiEnum {
	readonly [uniffiTypeNameSymbol] = "TestType"
	readonly tag = "NamedFields"
	readonly inner: Readonly<{ name: string; value: number }>

	constructor(name: string, value: number) {
		super("TestType", "NamedFields")

		this.inner = Object.freeze({ name, value })
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

		it("preserves unit variant without inner property", () => {
			const instance = new MockUnitVariant()
			const result = unpack(pack(instance))

			expect(result[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.tag).toBe("UnitTag")
			expect(result.inner).toBeUndefined()
			expect("inner" in result).toBe(false)
		})

		it("preserves named-fields variant with object inner", () => {
			const instance = new MockNamedFieldsVariant("hello", 42)
			const result = unpack(pack(instance))

			expect(result[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.tag).toBe("NamedFields")
			expect(result.inner).toEqual({ name: "hello", value: 42 })
		})

		it("handles mixed unit and data variants in array", () => {
			const items = [new MockUnitVariant(), new MockVariant("data"), new MockUnitVariant(), new MockNamedFieldsVariant("test", 1)]
			const result = unpack(pack(items))

			expect(result).toHaveLength(4)
			expect(result[0].tag).toBe("UnitTag")
			expect(result[0].inner).toBeUndefined()
			expect(result[1].tag).toBe("Variant1")
			expect(result[1].inner).toEqual(["data"])
			expect(result[2].tag).toBe("UnitTag")
			expect(result[2].inner).toBeUndefined()
			expect(result[3].tag).toBe("NamedFields")
			expect(result[3].inner).toEqual({ name: "test", value: 1 })
		})

		it("deserialized tagged union passes instanceof UniffiEnum", () => {
			const instance = new MockVariant("test")
			const result = unpack(pack(instance))

			expect(result instanceof UniffiEnum).toBe(true)
			expect(result[uniffiTypeNameSymbol]).toBe("TestType")
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
		it("round-trips empty Uint8Array", () => {
			const bytes = new Uint8Array([])
			const result = unpack(pack(bytes))

			expect(new Uint8Array(result)).toEqual(bytes)
		})

		it("round-trips raw ArrayBuffer", () => {
			const buffer = new Uint8Array([10, 20, 30]).buffer
			const result = unpack(pack(buffer))

			expect(new Uint8Array(result)).toEqual(new Uint8Array([10, 20, 30]))
		})

		it("round-trips empty ArrayBuffer", () => {
			const buffer = new ArrayBuffer(0)
			const result = unpack(pack(buffer))

			expect(new Uint8Array(result)).toEqual(new Uint8Array([]))
		})

		it("round-trips null", () => {
			expect(unpack(pack(null))).toBeNull()
		})

		it("round-trips standalone undefined", () => {
			expect(unpack(pack(undefined))).toBeUndefined()
		})

		it("preserves undefined object fields as undefined (not null)", () => {
			const obj = { name: "test", hash: undefined, size: 42 }
			const result = unpack(pack(obj))

			expect(result.name).toBe("test")
			expect(result.hash).toBeUndefined()
			expect(result.size).toBe(42)
			expect("hash" in result).toBe(true)
		})

		it("preserves null and undefined distinctly", () => {
			const obj = { a: null, b: undefined, c: "yes" }
			const result = unpack(pack(obj))

			expect(result.a).toBeNull()
			expect("a" in result).toBe(true)
			expect(result.b).toBeUndefined()
			expect("b" in result).toBe(true)
			expect(result.c).toBe("yes")
		})

		it("preserves undefined semantics for optional SDK-shaped fields", () => {
			const fileMeta = {
				name: "photo.jpg",
				mime: "image/jpeg",
				created: undefined,
				modified: 1709000000000n,
				hash: undefined,
				size: 1024n,
				key: "abc123",
				version: 2
			}
			const result = unpack(pack(fileMeta))

			expect(result.name).toBe("photo.jpg")
			expect(result.created).toBeUndefined()
			expect(result.hash).toBeUndefined()
			expect(result.modified).toBe(1709000000000n)
			expect(result.size).toBe(1024n)
		})

		it("preserves undefined in array elements", () => {
			const arr = [1, undefined, 3]
			const result = unpack(pack(arr))

			expect(result[0]).toBe(1)
			expect(result[1]).toBeUndefined()
			expect(result[2]).toBe(3)
			expect(result).toHaveLength(3)
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
			const entries: [string, number][] = [
				["a", 1],
				["b", 2],
				["c", 3]
			]
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
			const map = new Map<string, number>([
				["x", 1],
				["y", 2]
			])
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
			const map = new Map([
				["size", 1024n],
				["count", 42n]
			])
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

	describe("property descriptors", () => {
		it("deserialized symbol property is enumerable, writable, configurable", () => {
			const instance = new MockVariant("test")
			const result = unpack(pack(instance))
			const descriptor = Object.getOwnPropertyDescriptor(result, uniffiTypeNameSymbol)

			expect(descriptor).toBeDefined()
			expect(descriptor!.value).toBe("TestType")
			expect(descriptor!.enumerable).toBe(true)
			expect(descriptor!.writable).toBe(true)
			expect(descriptor!.configurable).toBe(true)
		})

		it("inner array is frozen after deserialization", () => {
			const instance = new MockVariant("test")
			const result = unpack(pack(instance))

			expect(Object.isFrozen(result.inner)).toBe(true)
		})

		it("inner non-array is NOT frozen after deserialization", () => {
			const instance = new MockNamedFieldsVariant("test", 42)
			const result = unpack(pack(instance))

			expect(Object.isFrozen(result.inner)).toBe(false)
		})

		it("SDK instanceOf check pattern works on deserialized objects", () => {
			const instance = new MockVariant("test")
			const result = unpack(pack(instance))

			const instanceOf = (obj: unknown): boolean => {
				return (obj as Record<symbol, unknown>)[uniffiTypeNameSymbol] === "TestType"
			}

			expect(instanceOf(result)).toBe(true)
		})
	})

	describe("frozen records with enum fields", () => {
		it("preserves UniffiEnum fields inside a frozen record", () => {
			const enumField = new MockVariant("inside-record")
			const record = Object.freeze({ dir: enumField, name: "test-dir" })
			const result = unpack(pack(record))

			expect(result.name).toBe("test-dir")
			expect(result.dir instanceof UniffiEnum).toBe(true)
			expect(result.dir[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.dir.tag).toBe("Variant1")
			expect(result.dir.inner).toEqual(["inside-record"])
		})

		it("preserves multiple UniffiEnum fields in one record", () => {
			const record = Object.freeze({
				dir: new MockVariant("dir-value"),
				shareInfo: new MockUnitVariant()
			})
			const result = unpack(pack(record))

			expect(result.dir[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.dir.tag).toBe("Variant1")
			expect(result.dir.inner).toEqual(["dir-value"])
			expect(result.shareInfo[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.shareInfo.tag).toBe("UnitTag")
			expect(result.shareInfo.inner).toBeUndefined()
		})
	})

	describe("triple-nested enums", () => {
		it("preserves enum → enum → record nesting", () => {
			const dirRecord = { uuid: "abc-123", name: "Documents", size: 1024n }
			const innerEnum = new MockVariant("dir-tag")
			const outerEnum = new MockOuter(innerEnum)

			const structure = {
				item: outerEnum,
				dirRecord
			}
			const result = unpack(pack(structure))

			expect(result.item[uniffiTypeNameSymbol]).toBe("OuterType")
			expect(result.item.inner[0][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.item.inner[0].inner).toEqual(["dir-tag"])
			expect(result.dirRecord.uuid).toBe("abc-123")
			expect(result.dirRecord.size).toBe(1024n)
		})
	})

	describe("multiple variants of same typeName", () => {
		it("distinguishes unit and data variants of the same enum type", () => {
			const items = [new MockUnitVariant(), new MockVariant("custom-color")]
			const result = unpack(pack(items))

			expect(result[0][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result[0].tag).toBe("UnitTag")
			expect("inner" in result[0]).toBe(false)

			expect(result[1][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result[1].tag).toBe("Variant1")
			expect(result[1].inner).toEqual(["custom-color"])
		})
	})

	describe("DriveItem-shaped structures", () => {
		it("round-trips a file-type DriveItem with SDK record data", () => {
			const driveItem = {
				type: "file",
				data: {
					uuid: "file-uuid-123",
					size: 5368709120n,
					decryptedMeta: {
						name: "photo.jpg",
						mime: "image/jpeg",
						created: 1709000000000n,
						modified: 1709000000001n,
						hash: undefined,
						key: "enc-key-abc"
					}
				}
			}
			const result = unpack(pack(driveItem))

			expect(result.type).toBe("file")
			expect(result.data.uuid).toBe("file-uuid-123")
			expect(result.data.size).toBe(5368709120n)
			expect(result.data.decryptedMeta.name).toBe("photo.jpg")
			expect(result.data.decryptedMeta.created).toBe(1709000000000n)
			expect(result.data.decryptedMeta.hash).toBeUndefined()
		})

		it("round-trips a directory DriveItem with DirColor enum", () => {
			const driveItem = {
				type: "directory",
				data: {
					uuid: "dir-uuid-456",
					color: new MockUnitVariant(),
					decryptedMeta: {
						name: "Documents"
					}
				}
			}
			const result = unpack(pack(driveItem))

			expect(result.type).toBe("directory")
			expect(result.data.uuid).toBe("dir-uuid-456")
			expect(result.data.color instanceof UniffiEnum).toBe(true)
			expect(result.data.color.tag).toBe("UnitTag")
			expect(result.data.decryptedMeta.name).toBe("Documents")
		})

		it("round-trips DriveItem with null decryptedMeta", () => {
			const driveItem = {
				type: "file",
				data: {
					uuid: "file-no-meta",
					size: 0n,
					decryptedMeta: null
				}
			}
			const result = unpack(pack(driveItem))

			expect(result.data.decryptedMeta).toBeNull()
			expect(result.data.size).toBe(0n)
		})
	})

	describe("cache persistence patterns", () => {
		it("round-trips Map entries with UniffiEnum values", () => {
			const map = new Map<string, { item: unknown; parent: unknown }>([
				["uuid-1", { item: { type: "file", data: { uuid: "uuid-1" } }, parent: new MockOuter(new MockVariant("normal")) }],
				["uuid-2", { item: { type: "directory", data: { uuid: "uuid-2" } }, parent: new MockUnitVariant() }]
			])

			const entries = [...map.entries()]
			const result = unpack(pack(entries))
			const restored = new Map(result)

			expect(restored.size).toBe(2)

			const entry1 = restored.get("uuid-1") as any

			expect(entry1.parent[uniffiTypeNameSymbol]).toBe("OuterType")
			expect(entry1.parent.inner[0][uniffiTypeNameSymbol]).toBe("TestType")

			const entry2 = restored.get("uuid-2") as any

			expect(entry2.parent[uniffiTypeNameSymbol]).toBe("TestType")
			expect(entry2.parent.tag).toBe("UnitTag")
		})

		it("round-trips PersistentMap-style array of [key, enum] pairs", () => {
			const entries: [string, unknown][] = [
				["dir-1", new MockVariant("normal-dir")],
				["dir-2", new MockOuter(new MockVariant("shared-dir"))]
			]
			const result = unpack(pack(entries))

			expect(result[0][1][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result[0][1].inner).toEqual(["normal-dir"])
			expect(result[1][1][uniffiTypeNameSymbol]).toBe("OuterType")
			expect(result[1][1].inner[0].inner).toEqual(["shared-dir"])
		})
	})

	describe("offline Index structure", () => {
		it("round-trips an Index with deeply nested UniffiEnums matching real SDK shape", () => {
			// Simulate: ParentUuid.Uuid("parent-uuid") — UniffiEnum with string inner
			class ParentUuidVariant extends UniffiEnum {
				readonly [uniffiTypeNameSymbol] = "ParentUuid"
				readonly tag = "Uuid"
				readonly inner: Readonly<[string]>

				constructor(uuid: string) {
					super("ParentUuid", "Uuid")

					this.inner = Object.freeze([uuid])
				}
			}

			// Simulate: DirColor.Blue — unit UniffiEnum
			class DirColorBlue extends UniffiEnum {
				readonly [uniffiTypeNameSymbol] = "DirColor"
				readonly tag = "Blue"

				constructor() {
					super("DirColor", "Blue")
				}
			}

			// Simulate: DirMeta.Encrypted("encrypted-data") — UniffiEnum with string inner
			class DirMetaEncrypted extends UniffiEnum {
				readonly [uniffiTypeNameSymbol] = "DirMeta"
				readonly tag = "Encrypted"
				readonly inner: Readonly<[string]>

				constructor(data: string) {
					super("DirMeta", "Encrypted")

					this.inner = Object.freeze([data])
				}
			}

			// Simulate: FileMeta.Decoded(decryptedMeta) — UniffiEnum with record inner
			class FileMetaDecoded extends UniffiEnum {
				readonly [uniffiTypeNameSymbol] = "FileMeta"
				readonly tag = "Decoded"
				readonly inner: Readonly<[Record<string, unknown>]>

				constructor(meta: Record<string, unknown>) {
					super("FileMeta", "Decoded")

					this.inner = Object.freeze([meta])
				}
			}

			// Simulate: AnyNormalDir.Dir(dir) — UniffiEnum with Dir record inner
			class AnyNormalDirDir extends UniffiEnum {
				readonly [uniffiTypeNameSymbol] = "AnyNormalDir"
				readonly tag = "Dir"
				readonly inner: Readonly<[Record<string, unknown>]>

				constructor(dir: Record<string, unknown>) {
					super("AnyNormalDir", "Dir")

					this.inner = Object.freeze([dir])
				}
			}

			// Simulate: AnyDirWithContext.Normal(anyNormalDir) — UniffiEnum with enum inner
			class AnyDirWithContextNormal extends UniffiEnum {
				readonly [uniffiTypeNameSymbol] = "AnyDirWithContext"
				readonly tag = "Normal"
				readonly inner: Readonly<[AnyNormalDirDir]>

				constructor(dir: AnyNormalDirDir) {
					super("AnyDirWithContext", "Normal")

					this.inner = Object.freeze([dir])
				}
			}

			// Build a realistic Dir record (frozen, from uniffiCreateRecord)
			const dirRecord = Object.freeze({
				uuid: "dir-uuid-123",
				parent: new ParentUuidVariant("root-uuid"),
				color: new DirColorBlue(),
				timestamp: 1709000000000n,
				favorited: false,
				meta: new DirMetaEncrypted("encrypted-dir-meta")
			})

			// Build a realistic File record
			const fileRecord = Object.freeze({
				uuid: "file-uuid-456",
				meta: new FileMetaDecoded({ name: "photo.jpg", mime: "image/jpeg", size: 1024n }),
				parent: new ParentUuidVariant("dir-uuid-123"),
				size: 5368709120n,
				favorited: true,
				region: "eu-central-1",
				bucket: "filen-1",
				timestamp: 1709000000001n,
				chunks: 5n,
				canMakeThumbnail: true
			})

			// Build the nested AnyDirWithContext
			const anyNormalDir = new AnyNormalDirDir(dirRecord)
			const parent = new AnyDirWithContextNormal(anyNormalDir)

			// Build the Index exactly as offline.ts does
			const index = {
				files: {
					"file-uuid-456": {
						item: { type: "file" as const, data: fileRecord },
						parent
					}
				},
				directories: {
					"dir-uuid-123": {
						item: { type: "directory" as const, data: dirRecord },
						parent
					}
				}
			}

			// pack → unpack (exactly what atomicWrite + readIndex does)
			const result = unpack(new Uint8Array(pack(index)))

			// Verify top-level structure
			expect(result.files["file-uuid-456"]).toBeDefined()
			expect(result.directories["dir-uuid-123"]).toBeDefined()

			// Verify file entry
			const fileEntry = result.files["file-uuid-456"]

			expect(fileEntry.item.type).toBe("file")
			expect(fileEntry.item.data.uuid).toBe("file-uuid-456")
			expect(fileEntry.item.data.size).toBe(5368709120n)
			expect(fileEntry.item.data.chunks).toBe(5n)
			expect(fileEntry.item.data.favorited).toBe(true)
			expect(fileEntry.item.data.region).toBe("eu-central-1")
			expect(fileEntry.item.data.canMakeThumbnail).toBe(true)

			// Verify File.meta (UniffiEnum: FileMeta.Decoded)
			expect(fileEntry.item.data.meta[uniffiTypeNameSymbol]).toBe("FileMeta")
			expect(fileEntry.item.data.meta.tag).toBe("Decoded")
			expect(fileEntry.item.data.meta.inner[0].name).toBe("photo.jpg")
			expect(fileEntry.item.data.meta.inner[0].size).toBe(1024n)
			expect(fileEntry.item.data.meta instanceof UniffiEnum).toBe(true)

			// Verify File.parent (UniffiEnum: ParentUuid.Uuid)
			expect(fileEntry.item.data.parent[uniffiTypeNameSymbol]).toBe("ParentUuid")
			expect(fileEntry.item.data.parent.tag).toBe("Uuid")
			expect(fileEntry.item.data.parent.inner[0]).toBe("dir-uuid-123")
			expect(fileEntry.item.data.parent instanceof UniffiEnum).toBe(true)

			// Verify parent AnyDirWithContext (triple nesting: AnyDirWithContext → AnyNormalDir → Dir record)
			expect(fileEntry.parent[uniffiTypeNameSymbol]).toBe("AnyDirWithContext")
			expect(fileEntry.parent.tag).toBe("Normal")
			expect(fileEntry.parent instanceof UniffiEnum).toBe(true)

			// Second level: AnyNormalDir
			const normalDir = fileEntry.parent.inner[0]

			expect(normalDir[uniffiTypeNameSymbol]).toBe("AnyNormalDir")
			expect(normalDir.tag).toBe("Dir")
			expect(normalDir instanceof UniffiEnum).toBe(true)

			// Third level: Dir record with its own UniffiEnum fields
			const innerDir = normalDir.inner[0]

			expect(innerDir.uuid).toBe("dir-uuid-123")
			expect(innerDir.timestamp).toBe(1709000000000n)

			// Dir.color (UniffiEnum: DirColor.Blue — unit variant)
			expect(innerDir.color[uniffiTypeNameSymbol]).toBe("DirColor")
			expect(innerDir.color.tag).toBe("Blue")
			expect(innerDir.color.inner).toBeUndefined()
			expect(innerDir.color instanceof UniffiEnum).toBe(true)

			// Dir.parent (UniffiEnum: ParentUuid.Uuid)
			expect(innerDir.parent[uniffiTypeNameSymbol]).toBe("ParentUuid")
			expect(innerDir.parent.inner[0]).toBe("root-uuid")

			// Dir.meta (UniffiEnum: DirMeta.Encrypted)
			expect(innerDir.meta[uniffiTypeNameSymbol]).toBe("DirMeta")
			expect(innerDir.meta.tag).toBe("Encrypted")
			expect(innerDir.meta.inner[0]).toBe("encrypted-dir-meta")

			// Verify directory entry shares the same parent structure
			const dirEntry = result.directories["dir-uuid-123"]

			expect(dirEntry.parent[uniffiTypeNameSymbol]).toBe("AnyDirWithContext")
			expect(dirEntry.parent.inner[0][uniffiTypeNameSymbol]).toBe("AnyNormalDir")
			expect(dirEntry.item.data.uuid).toBe("dir-uuid-123")
		})

		it("double pack/unpack of Index preserves all nested enums", () => {
			class SimpleEnum extends UniffiEnum {
				readonly [uniffiTypeNameSymbol] = "ParentUuid"
				readonly tag = "Uuid"
				readonly inner: Readonly<[string]>

				constructor(v: string) {
					super("ParentUuid", "Uuid")

					this.inner = Object.freeze([v])
				}
			}

			const index = {
				files: {
					"uuid-1": {
						item: { type: "file", data: { uuid: "uuid-1", parent: new SimpleEnum("root") } },
						parent: new MockOuter(new MockVariant("normal"))
					}
				},
				directories: {}
			}

			const first = unpack(new Uint8Array(pack(index)))
			const second = unpack(new Uint8Array(pack(first)))

			expect(second.files["uuid-1"].item.data.parent[uniffiTypeNameSymbol]).toBe("ParentUuid")
			expect(second.files["uuid-1"].item.data.parent.inner[0]).toBe("root")
			expect(second.files["uuid-1"].parent[uniffiTypeNameSymbol]).toBe("OuterType")
			expect(second.files["uuid-1"].parent.inner[0][uniffiTypeNameSymbol]).toBe("TestType")
			expect(second.files["uuid-1"].parent.inner[0].inner[0]).toBe("normal")
		})
	})

	describe("query key hashing", () => {
		it("pack produces consistent output for identical query keys", () => {
			const key1 = ["useDriveItemStoredOfflineQuery", { type: "file", uuid: "abc-123" }]
			const key2 = ["useDriveItemStoredOfflineQuery", { type: "file", uuid: "abc-123" }]

			const hash1 = pack(key1).toString("base64")
			const hash2 = pack(key2).toString("base64")

			expect(hash1).toBe(hash2)
		})

		it("pack produces different output for different query keys", () => {
			const key1 = ["query", { uuid: "aaa" }]
			const key2 = ["query", { uuid: "bbb" }]

			const hash1 = pack(key1).toString("base64")
			const hash2 = pack(key2).toString("base64")

			expect(hash1).not.toBe(hash2)
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
			expect(second.meta[uniffiTypeNameSymbol]).toBe("TestType")
			expect(second.items[0][uniffiTypeNameSymbol]).toBe("TestType")
		})

		it("double pack/unpack preserves instanceof and symbol", () => {
			const instance = new MockVariant("test")
			const first = unpack(pack(instance))
			const second = unpack(pack(first))

			expect(second instanceof UniffiEnum).toBe(true)
			expect(second[uniffiTypeNameSymbol]).toBe("TestType")
			expect(second.tag).toBe("Variant1")
			expect(second.inner).toEqual(["test"])
		})

		it("double pack/unpack preserves unit variant shape", () => {
			const instance = new MockUnitVariant()
			const first = unpack(pack(instance))
			const second = unpack(pack(first))

			expect(second instanceof UniffiEnum).toBe(true)
			expect(second[uniffiTypeNameSymbol]).toBe("TestType")
			expect(second.tag).toBe("UnitTag")
			expect(second.inner).toBeUndefined()
			expect("inner" in second).toBe(false)
		})
	})
})
