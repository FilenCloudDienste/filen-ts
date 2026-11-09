import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { mockNote } from "@/tests/fixtures/notes"

const { createNote, setNoteTypeOp, kv } = vi.hoisted(() => ({
	createNote: vi.fn(),
	setNoteTypeOp: vi.fn(),
	kv: new Map<string, unknown>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { createNote, setNoteType: setNoteTypeOp } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
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

import { queryClient } from "@/queries/client"
import { notesQueryGet } from "@/features/notes/queries/notes"
import { createNote as createNoteAction } from "@/features/notes/lib/actions"
import { getDefaultNoteType, setDefaultNoteType } from "@/features/notes/lib/preferences"

beforeEach(() => {
	vi.clearAllMocks()
	kv.clear()
	queryClient.clear()
})

describe("default note type preference", () => {
	it("is text until set, and keeps a valid pick", async () => {
		await expect(getDefaultNoteType()).resolves.toBe("text")

		await setDefaultNoteType("checklist")

		expect(kv.get("notes.defaultType.v1")).toBe("checklist")
		await expect(getDefaultNoteType()).resolves.toBe("checklist")
	})

	it("falls back to text for a stored value that is no note type", async () => {
		kv.set("notes.defaultType.v1", "slides")

		await expect(getDefaultNoteType()).resolves.toBe("text")
	})
})

describe("createNote with a default type", () => {
	it("makes no extra call for text", async () => {
		createNote.mockResolvedValueOnce(mockNote())

		const outcome = await createNoteAction()

		expect(outcome.status).toBe("success")
		expect(setNoteTypeOp).not.toHaveBeenCalled()
	})

	it("retypes a new note to the default and lists the retyped note", async () => {
		kv.set("notes.defaultType.v1", "md")

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

		const created = mockNote()

		createNote.mockResolvedValueOnce(created)
		setNoteTypeOp.mockRejectedValueOnce(new Error("offline"))

		const outcome = await createNoteAction()

		expect(outcome).toEqual({ status: "success", item: created })
		expect(notesQueryGet()).toEqual([created])
	})

	it("reads the held default once across creates", async () => {
		kv.set("notes.defaultType.v1", "rich")
		createNote.mockResolvedValue(mockNote())
		setNoteTypeOp.mockResolvedValue(mockNote({ noteType: "rich" }))

		await createNoteAction()
		kv.set("notes.defaultType.v1", "text")
		await createNoteAction()

		// The Appearance select refetches the shared query after it writes; a bare kv change is not seen.
		expect(setNoteTypeOp).toHaveBeenCalledTimes(2)
	})

	it("returns the create error without a retype", async () => {
		kv.set("notes.defaultType.v1", "md")
		createNote.mockRejectedValueOnce(new Error("note_limit_reached"))

		const outcome = await createNoteAction()

		expect(outcome.status).toBe("error")
		expect(setNoteTypeOp).not.toHaveBeenCalled()
	})
})
