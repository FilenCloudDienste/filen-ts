// @vitest-environment jsdom

// The participants dialog tracks one operation at a time, so while one runs every row must stay locked:
// a second one started meanwhile would be unlocked again (and the dialog closable) by the first to end.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import type { Note, NoteParticipant } from "@filen/sdk-rs"
import "@/lib/i18n"

const { setNoteParticipantPermission, blockContactByEmail } = vi.hoisted(() => ({
	setNoteParticipantPermission: vi.fn(),
	blockContactByEmail: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

vi.mock("@/features/notes/lib/participants", () => ({
	addNoteParticipants: vi.fn(),
	removeNoteParticipant: vi.fn(),
	setNoteParticipantPermission
}))

vi.mock("@/features/contacts/lib/actions", () => ({
	blockContactByEmail,
	unblockContact: vi.fn()
}))

vi.mock("@/features/notes/queries/notes", () => ({ useNotes: () => ({ data: undefined }) }))

vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: { id: 1n } }) }))

vi.mock("@/features/contacts/queries/contacts", () => ({
	useContactsQuery: () => ({ status: "success", data: { contacts: [], blocked: [] } })
}))

const { ParticipantsDialog } = await import("@/features/notes/components/participantsDialog")

function participant(userId: bigint, email: string): NoteParticipant {
	return { userId, isOwner: false, email, nickName: email, permissionsWrite: false, addedTimestamp: 0n }
}

const note: Note = {
	uuid: "note-0000-0000-0000-000000000000",
	ownerId: 1n,
	lastEditorId: 1n,
	favorite: false,
	pinned: false,
	tags: [],
	noteType: "text",
	encryptionKey: "note-key",
	title: "title",
	preview: "",
	trash: false,
	archive: false,
	createdTimestamp: 0n,
	editedTimestamp: 0n,
	participants: [
		{ ...participant(1n, "owner@x.io"), isOwner: true, permissionsWrite: true },
		participant(2n, "a@x.io"),
		participant(3n, "b@x.io")
	]
}

beforeEach(() => {
	setNoteParticipantPermission.mockReset()
	blockContactByEmail.mockReset()
})

afterEach(() => {
	cleanup()
})

describe("ParticipantsDialog — one operation at a time", () => {
	it("locks every row's controls while one participant's change is in flight", async () => {
		let finish: (outcome: { status: "success" }) => void = () => undefined

		setNoteParticipantPermission.mockReturnValue(
			new Promise(resolve => {
				finish = resolve
			})
		)
		render(createElement(ParticipantsDialog, { note, onClose: () => undefined }))

		fireEvent.click(screen.getByRole("switch", { name: "a@x.io can edit" }))

		const blockOther: HTMLButtonElement = screen.getByRole("button", { name: "Block b@x.io" })

		expect(blockOther.disabled).toBe(true)

		fireEvent.click(blockOther)

		expect(blockContactByEmail).not.toHaveBeenCalled()

		await act(async () => {
			finish({ status: "success" })
			await Promise.resolve()
		})

		expect(blockOther.disabled).toBe(false)
	})
})
