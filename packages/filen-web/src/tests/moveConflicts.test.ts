import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, UuidStr } from "@filen/sdk-rs"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { heldNamesOf, type ConflictAnswer } from "@/features/drive/lib/nameConflicts"
import { resolveMoveConflicts, type MoveConflictDeps } from "@/features/drive/lib/moveConflicts"
import { testUuid } from "@/tests/support/uuid"

const SOURCE = testUuid("move-source")
const DESTINATION = testUuid("move-destination")

function file(name: string, parent: UuidStr): DriveItem {
	return narrowItem({
		uuid: testUuid(`file-${name}-${parent}`),
		stableUUID: undefined,
		parent,
		size: 1n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
	} satisfies File)
}

function dir(name: string, parent: UuidStr): DriveItem {
	return narrowItem({
		uuid: testUuid(`dir-${name}-${parent}`),
		parent,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

function deps(destination: DriveItem[] | null, answer: ConflictAnswer | null, source: DriveItem[] = []) {
	const ask = vi.fn<MoveConflictDeps["ask"]>().mockResolvedValue(answer)
	const namesHeldIn = vi.fn<MoveConflictDeps["namesHeldIn"]>().mockResolvedValue(destination === null ? null : heldNamesOf(destination))
	const value: MoveConflictDeps = { namesHeldIn, ask, cachedNames: parent => (parent === SOURCE ? source : undefined) }

	return { value, ask, namesHeldIn }
}

describe("resolveMoveConflicts", () => {
	it("moves everything as before without asking when nothing clashes or nothing is known", async () => {
		const items = [file("a.txt", SOURCE)]

		for (const known of [[file("other.txt", DESTINATION)], null]) {
			const d = deps(known, null)

			await expect(resolveMoveConflicts(items, DESTINATION, d.value)).resolves.toEqual({ items, renames: new Map() })
			expect(d.ask).not.toHaveBeenCalled()
		}
	})

	it("asks once for all clashes, offering Replace only for a file onto a file", async () => {
		const a = file("a.txt", SOURCE)
		const docs = dir("docs", SOURCE)
		const d = deps([file("A.TXT", DESTINATION), dir("Docs", DESTINATION)], { choices: ["replace", "skip"], nested: "replace" })

		const resolved = await resolveMoveConflicts([a, docs], DESTINATION, d.value)

		expect(d.ask).toHaveBeenCalledOnce()
		expect(d.ask.mock.calls[0]?.[0].conflicts.map(conflict => [conflict.name, conflict.existing])).toEqual([
			["a.txt", "file"],
			["docs", "directory"]
		])
		expect(resolved).toEqual({ items: [a], renames: new Map() })
	})

	it("keeps both under a name free in the destination and in the item's own directory", async () => {
		const a = file("a.txt", SOURCE)
		const d = deps([file("a.txt", DESTINATION)], { choices: ["keepBoth"], nested: "replace" }, [a, file("a (1).txt", SOURCE)])

		const resolved = await resolveMoveConflicts([a], DESTINATION, d.value)

		expect(resolved.items).toEqual([a])
		expect(resolved.renames.get(a.data.uuid)).toBe("a (2).txt")
	})

	it("leaves an item already in the destination unasked", async () => {
		const own = file("a.txt", DESTINATION)
		const d = deps([own], null)

		await expect(resolveMoveConflicts([own], DESTINATION, d.value)).resolves.toEqual({ items: [own], renames: new Map() })
		expect(d.ask).not.toHaveBeenCalled()
	})

	it("skips every clash when the prompt is dismissed", async () => {
		const a = file("a.txt", SOURCE)
		const b = file("b.txt", SOURCE)
		const d = deps([file("a.txt", DESTINATION)], null)

		await expect(resolveMoveConflicts([a, b], DESTINATION, d.value)).resolves.toEqual({ items: [b], renames: new Map() })
	})
})
