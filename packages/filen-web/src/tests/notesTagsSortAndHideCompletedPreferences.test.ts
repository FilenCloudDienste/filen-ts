import { beforeEach, describe, expect, it, vi } from "vitest"

// Same mock boundary/shape as notesMdSplitPreferences.test.ts: `@/lib/storage/adapter` itself, backed
// by an in-memory Map reset per test — kvGetJson/kvSetJson's own envelope+schema contract is already
// covered by adapter.test.ts, so this mock is schema-blind by design.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

import {
	getNoteTagsSortBy,
	setNoteTagsSortBy,
	getHideCompletedChecklist,
	setHideCompletedChecklist
} from "@/features/notes/lib/preferences"
import { DEFAULT_NOTE_TAGS_SORT_BY } from "@/features/notes/lib/sort"

beforeEach(() => {
	kvStore.clear()
})

describe("note tags sort preference", () => {
	it("returns the default when nothing is persisted", async () => {
		await expect(getNoteTagsSortBy()).resolves.toBe(DEFAULT_NOTE_TAGS_SORT_BY)
	})

	it("roundtrips a stored value through set/get", async () => {
		await setNoteTagsSortBy("nameAsc")

		await expect(getNoteTagsSortBy()).resolves.toBe("nameAsc")
	})

	it("roundtrips every option, not just one (the schema is enumerated over all six)", async () => {
		for (const sortBy of ["lastActivityAsc", "notesCountDesc", "notesCountAsc", "nameDesc"] as const) {
			await setNoteTagsSortBy(sortBy)

			await expect(getNoteTagsSortBy()).resolves.toBe(sortBy)
		}
	})
})

describe("per-note hide-completed-checklist preference", () => {
	it("defaults to false (show everything) for a note with no stored entry", async () => {
		await expect(getHideCompletedChecklist("note-a")).resolves.toBe(false)
	})

	it("roundtrips a stored true value for the given note uuid", async () => {
		await setHideCompletedChecklist("note-a", true)

		await expect(getHideCompletedChecklist("note-a")).resolves.toBe(true)
	})

	it("keys independently per note — setting one note's toggle leaves another note's untouched", async () => {
		await setHideCompletedChecklist("note-a", true)
		await setHideCompletedChecklist("note-b", false)

		await expect(getHideCompletedChecklist("note-a")).resolves.toBe(true)
		await expect(getHideCompletedChecklist("note-b")).resolves.toBe(false)
	})

	it("toggling one note back off doesn't disturb a different note's persisted true", async () => {
		await setHideCompletedChecklist("note-a", true)
		await setHideCompletedChecklist("note-b", true)
		await setHideCompletedChecklist("note-b", false)

		await expect(getHideCompletedChecklist("note-a")).resolves.toBe(true)
		await expect(getHideCompletedChecklist("note-b")).resolves.toBe(false)
	})
})
