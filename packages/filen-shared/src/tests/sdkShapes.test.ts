import { describe, expect, it } from "vitest"
import type { DesktopSdkVariant } from "@filen/shared/desktop"
import { SdkShapeError, ubrnOf, wasmOf } from "@filen/shared/sdkShapes"
import { parseEnvelope } from "@filen/shared/session"

// Fixtures are stringifyEnvelope output (bigints as "$bigint:<d>n"), pretty-printed. JSON has no bytes, so a ubrn
// Uint8Array is stored as { "$bytes": "<hex>" }; the wasm side carries none (hex hashes, number[] raw metadata).
const CASES: Readonly<Record<string, DesktopSdkVariant>> = {
	file: "AnyFile.File",
	fileRawMeta: "AnyFile.File",
	fileNoHash: "AnyFile.File",
	fileNoStableUuid: "AnyFile.File",
	trashedFile: "AnyFile.File",
	sharedFile: "AnyFile.Shared",
	linkedFile: "AnyFile.Linked",
	dir: "AnyNormalDir.Dir",
	dirColored: "AnyNormalDir.Dir",
	dirEncryptedMeta: "AnyNormalDir.Dir",
	dirRawMeta: "AnyNormalDir.Dir",
	root: "AnyNormalDir.Root",
	sharedDirWithContext: "AnyDirWithContext.Shared.Dir",
	sharedRootWithContext: "AnyDirWithContext.Shared.Root",
	linkedDirWithContext: "AnyDirWithContext.Linked.Dir",
	linkedRootWithContext: "AnyDirWithContext.Linked.Root",
	linkedDirWithPassword: "AnyDirWithContext.Linked.Dir"
}

function reviveBytes(node: unknown): unknown {
	if (Array.isArray(node)) {
		return node.map(reviveBytes)
	}

	if (typeof node !== "object" || node === null) {
		return node
	}

	const obj = node as Record<string, unknown>
	const hex = obj["$bytes"]

	if (typeof hex === "string") {
		return Uint8Array.from(hex.match(/../g) ?? [], pair => parseInt(pair, 16))
	}

	return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, reviveBytes(value)]))
}

async function fixture(side: "wasm" | "ubrn", name: string): Promise<unknown> {
	const raw = ((await import(`./fixtures/sdkShapes/${side}/${name}.json?raw`)) as { default: string }).default

	return reviveBytes(parseEnvelope(raw))
}

function innerOf(ubrn: unknown): unknown {
	return (ubrn as { inner: [unknown] }).inner[0]
}

describe("sdkShapes", () => {
	describe("ubrnOf", () => {
		for (const [name, variant] of Object.entries(CASES)) {
			it(`converts ${name} (${variant})`, async () => {
				expect(ubrnOf(variant, await fixture("wasm", name))).toEqual(await fixture("ubrn", name))
			})
		}

		it("wraps a normal dir and root in the Normal context", async () => {
			expect(ubrnOf("AnyDirWithContext.Normal.Dir", await fixture("wasm", "dir"))).toEqual({
				tag: "Normal",
				inner: [await fixture("ubrn", "dir")]
			})
			expect(ubrnOf("AnyDirWithContext.Normal.Root", await fixture("wasm", "root"))).toEqual({
				tag: "Normal",
				inner: [await fixture("ubrn", "root")]
			})
		})

		it("keeps bigints and turns a share id into one", async () => {
			const shared = ubrnOf("AnyFile.Shared", await fixture("wasm", "sharedFile")) as {
				inner: [{ size: unknown; sharingRole: { inner: [{ id: unknown }] } }]
			}

			expect(typeof shared.inner[0].size).toBe("bigint")
			expect(shared.inner[0].sharingRole.inner[0].id).toBe(4242n)
		})

		it("writes the hash and raw metadata as Uint8Array", async () => {
			const file = ubrnOf("AnyFile.File", await fixture("wasm", "file")) as { inner: [{ meta: { inner: [{ hash: unknown }] } }] }
			const raw = ubrnOf("AnyNormalDir.Dir", await fixture("wasm", "dirRawMeta")) as { inner: [{ meta: { inner: [unknown] } }] }

			expect(file.inner[0].meta.inner[0].hash).toBeInstanceOf(Uint8Array)
			expect(raw.inner[0].meta.inner[0]).toBeInstanceOf(Uint8Array)
		})

		it("an unknown wasm field throws SdkShapeError", async () => {
			const file = (await fixture("wasm", "file")) as Record<string, unknown>

			expect(() => ubrnOf("AnyFile.File", { ...file, extra: 1 })).toThrow(SdkShapeError)
		})

		it("a missing required field throws SdkShapeError", async () => {
			const { region: _region, ...file } = (await fixture("wasm", "file")) as Record<string, unknown>

			expect(() => ubrnOf("AnyFile.File", file)).toThrow(SdkShapeError)
		})

		it("a hash that is not 64 hex chars throws SdkShapeError", async () => {
			const file = (await fixture("wasm", "file")) as { meta: { data: Record<string, unknown> } }

			for (const bad of ["ab".repeat(31), "zz".repeat(32), "ab".repeat(33)]) {
				const meta = {
					...file.meta,
					data: {
						...file.meta.data,
						hash: bad
					}
				}

				expect(() => ubrnOf("AnyFile.File", { ...file, meta })).toThrow(SdkShapeError)
			}
		})

		it("a variant that does not match the value's fields throws SdkShapeError", async () => {
			const root = await fixture("wasm", "root")
			const dir = await fixture("wasm", "dir")
			const sharedRoot = await fixture("wasm", "sharedRootWithContext")
			const file = await fixture("wasm", "file")

			expect(() => ubrnOf("AnyNormalDir.Dir", root)).toThrow(SdkShapeError)
			expect(() => ubrnOf("AnyNormalDir.Root", dir)).toThrow(SdkShapeError)
			expect(() => ubrnOf("AnyDirWithContext.Shared.Dir", sharedRoot)).toThrow(SdkShapeError)
			expect(() => ubrnOf("AnyFile.Shared", file)).toThrow(SdkShapeError)
		})

		it("an unknown meta type, sharing role or variant throws SdkShapeError", async () => {
			const dir = (await fixture("wasm", "dir")) as Record<string, unknown>
			const shared = (await fixture("wasm", "sharedDirWithContext")) as Record<string, unknown>

			expect(() => ubrnOf("AnyNormalDir.Dir", { ...dir, meta: { type: "decrypted", data: "x" } })).toThrow(SdkShapeError)
			expect(() => ubrnOf("AnyDirWithContext.Shared.Dir", { ...shared, shareInfo: { type: "owner", email: "a", id: 1 } })).toThrow(
				SdkShapeError
			)
			expect(() => ubrnOf("AnyFile.Folder" as DesktopSdkVariant, dir)).toThrow(SdkShapeError)
			expect(() => ubrnOf("toString" as DesktopSdkVariant, dir)).toThrow(SdkShapeError)
			expect(() => ubrnOf("AnyNormalDir.Dir", { ...dir, meta: { type: "constructor", data: "x" } })).toThrow(SdkShapeError)
		})

		it("takes a parent or color named like an Object member as a uuid or a custom color", async () => {
			const dir = (await fixture("wasm", "dir")) as Record<string, unknown>
			const converted = ubrnOf("AnyNormalDir.Dir", { ...dir, parent: "constructor", color: "toString" }) as {
				inner: [{ parent: unknown; color: unknown }]
			}

			expect(converted.inner[0].parent).toEqual({ tag: "Uuid", inner: ["constructor"] })
			expect(converted.inner[0].color).toEqual({ tag: "Custom", inner: ["toString"] })
		})

		it("names the field, never the value, in the error", async () => {
			const file = (await fixture("wasm", "file")) as { meta: { data: Record<string, unknown> } }
			const meta = {
				...file.meta,
				data: {
					...file.meta.data,
					key: 42
				}
			}

			expect(() => ubrnOf("AnyFile.File", { ...file, meta })).toThrow("meta.data.key: expected a string")
		})
	})

	describe("wasmOf", () => {
		for (const [name, kind] of [
			["file", "File"],
			["fileRawMeta", "File"],
			["fileNoHash", "File"],
			["fileNoStableUuid", "File"],
			["dir", "Dir"],
			["dirColored", "Dir"],
			["dirEncryptedMeta", "Dir"],
			["dirRawMeta", "Dir"]
		] as const) {
			it(`converts ${name} back`, async () => {
				expect(wasmOf(kind, innerOf(await fixture("ubrn", name)))).toEqual(await fixture("wasm", name))
			})
		}

		it("renders a trashed parent as trash", async () => {
			expect(wasmOf("File", innerOf(await fixture("ubrn", "trashedFile")))).toEqual(await fixture("wasm", "trashedFile"))
		})

		it("refuses a hash that is not 32 bytes and an unknown ubrn field", async () => {
			const file = innerOf(await fixture("ubrn", "file")) as { meta: { tag: string; inner: [Record<string, unknown>] } }
			const meta = {
				tag: file.meta.tag,
				inner: [
					{
						...file.meta.inner[0],
						hash: new Uint8Array(31)
					}
				]
			}

			expect(() => wasmOf("File", { ...file, meta })).toThrow(SdkShapeError)
			expect(() => wasmOf("File", { ...file, stableUUID: "x" })).toThrow(SdkShapeError)
		})

		it("refuses a Dir as a File", async () => {
			const dir = innerOf(await fixture("ubrn", "dir"))

			expect(() => wasmOf("File", dir)).toThrow(SdkShapeError)
		})
	})
})
