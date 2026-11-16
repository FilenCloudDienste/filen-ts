// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { mockNote } from "@/tests/fixtures/notes"

const { createNote, setNoteTypeOp, kv } = vi.hoisted(() => ({
	createNote: vi.fn(),
	setNoteTypeOp: vi.fn(),
	kv: new Map<string, unknown>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { createNote, setNoteType: setNoteTypeOp } }))
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})
vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string, schema: (value: unknown) => unknown) => {
		if (!kv.has(key)) {
			return Promise.resolve(null)
		}

		const value = kv.get(key)

		return Promise.resolve(schema(value) === value ? value : null)
	},
	kvSetJson: (key: string, value: unknown) => {
		kv.set(key, value)

		return Promise.resolve()
	}
}))

// The preference is held in memory from its boot read, so each case loads the modules afresh: a new held value, read
// from the kv store as the case left it.
async function freshModules() {
	vi.resetModules()

	const preferences = await import("@/features/notes/lib/preferences")
	const actions = await import("@/features/notes/lib/actions")
	const notes = await import("@/features/notes/queries/notes")

	return { ...preferences, createNoteAction: actions.createNote, notesQueryGet: notes.notesQueryGet }
}

beforeEach(() => {
	vi.clearAllMocks()
	kv.clear()
})

describe("default note type preference", () => {
	it("is text until set, and keeps a valid pick", async () => {
		const { getDefaultNoteType, loadDefaultNoteType, setDefaultNoteType } = await freshModules()

		await loadDefaultNoteType()

		expect(getDefaultNoteType()).toBe("text")

		setDefaultNoteType("checklist")

		expect(getDefaultNoteType()).toBe("checklist")
		await vi.waitFor(() => {
			expect(kv.get("notes.defaultType.v1")).toBe("checklist")
		})
	})

	it("falls back to text for a stored value that is no note type", async () => {
		kv.set("notes.defaultType.v1", "slides")

		const { getDefaultNoteType, loadDefaultNoteType } = await freshModules()

		await loadDefaultNoteType()

		expect(getDefaultNoteType()).toBe("text")
	})

	it("is held from the boot read, so the sidebar's first render already has it", async () => {
		kv.set("notes.defaultType.v1", "md")

		const { loadDefaultNoteType, useDefaultNoteType } = await freshModules()

		await loadDefaultNoteType()

		const { result } = renderHook(() => useDefaultNoteType())

		expect(result.current).toBe("md")
	})
})

describe("createNote with a default type", () => {
	it("makes no extra call for text", async () => {
		const { createNoteAction, loadDefaultNoteType } = await freshModules()

		await loadDefaultNoteType()
		createNote.mockResolvedValueOnce(mockNote())

		const outcome = await createNoteAction()

		expect(outcome.status).toBe("success")
		expect(setNoteTypeOp).not.toHaveBeenCalled()
	})

	it("retypes a new note to the default and lists the retyped note", async () => {
		kv.set("notes.defaultType.v1", "md")

		const { createNoteAction, loadDefaultNoteType, notesQueryGet } = await freshModules()

		await loadDefaultNoteType()

		const created = mockNote()
		const retyped = mockNote({ noteType: "md" })

		createNote.mockResolvedValueOnce(created)
		setNoteTypeOp.mockResolvedValueOnce(retyped)

		const outcome = await createNoteAction()

		expect(outcome).toEqual({ status: "success", item: retyped })
		expect(setNoteTypeOp).toHaveBeenCalledExactlyOnceWith(created, "md", "")
		expect(notesQueryGet()).toEqual([retyped])
	})

	it("keeps the text note when the retype fails", async () => {
		kv.set("notes.defaultType.v1", "code")

		const { createNoteAction, loadDefaultNoteType, notesQueryGet } = await freshModules()

		await loadDefaultNoteType()

		const created = mockNote()

		createNote.mockResolvedValueOnce(created)
		setNoteTypeOp.mockRejectedValueOnce(new Error("offline"))

		const outcome = await createNoteAction()

		expect(outcome).toEqual({ status: "success", item: created })
		expect(notesQueryGet()).toEqual([created])
	})

	it("reads the held default, never the store, across creates", async () => {
		kv.set("notes.defaultType.v1", "rich")

		const { createNoteAction, loadDefaultNoteType, setDefaultNoteType } = await freshModules()

		await loadDefaultNoteType()
		createNote.mockResolvedValue(mockNote())
		setNoteTypeOp.mockResolvedValue(mockNote({ noteType: "rich" }))

		await createNoteAction()
		kv.set("notes.defaultType.v1", "text")
		await createNoteAction()

		// The Appearance select sets the held value; a bare kv change is not seen.
		expect(setNoteTypeOp).toHaveBeenCalledTimes(2)

		setDefaultNoteType("text")
		await createNoteAction()

		expect(setNoteTypeOp).toHaveBeenCalledTimes(2)
	})

	it("returns the create error without a retype", async () => {
		kv.set("notes.defaultType.v1", "md")

		const { createNoteAction, loadDefaultNoteType } = await freshModules()

		await loadDefaultNoteType()
		createNote.mockRejectedValueOnce(new Error("note_limit_reached"))

		const outcome = await createNoteAction()

		expect(outcome.status).toBe("error")
		expect(setNoteTypeOp).not.toHaveBeenCalled()
	})
})
