import { describe, it, expect, vi } from "vitest"

// notes/utils.ts imports the NoteType enum (a runtime value) from @filen/sdk-rs; mock it.
// Note is a type-only import (erased at runtime).
vi.mock("@filen/sdk-rs", () => ({
	NoteType: {
		Text: 0,
		Md: 1,
		Code: 2,
		Rich: 3,
		Checklist: 4
	}
}))

import { filterNotesByBlockedOwner } from "@/features/notes/utils"
import { deriveBlockedUsers } from "@/features/contacts/blockedSelectors"
import { type Note } from "@/types"

const blocked = deriveBlockedUsers([{ uuid: "x", userId: 99n, email: "b@x.com", avatar: undefined, nickName: "B", timestamp: 0n }] as never)

function note(ownerId: bigint, uuid: string): Note {
	return { uuid, ownerId, participants: [] } as unknown as Note
}

describe("filterNotesByBlockedOwner", () => {
	it("drops notes owned by a blocked user", () => {
		const result = filterNotesByBlockedOwner([note(99n, "a"), note(5n, "b")], blocked)

		expect(result.map(n => n.uuid)).toEqual(["b"])
	})

	it("keeps your own notes even if a participant is blocked", () => {
		const result = filterNotesByBlockedOwner([note(1n, "mine")], blocked)

		expect(result.map(n => n.uuid)).toEqual(["mine"])
	})
})
