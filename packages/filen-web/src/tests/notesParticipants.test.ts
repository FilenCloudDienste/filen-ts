import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Contact, Note, NoteParticipant, UuidStr } from "@filen/sdk-rs"

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

const { addNoteParticipantOp, removeNoteParticipantOp, setNoteParticipantPermissionOp } = vi.hoisted(() => ({
	addNoteParticipantOp: vi.fn(),
	removeNoteParticipantOp: vi.fn(),
	setNoteParticipantPermissionOp: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		addNoteParticipant: addNoteParticipantOp,
		removeNoteParticipant: removeNoteParticipantOp,
		setNoteParticipantPermission: setNoteParticipantPermissionOp
	}
}))

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { queryClient as testQueryClient } from "@/queries/client"
import { NOTES_QUERY_KEY, notesQueryGet } from "@/features/notes/queries/notes"
import { addNoteParticipants, removeNoteParticipant, setNoteParticipantPermission } from "@/features/notes/lib/participants"
import { participantRows, contactsAvailableToAdd } from "@/features/notes/components/participantsDialog.logic"

beforeEach(() => {
	vi.clearAllMocks()
	testQueryClient.clear()
})

function mockNote(overrides: Partial<Note> = {}): Note {
	return {
		uuid: testUuid("note"),
		ownerId: 1n,
		lastEditorId: 1n,
		favorite: false,
		pinned: false,
		tags: [],
		noteType: "text",
		title: "note title",
		preview: "note preview",
		trash: false,
		archive: false,
		createdTimestamp: 0n,
		editedTimestamp: 0n,
		participants: [],
		...overrides
	}
}

function mockParticipant(overrides: Partial<NoteParticipant> = {}): NoteParticipant {
	return {
		userId: 2n,
		isOwner: false,
		email: "p@x.io",
		nickName: "p",
		permissionsWrite: false,
		addedTimestamp: 0n,
		...overrides
	}
}

function mockContact(overrides: Partial<Contact> = {}): Contact {
	return {
		uuid: testUuid("contact"),
		userId: 2n,
		email: "c@x.io",
		nickName: "c",
		lastActive: 0n,
		timestamp: 0n,
		publicKey: "",
		...overrides
	}
}

describe("addNoteParticipants — sequential ordering", () => {
	it("is a no-op (no worker call) when every contact is already a participant", async () => {
		const existing = mockParticipant({ userId: 5n })
		const note = mockNote({ participants: [existing] })
		const contact = mockContact({ userId: 5n })

		const outcome = await addNoteParticipants(note, [contact], true)

		expect(outcome).toEqual({ status: "success", item: note })
		expect(addNoteParticipantOp).not.toHaveBeenCalled()
	})

	it("threads each add through the PREVIOUS call's returned note, in list order", async () => {
		const note = mockNote({ participants: [] })
		const contactA = mockContact({ userId: 10n, email: "a@x.io" })
		const contactB = mockContact({ userId: 20n, email: "b@x.io" })

		const afterA = mockNote({ participants: [mockParticipant({ userId: 10n, email: "a@x.io" })] })
		const afterB = mockNote({
			participants: [mockParticipant({ userId: 10n, email: "a@x.io" }), mockParticipant({ userId: 20n, email: "b@x.io" })]
		})

		addNoteParticipantOp.mockResolvedValueOnce(afterA)
		addNoteParticipantOp.mockResolvedValueOnce(afterB)

		const outcome = await addNoteParticipants(note, [contactA, contactB], true)

		// Call 1: the ORIGINAL note. Call 2: call 1's OWN result, not the original — proves the loop
		// threads state forward instead of each add starting from the same stale base (mobile's own
		// addParticipants rationale: a parallel Promise.all would have the last write clobber the rest).
		expect(addNoteParticipantOp).toHaveBeenNthCalledWith(1, note, contactA, true)
		expect(addNoteParticipantOp).toHaveBeenNthCalledWith(2, afterA, contactB, true)
		expect(outcome).toEqual({ status: "success", item: afterB })
		expect(notesQueryGet()).toEqual([afterB])
	})

	it("skips only the already-present contacts, still adding the rest", async () => {
		const existing = mockParticipant({ userId: 5n })
		const note = mockNote({ participants: [existing] })
		const already = mockContact({ userId: 5n })
		const fresh = mockContact({ userId: 6n })
		const afterFresh = mockNote({ participants: [existing, mockParticipant({ userId: 6n })] })

		addNoteParticipantOp.mockResolvedValueOnce(afterFresh)

		const outcome = await addNoteParticipants(note, [already, fresh], true)

		expect(addNoteParticipantOp).toHaveBeenCalledExactlyOnceWith(note, fresh, true)
		expect(outcome).toEqual({ status: "success", item: afterFresh })
	})

	it("returns an error outcome on rejection, without patching the cache", async () => {
		const note = mockNote({ participants: [] })
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [note])
		addNoteParticipantOp.mockRejectedValueOnce(new Error("fail"))

		const outcome = await addNoteParticipants(note, [mockContact()], true)

		expect(outcome.status).toBe("error")
		expect(notesQueryGet()).toEqual([note])
	})
})

describe("removeNoteParticipant", () => {
	it("is a no-op (no worker call) when the participant isn't on the note", async () => {
		const note = mockNote({ participants: [] })

		const outcome = await removeNoteParticipant(note, mockParticipant())

		expect(outcome).toEqual({ status: "success", item: note })
		expect(removeNoteParticipantOp).not.toHaveBeenCalled()
	})

	it("removes and upserts the resulting note", async () => {
		const participant = mockParticipant({ userId: 5n })
		const note = mockNote({ participants: [participant] })
		const updated = mockNote({ participants: [] })
		removeNoteParticipantOp.mockResolvedValueOnce(updated)

		const outcome = await removeNoteParticipant(note, participant)

		expect(removeNoteParticipantOp).toHaveBeenCalledExactlyOnceWith(note, 5n)
		expect(outcome).toEqual({ status: "success", item: updated })
		expect(notesQueryGet()).toEqual([updated])
	})
})

describe("setNoteParticipantPermission — patches the LIVE cache row, not a stale snapshot", () => {
	it("no-ops when the requested permission already matches", async () => {
		const participant = mockParticipant({ permissionsWrite: true })
		const note = mockNote({ participants: [participant] })

		const outcome = await setNoteParticipantPermission(note, participant, true)

		expect(outcome).toEqual({ status: "success", item: note })
		expect(setNoteParticipantPermissionOp).not.toHaveBeenCalled()
	})

	it("patches onto whatever the cache holds NOW, even if it moved since the caller's own snapshot", async () => {
		const participant = mockParticipant({ userId: 5n, permissionsWrite: false })
		const staleNote = mockNote({ participants: [participant] })
		// The cache has since gained an UNRELATED second participant this caller's own `note` argument
		// doesn't know about — a naive patch built off the stale argument would silently drop them.
		const otherParticipant = mockParticipant({ userId: 6n })
		const liveNote = mockNote({ participants: [participant, otherParticipant] })
		testQueryClient.setQueryData(NOTES_QUERY_KEY, [liveNote])

		const updatedParticipant = { ...participant, permissionsWrite: true }
		setNoteParticipantPermissionOp.mockResolvedValueOnce(updatedParticipant)

		const outcome = await setNoteParticipantPermission(staleNote, participant, true)

		expect(setNoteParticipantPermissionOp).toHaveBeenCalledExactlyOnceWith(staleNote.uuid, participant, true)
		expect(outcome.status).toBe("success")
		expect(notesQueryGet()).toEqual([{ ...liveNote, participants: [updatedParticipant, otherParticipant] }])
	})
})

describe("participantRows — self-exclusion, ordering, and owner/participant view gating", () => {
	const owner = mockParticipant({ userId: 1n, isOwner: true })
	const participantA = mockParticipant({ userId: 2n, isOwner: false })
	const participantB = mockParticipant({ userId: 3n, isOwner: false })
	const note = mockNote({ ownerId: 1n, participants: [participantA, owner, participantB] })

	it("excludes the viewer's own row entirely (mirrors mobile: self-management stays the menu's own Leave dialog)", () => {
		expect(participantRows(note, 2n, false).map(r => r.participant.userId)).toEqual([1n, 3n])
	})

	it("a note with no OTHER participants (the solo-owner case) returns an empty list, not a self-row", () => {
		expect(participantRows(mockNote({ ownerId: 1n, participants: [owner] }), 1n, true)).toEqual([])
	})

	it("sorts the owner's row first among what remains", () => {
		expect(participantRows(note, 3n, false).map(r => r.participant.userId)).toEqual([1n, 2n])
	})

	it("owner viewer: canManage is true on every remaining (non-owner) row", () => {
		const rows = participantRows(note, 1n, true)

		expect(rows.map(r => r.participant.userId)).toEqual([2n, 3n])
		expect(rows.every(r => r.canManage)).toBe(true)
	})

	it("participant viewer: canManage is false on every row, including the owner's", () => {
		const rows = participantRows(note, 2n, false)

		expect(rows.every(r => !r.canManage)).toBe(true)
	})

	it("the owner's row never gets canManage even when it survives another owner-viewer's self-filter", () => {
		// A third participant viewing an owned note they don't own themselves: the owner's row is
		// present (not self) but still never manageable — only a genuinely non-owner row ever is.
		const rows = participantRows(note, 3n, false)

		expect(rows.find(r => r.participant.userId === 1n)?.canManage).toBe(false)
	})
})

describe("contactsAvailableToAdd", () => {
	it("filters out contacts already a participant, preserving source order", () => {
		const note = mockNote({ participants: [mockParticipant({ userId: 5n })] })
		const already = mockContact({ userId: 5n })
		const fresh1 = mockContact({ uuid: testUuid("c1"), userId: 6n })
		const fresh2 = mockContact({ uuid: testUuid("c2"), userId: 7n })

		expect(contactsAvailableToAdd([already, fresh1, fresh2], note)).toEqual([fresh1, fresh2])
	})

	it("returns every contact when none are participants yet", () => {
		const note = mockNote({ participants: [] })
		const contacts = [mockContact({ userId: 1n }), mockContact({ userId: 2n })]

		expect(contactsAvailableToAdd(contacts, note)).toEqual(contacts)
	})
})
