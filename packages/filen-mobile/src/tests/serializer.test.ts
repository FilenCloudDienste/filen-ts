import { vi, describe, it, expect } from "vitest"

// uniffi-bindgen-react-native declares "type": "module" but ships CJS code,
// breaking Node imports. The real UniffiEnum is just an empty class with a
// variadic constructor — this mock is byte-for-byte identical to the real thing.
// Real SDK tagged union classes (DirMeta, ParentUuid, etc.) can't be imported
// in Node either, since they require native Rust modules at the top level.
vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

// Must import after vi.mock so the mock is active when serializer.ts loads
import { serialize, deserialize } from "@/lib/serializer"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function roundtrip(value: unknown): any {
	return deserialize(serialize(value))
}

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

describe("serializer", () => {
	describe("BigInt", () => {
		it("round-trips standalone BigInt", () => {
			const result = roundtrip(123n)

			expect(result).toBe(123n)
			expect(typeof result).toBe("bigint")
		})

		it("round-trips BigInt fields in objects", () => {
			const obj = { id: 42n, timestamp: 1709000000000n, name: "test" }
			const result = roundtrip(obj)

			expect(result.id).toBe(42n)
			expect(typeof result.id).toBe("bigint")
			expect(result.timestamp).toBe(1709000000000n)
			expect(typeof result.timestamp).toBe("bigint")
			expect(result.name).toBe("test")
		})

		it("round-trips zero and negative BigInt", () => {
			const result = roundtrip({ zero: 0n, neg: -42n })

			expect(result.zero).toBe(0n)
			expect(result.neg).toBe(-42n)
		})

		it("round-trips very large BigInt values", () => {
			const large = 9007199254740993n // Number.MAX_SAFE_INTEGER + 2
			const result = roundtrip(large)

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

			const result = roundtrip(obj)

			expect(result.user.id).toBe(99n)
			expect(result.user.stats.fileCount).toBe(1000n)
			expect(result.user.stats.totalSize).toBe(5368709120n)
		})

		it("round-trips BigInt in arrays", () => {
			const arr = [1n, 2n, 3n]
			const result = roundtrip(arr)

			expect(result).toEqual([1n, 2n, 3n])

			for (const val of result) {
				expect(typeof val).toBe("bigint")
			}
		})
	})

	describe("UniFFI tagged unions", () => {
		it("preserves [uniffiTypeNameSymbol] through round-trip", () => {
			const instance = new MockVariant("hello")
			const result = roundtrip(instance)

			expect(result[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.tag).toBe("Variant1")
			expect(result.inner).toEqual(["hello"])
		})

		it("preserves symbols in nested tagged unions", () => {
			const inner = new MockVariant("nested")
			const outer = new MockOuter(inner)
			const result = roundtrip(outer)

			expect(result[uniffiTypeNameSymbol]).toBe("OuterType")
			expect(result.tag).toBe("Wrapper")
			expect(result.inner[0][uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.inner[0].tag).toBe("Variant1")
			expect(result.inner[0].inner).toEqual(["nested"])
		})

		it("does not add symbol to plain objects with tag/inner shape", () => {
			const plain = { tag: "Foo", inner: ["bar"] }
			const result = roundtrip(plain)

			expect(result.tag).toBe("Foo")
			expect(result[uniffiTypeNameSymbol]).toBeUndefined()
		})

		it("preserves tagged union with empty inner", () => {
			const instance = new MockVariant("")
			const result = roundtrip(instance)

			expect(result[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.tag).toBe("Variant1")
			expect(result.inner).toEqual([""])
		})

		it("preserves tagged unions inside arrays within objects", () => {
			const obj = {
				items: [new MockVariant("first"), new MockVariant("second")],
				count: 2
			}

			const result = roundtrip(obj)

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
			const result = roundtrip(obj)

			expect(result.id).toBe(42n)
			expect(typeof result.id).toBe("bigint")
			expect(result.meta[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.meta.inner).toEqual(["value"])
		})

		it("preserves unit variant without inner property", () => {
			const instance = new MockUnitVariant()
			const result = roundtrip(instance)

			expect(result[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.tag).toBe("UnitTag")
			expect(result.inner).toBeUndefined()
			expect("inner" in result).toBe(false)
		})

		it("preserves named-fields variant with object inner", () => {
			const instance = new MockNamedFieldsVariant("hello", 42)
			const result = roundtrip(instance)

			expect(result[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.tag).toBe("NamedFields")
			expect(result.inner).toEqual({ name: "hello", value: 42 })
		})

		it("handles mixed unit and data variants in array", () => {
			const items = [new MockUnitVariant(), new MockVariant("data"), new MockUnitVariant(), new MockNamedFieldsVariant("test", 1)]
			const result = roundtrip(items)

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
			const result = roundtrip(instance)

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

			const result = roundtrip(obj)

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

			const result = roundtrip(obj)

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
		it("round-trips null", () => {
			expect(roundtrip(null)).toBeNull()
		})

		it("omits undefined object fields (JSON semantics)", () => {
			const obj = { name: "test", hash: undefined, size: 42 }
			const result = roundtrip(obj)

			expect(result.name).toBe("test")
			expect(result.size).toBe(42)
			expect("hash" in result).toBe(false)
		})

		it("preserves null but omits undefined (JSON semantics)", () => {
			const obj = { a: null, b: undefined, c: "yes" }
			const result = roundtrip(obj)

			expect(result.a).toBeNull()
			expect("a" in result).toBe(true)
			expect("b" in result).toBe(false)
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
			const result = roundtrip(fileMeta)

			expect(result.name).toBe("photo.jpg")
			expect(result.created).toBeUndefined()
			expect(result.hash).toBeUndefined()
			expect(result.modified).toBe(1709000000000n)
			expect(result.size).toBe(1024n)
		})

		it("converts undefined array elements to null (JSON semantics)", () => {
			const arr = [1, undefined, 3]
			const result = deserialize<(number | null)[]>(serialize(arr))

			expect(result[0]).toBe(1)
			expect(result[1]).toBeNull()
			expect(result[2]).toBe(3)
			expect(result).toHaveLength(3)
		})

		it("round-trips strings", () => {
			expect(roundtrip("hello")).toBe("hello")
		})

		it("round-trips empty string", () => {
			expect(roundtrip("")).toBe("")
		})

		it("round-trips unicode strings", () => {
			const str = "Hello \u{1F600} world \u00E9\u00E8\u00EA"

			expect(roundtrip(str)).toBe(str)
		})

		it("round-trips booleans", () => {
			expect(roundtrip(true)).toBe(true)
			expect(roundtrip(false)).toBe(false)
		})

		it("round-trips numbers", () => {
			expect(roundtrip(0)).toBe(0)
			expect(roundtrip(-1)).toBe(-1)
			expect(roundtrip(3.14)).toBeCloseTo(3.14)
			expect(roundtrip(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
		})

		it("round-trips empty object", () => {
			const result = roundtrip({})

			expect(result).toEqual({})
		})

		it("round-trips empty array", () => {
			const result = roundtrip([])

			expect(result).toEqual([])
		})

		it("round-trips arrays with mixed types", () => {
			const arr = [1, "two", 3n, null, true]
			const result = roundtrip(arr)

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
			const result = roundtrip(entries)

			expect(result).toEqual(entries)

			const restored = new Map(result)

			expect(restored.get("a")).toBe(1)
			expect(restored.get("b")).toBe(2)
			expect(restored.get("c")).toBe(3)
		})
	})

	describe("serialize returns string", () => {
		it("serialize returns a string", () => {
			const result = serialize({ hello: "world" })

			expect(typeof result).toBe("string")
		})

		it("deserialize accepts a string", () => {
			const result = roundtrip({ value: 42 })

			expect(result.value).toBe(42)
		})
	})

	describe("property descriptors", () => {
		it("deserialized symbol property is enumerable, writable, configurable", () => {
			const instance = new MockVariant("test")
			const result = roundtrip(instance)
			const descriptor = Object.getOwnPropertyDescriptor(result, uniffiTypeNameSymbol)

			expect(descriptor).toBeDefined()
			expect(descriptor!.value).toBe("TestType")
			expect(descriptor!.enumerable).toBe(true)
			expect(descriptor!.writable).toBe(true)
			expect(descriptor!.configurable).toBe(true)
		})

		it("inner array is frozen after deserialization", () => {
			const instance = new MockVariant("test")
			const result = roundtrip(instance)

			expect(Object.isFrozen(result.inner)).toBe(true)
		})

		it("inner non-array is NOT frozen after deserialization", () => {
			const instance = new MockNamedFieldsVariant("test", 42)
			const result = roundtrip(instance)

			expect(Object.isFrozen(result.inner)).toBe(false)
		})

		it("SDK instanceOf check pattern works on deserialized objects", () => {
			const instance = new MockVariant("test")
			const result = roundtrip(instance)

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
			const result = roundtrip(record)

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
			const result = roundtrip(record)

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
			const result = roundtrip(structure)

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
			const result = roundtrip(items)

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
			const result = roundtrip(driveItem)

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
			const result = roundtrip(driveItem)

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
			const result = roundtrip(driveItem)

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
			const result = roundtrip(entries)
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
			const result = roundtrip(entries)

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

			// serialize → deserialize (exactly what atomicWrite + readIndex does)
			const result = roundtrip(index)

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

		it("double serialize/deserialize of Index preserves all nested enums", () => {
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

			const first = roundtrip(index)
			const second = roundtrip(first)

			expect(second.files["uuid-1"].item.data.parent[uniffiTypeNameSymbol]).toBe("ParentUuid")
			expect(second.files["uuid-1"].item.data.parent.inner[0]).toBe("root")
			expect(second.files["uuid-1"].parent[uniffiTypeNameSymbol]).toBe("OuterType")
			expect(second.files["uuid-1"].parent.inner[0][uniffiTypeNameSymbol]).toBe("TestType")
			expect(second.files["uuid-1"].parent.inner[0].inner[0]).toBe("normal")
		})
	})

	describe("query key hashing", () => {
		it("serialize produces consistent output for identical query keys", () => {
			const key1 = ["useDriveItemStoredOfflineQuery", { type: "file", uuid: "abc-123" }]
			const key2 = ["useDriveItemStoredOfflineQuery", { type: "file", uuid: "abc-123" }]

			const hash1 = serialize(key1)
			const hash2 = serialize(key2)

			expect(hash1).toBe(hash2)
		})

		it("serialize produces different output for different query keys", () => {
			const key1 = ["query", { uuid: "aaa" }]
			const key2 = ["query", { uuid: "bbb" }]

			const hash1 = serialize(key1)
			const hash2 = serialize(key2)

			expect(hash1).not.toBe(hash2)
		})
	})

	describe("binary types", () => {
		it("round-trips ArrayBuffer preserving bytes", () => {
			const source = new Uint8Array([1, 2, 3, 4, 5])
			const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength)
			const result = roundtrip(buffer)

			expect(result).toBeInstanceOf(ArrayBuffer)
			expect(result.byteLength).toBe(5)
			expect(Array.from(new Uint8Array(result))).toEqual([1, 2, 3, 4, 5])
		})

		it("round-trips empty ArrayBuffer", () => {
			const result = roundtrip(new ArrayBuffer(0))

			expect(result).toBeInstanceOf(ArrayBuffer)
			expect(result.byteLength).toBe(0)
		})

		it("round-trips Uint8Array preserving bytes and type", () => {
			const arr = new Uint8Array([10, 20, 30, 40])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(Uint8Array)
			expect(result.length).toBe(4)
			expect(Array.from(result)).toEqual([10, 20, 30, 40])
		})

		it("round-trips empty Uint8Array", () => {
			const result = roundtrip(new Uint8Array(0))

			expect(result).toBeInstanceOf(Uint8Array)
			expect(result.length).toBe(0)
		})

		it("round-trips Int8Array with negative values", () => {
			const arr = new Int8Array([-128, -1, 0, 1, 127])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(Int8Array)
			expect(Array.from(result)).toEqual([-128, -1, 0, 1, 127])
		})

		it("round-trips Uint8ClampedArray", () => {
			const arr = new Uint8ClampedArray([0, 100, 200, 255])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(Uint8ClampedArray)
			expect(Array.from(result)).toEqual([0, 100, 200, 255])
		})

		it("round-trips Int16Array", () => {
			const arr = new Int16Array([-32768, -1, 0, 1, 32767])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(Int16Array)
			expect(Array.from(result)).toEqual([-32768, -1, 0, 1, 32767])
		})

		it("round-trips Uint16Array", () => {
			const arr = new Uint16Array([0, 256, 65535])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(Uint16Array)
			expect(Array.from(result)).toEqual([0, 256, 65535])
		})

		it("round-trips Int32Array", () => {
			const arr = new Int32Array([-2147483648, -1, 0, 1, 2147483647])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(Int32Array)
			expect(Array.from(result)).toEqual([-2147483648, -1, 0, 1, 2147483647])
		})

		it("round-trips Uint32Array", () => {
			const arr = new Uint32Array([0, 1, 4294967295])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(Uint32Array)
			expect(Array.from(result)).toEqual([0, 1, 4294967295])
		})

		it("round-trips Float32Array", () => {
			const arr = new Float32Array([1.5, -2.5, 0, 3.14])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(Float32Array)
			expect(result.length).toBe(4)
			expect(result[0]).toBeCloseTo(1.5)
			expect(result[1]).toBeCloseTo(-2.5)
			expect(result[2]).toBe(0)
			expect(result[3]).toBeCloseTo(3.14)
		})

		it("round-trips Float64Array", () => {
			const arr = new Float64Array([Math.PI, Math.E, Number.MAX_VALUE, Number.MIN_VALUE])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(Float64Array)
			expect(result[0]).toBe(Math.PI)
			expect(result[1]).toBe(Math.E)
			expect(result[2]).toBe(Number.MAX_VALUE)
			expect(result[3]).toBe(Number.MIN_VALUE)
		})

		it("round-trips BigInt64Array", () => {
			const arr = new BigInt64Array([-9223372036854775808n, 0n, 9223372036854775807n])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(BigInt64Array)
			expect(result[0]).toBe(-9223372036854775808n)
			expect(result[1]).toBe(0n)
			expect(result[2]).toBe(9223372036854775807n)
		})

		it("round-trips BigUint64Array", () => {
			const arr = new BigUint64Array([0n, 1n, 18446744073709551615n])
			const result = roundtrip(arr)

			expect(result).toBeInstanceOf(BigUint64Array)
			expect(result[0]).toBe(0n)
			expect(result[1]).toBe(1n)
			expect(result[2]).toBe(18446744073709551615n)
		})

		it("round-trips DataView preserving bytes", () => {
			const buffer = new ArrayBuffer(8)
			const view = new DataView(buffer)

			view.setInt32(0, 0x12345678, false)
			view.setInt32(4, -1, false)

			const result = roundtrip(view)

			expect(result).toBeInstanceOf(DataView)
			expect(result.byteLength).toBe(8)
			expect(result.getInt32(0, false)).toBe(0x12345678)
			expect(result.getInt32(4, false)).toBe(-1)
		})

		it("round-trips Buffer preserving bytes and type", () => {
			const buf = Buffer.from([1, 2, 3, 4, 5])
			const result = roundtrip(buf)

			expect(Buffer.isBuffer(result)).toBe(true)
			expect(result.length).toBe(5)
			expect(Array.from(result)).toEqual([1, 2, 3, 4, 5])
		})

		it("round-trips empty Buffer", () => {
			const result = roundtrip(Buffer.alloc(0))

			expect(Buffer.isBuffer(result)).toBe(true)
			expect(result.length).toBe(0)
		})

		it("serializes only the view's bytes for a subarray", () => {
			const full = new Uint8Array([10, 20, 30, 40, 50, 60])
			const slice = full.subarray(2, 5)
			const result = roundtrip(slice)

			expect(result).toBeInstanceOf(Uint8Array)
			expect(result.length).toBe(3)
			expect(Array.from(result)).toEqual([30, 40, 50])
		})

		it("preserves binary data inside nested objects", () => {
			const obj = {
				name: "file.bin",
				size: 5n,
				bytes: new Uint8Array([1, 2, 3, 4, 5]),
				header: new ArrayBuffer(2)
			}

			new Uint8Array(obj.header).set([0xff, 0xee])

			const result = roundtrip(obj)

			expect(result.name).toBe("file.bin")
			expect(result.size).toBe(5n)
			expect(result.bytes).toBeInstanceOf(Uint8Array)
			expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5])
			expect(result.header).toBeInstanceOf(ArrayBuffer)
			expect(Array.from(new Uint8Array(result.header))).toEqual([0xff, 0xee])
		})

		it("preserves binary data inside arrays", () => {
			const arr = [new Uint8Array([1]), new Int32Array([100, 200]), new Float64Array([1.5])]
			const result = roundtrip(arr)

			expect(result).toHaveLength(3)
			expect(result[0]).toBeInstanceOf(Uint8Array)
			expect(Array.from(result[0])).toEqual([1])
			expect(result[1]).toBeInstanceOf(Int32Array)
			expect(Array.from(result[1])).toEqual([100, 200])
			expect(result[2]).toBeInstanceOf(Float64Array)
			expect(result[2][0]).toBeCloseTo(1.5)
		})

		it("handles binary data alongside BigInt and UniffiEnum in one object", () => {
			const obj = {
				id: 99n,
				meta: new MockVariant("with-binary"),
				payload: new Uint8Array([0xde, 0xad, 0xbe, 0xef])
			}

			const result = roundtrip(obj)

			expect(result.id).toBe(99n)
			expect(result.meta[uniffiTypeNameSymbol]).toBe("TestType")
			expect(result.meta.inner).toEqual(["with-binary"])
			expect(result.payload).toBeInstanceOf(Uint8Array)
			expect(Array.from(result.payload)).toEqual([0xde, 0xad, 0xbe, 0xef])
		})

		it("double round-trip preserves binary type and bytes", () => {
			const arr = new Uint16Array([100, 200, 300, 400])
			const first = roundtrip(arr)
			const second = roundtrip(first)

			expect(second).toBeInstanceOf(Uint16Array)
			expect(Array.from(second)).toEqual([100, 200, 300, 400])
		})

		it("does not interpret a plain object with __bin: 1 as binary if shape mismatches", () => {
			const plain = { __bin: 2, k: "Uint8Array", d: "AQID" }
			const result = roundtrip(plain)

			expect(result).toEqual(plain)
		})
	})

	describe("idempotency", () => {
		it("double serialize/deserialize produces identical result", () => {
			const obj = {
				id: 42n,
				meta: new MockVariant("test"),
				items: [new MockVariant("a")],
				name: "hello"
			}

			const first = roundtrip(obj)
			const second = roundtrip(first)

			expect(second.id).toBe(42n)
			expect(second.name).toBe("hello")
			expect(second.meta.tag).toBe("Variant1")
			expect(second.meta.inner).toEqual(["test"])
			expect(second.items[0].inner).toEqual(["a"])
			expect(second.meta[uniffiTypeNameSymbol]).toBe("TestType")
			expect(second.items[0][uniffiTypeNameSymbol]).toBe("TestType")
		})

		it("double serialize/deserialize preserves instanceof and symbol", () => {
			const instance = new MockVariant("test")
			const first = roundtrip(instance)
			const second = roundtrip(first)

			expect(second instanceof UniffiEnum).toBe(true)
			expect(second[uniffiTypeNameSymbol]).toBe("TestType")
			expect(second.tag).toBe("Variant1")
			expect(second.inner).toEqual(["test"])
		})

		it("double serialize/deserialize preserves unit variant shape", () => {
			const instance = new MockUnitVariant()
			const first = roundtrip(instance)
			const second = roundtrip(first)

			expect(second instanceof UniffiEnum).toBe(true)
			expect(second[uniffiTypeNameSymbol]).toBe("TestType")
			expect(second.tag).toBe("UnitTag")
			expect(second.inner).toBeUndefined()
			expect("inner" in second).toBe(false)
		})
	})
})
