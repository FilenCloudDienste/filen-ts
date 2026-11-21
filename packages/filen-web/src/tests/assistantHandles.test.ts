import { describe, expect, it } from "vitest"
import type { Dir, File, Note } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { AssistantHandleRegistry, ROOT_HANDLE } from "@/features/assistant/tools/handles"
import { testUuid } from "@/tests/support/uuid"

const directory = narrowItem({
	uuid: testUuid("dir"),
	parent: testUuid("root"),
	color: "default",
	timestamp: 0n,
	favorited: false,
	meta: { type: "decoded", data: { name: "Docs" } }
} satisfies Dir)

const file = narrowItem({
	uuid: testUuid("file"),
	stableUUID: undefined,
	parent: testUuid("dir"),
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "a.txt", mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
} satisfies File)

const note = { uuid: testUuid("note"), title: "Plan" } as Note

describe("AssistantHandleRegistry", () => {
	it("starts with the drive root as d0", () => {
		const registry = new AssistantHandleRegistry()

		expect(registry.get(ROOT_HANDLE)).toEqual({ ref: { handle: "d0", name: "/" }, entity: { kind: "root" } })
	})

	it("hands out short per-kind handles and never a uuid", () => {
		const registry = new AssistantHandleRegistry()

		expect(registry.register({ kind: "drive", item: directory }, "Docs")).toEqual({ handle: "d1", name: "Docs" })
		expect(registry.register({ kind: "drive", item: file }, "a.txt")).toEqual({ handle: "f1", name: "a.txt" })
		expect(registry.register({ kind: "note", note }, "Plan")).toEqual({ handle: "n1", name: "Plan" })
		expect(registry.entries().every(entry => !entry.ref.handle.includes("-"))).toBe(true)
	})

	it("keeps one handle per item for the conversation, with the newest name and the known path", () => {
		const registry = new AssistantHandleRegistry()

		registry.register({ kind: "drive", item: file, path: "/Docs/a.txt" }, "a.txt")

		const again = registry.register({ kind: "drive", item: file }, "b.txt")

		expect(again).toEqual({ handle: "f1", name: "b.txt" })
		expect(registry.get("f1")?.entity).toMatchObject({ kind: "drive", path: "/Docs/a.txt" })
	})

	it("resolves a handle with stray whitespace and forgets everything on clear, never reusing a number", () => {
		const registry = new AssistantHandleRegistry()

		registry.register({ kind: "note", note }, "Plan")

		expect(registry.get(" n1 ")?.ref.name).toBe("Plan")

		registry.clear()

		expect(registry.get("n1")).toBeUndefined()
		expect(registry.get(ROOT_HANDLE)).toBeDefined()
		// A reply that named n1 must not come to mean another item.
		expect(registry.register({ kind: "note", note }, "Plan").handle).toBe("n2")
	})

	it("numbers past the handles a resumed conversation's texts name", () => {
		const registry = new AssistantHandleRegistry()

		registry.clear(["Open the second one", "Found Invoice.pdf (f3) and Docs (d7); notes n12."])

		expect(registry.get("f3")).toBeUndefined()
		expect(registry.register({ kind: "drive", item: file }, "a.txt").handle).toBe("f4")
		expect(registry.register({ kind: "drive", item: directory }, "Docs").handle).toBe("d8")
		expect(registry.register({ kind: "note", note }, "Plan").handle).toBe("n13")
	})

	it("hands app help results h handles and sync pairs s handles, numbered past a resumed conversation's", () => {
		const registry = new AssistantHandleRegistry()

		registry.clear(["Turn it on in h2; the Work pair is s3."])

		const help = registry.register({ kind: "help", id: "two-factor", title: "Two-factor authentication" }, "Two-factor authentication")
		const pair = registry.register({ kind: "syncPair", pairId: "pair-1", name: "Work" }, "Work")

		expect([help.handle, pair.handle]).toEqual(["h3", "s4"])
		expect(registry.register({ kind: "syncPair", pairId: "pair-1", name: "Work" }, "Work").handle).toBe("s4")
		expect(registry.get("s4")?.entity).toEqual({ kind: "syncPair", pairId: "pair-1", name: "Work" })
	})
})
