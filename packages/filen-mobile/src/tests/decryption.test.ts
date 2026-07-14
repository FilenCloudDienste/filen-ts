import { describe, it, expect } from "vitest"
import {
	cannotDecryptPlaceholder,
	isDriveItemUndecryptable,
	isNoteUndecryptable,
	isChatUndecryptable,
	isMessageUndecryptable,
	isTagUndecryptable,
	driveItemDisplayName,
	noteDisplayTitle,
	chatDisplayName,
	messageDisplayBody,
	tagDisplayName
} from "@/lib/decryption"
import { type DriveItem, type Note, type Chat, type ChatMessage, type NoteTag } from "@/types"
import { type ChatParticipant } from "@filen/sdk-rs"

function driveFile(uuid: string, undecryptable: boolean, name?: string | null): DriveItem {
	return {
		type: "file",
		data: {
			uuid,
			undecryptable,
			decryptedMeta: name === undefined ? null : name === null ? null : ({ name } as DriveItem["data"]["decryptedMeta"])
		} as DriveItem["data"]
	} as DriveItem
}

function driveDirectory(uuid: string, undecryptable: boolean, name?: string | null): DriveItem {
	return {
		type: "directory",
		data: {
			uuid,
			undecryptable,
			decryptedMeta: name === undefined ? null : name === null ? null : ({ name } as DriveItem["data"]["decryptedMeta"])
		} as DriveItem["data"]
	} as DriveItem
}

function note(uuid: string, undecryptable: boolean, title?: string): Note {
	return {
		uuid,
		undecryptable,
		title
	} as Note
}

function tag(uuid: string, undecryptable: boolean, name?: string): NoteTag {
	return {
		uuid,
		undecryptable,
		name
	} as NoteTag
}

function participant(userId: bigint, email: string, nickName?: string): ChatParticipant {
	return {
		userId,
		email,
		nickName
	} as ChatParticipant
}

function chat(
	uuid: string,
	undecryptable: boolean,
	{ name, participants = [] }: { name?: string; participants?: ChatParticipant[] } = {}
): Chat {
	return {
		uuid,
		undecryptable,
		name,
		participants
	} as Chat
}

function message(uuid: string, undecryptable: boolean, body?: string): ChatMessage {
	return {
		undecryptable,
		inner: {
			uuid,
			message: body
		}
	} as ChatMessage
}

describe("cannotDecryptPlaceholder", () => {
	it("returns the snake_case placeholder for a given uuid", () => {
		expect(cannotDecryptPlaceholder("abc")).toBe("cannot_decrypt_abc")
	})
})

describe("isDriveItemUndecryptable", () => {
	it("returns true when item.data.undecryptable is true", () => {
		expect(isDriveItemUndecryptable(driveFile("a", true))).toBe(true)
	})

	it("returns false when item.data.undecryptable is false", () => {
		expect(isDriveItemUndecryptable(driveFile("a", false, "file.txt"))).toBe(false)
	})
})

describe("isNoteUndecryptable", () => {
	it("returns true when note.undecryptable is true", () => {
		expect(isNoteUndecryptable(note("n", true))).toBe(true)
	})

	it("returns false when note.undecryptable is false", () => {
		expect(isNoteUndecryptable(note("n", false, "Note"))).toBe(false)
	})
})

describe("isChatUndecryptable", () => {
	it("returns true when chat.undecryptable is true", () => {
		expect(isChatUndecryptable(chat("c", true))).toBe(true)
	})

	it("returns false when chat.undecryptable is false", () => {
		expect(isChatUndecryptable(chat("c", false))).toBe(false)
	})
})

describe("isMessageUndecryptable", () => {
	it("returns true when message.undecryptable is true", () => {
		expect(isMessageUndecryptable(message("m", true))).toBe(true)
	})

	it("returns false when message.undecryptable is false", () => {
		expect(isMessageUndecryptable(message("m", false, "hi"))).toBe(false)
	})
})

describe("isTagUndecryptable", () => {
	it("returns true when tag.undecryptable is true", () => {
		expect(isTagUndecryptable(tag("t", true))).toBe(true)
	})

	it("returns false when tag.undecryptable is false", () => {
		expect(isTagUndecryptable(tag("t", false, "Work"))).toBe(false)
	})
})

describe("driveItemDisplayName", () => {
	it("returns the placeholder when item is undecryptable", () => {
		expect(driveItemDisplayName(driveFile("u1", true))).toBe("cannot_decrypt_u1")
	})

	it("returns the decrypted name when item is decryptable", () => {
		expect(driveItemDisplayName(driveFile("u1", false, "report.pdf"))).toBe("report.pdf")
	})

	it("falls back to uuid when decryptedMeta is null but item is decryptable", () => {
		expect(driveItemDisplayName(driveFile("u1", false))).toBe("u1")
	})

	it("returns the decrypted name for a directory-type item", () => {
		expect(driveItemDisplayName(driveDirectory("d1", false, "Documents"))).toBe("Documents")
	})

	it("returns empty string (not uuid) when decryptedMeta.name is the empty string", () => {
		expect(driveItemDisplayName(driveFile("u1", false, ""))).toBe("")
	})
})

describe("noteDisplayTitle", () => {
	it("returns the placeholder when note is undecryptable", () => {
		expect(noteDisplayTitle(note("u1", true))).toBe("cannot_decrypt_u1")
	})

	it("returns the title when note is decryptable", () => {
		expect(noteDisplayTitle(note("u1", false, "My note"))).toBe("My note")
	})

	it("falls back to uuid when title is undefined but note is decryptable", () => {
		expect(noteDisplayTitle(note("u1", false))).toBe("u1")
	})

	it("returns empty string (not uuid) when title is the empty string", () => {
		expect(noteDisplayTitle(note("u1", false, ""))).toBe("")
	})
})

describe("tagDisplayName", () => {
	it("returns the placeholder when tag is undecryptable", () => {
		expect(tagDisplayName(tag("t1", true))).toBe("cannot_decrypt_t1")
	})

	it("returns the tag name when tag is decryptable", () => {
		expect(tagDisplayName(tag("t1", false, "Work"))).toBe("Work")
	})

	it("falls back to uuid when name is undefined but tag is decryptable", () => {
		expect(tagDisplayName(tag("t1", false))).toBe("t1")
	})

	it("returns empty string (not uuid) when name is the empty string", () => {
		expect(tagDisplayName(tag("t1", false, ""))).toBe("")
	})
})

describe("messageDisplayBody", () => {
	it("returns the placeholder when message is undecryptable", () => {
		expect(messageDisplayBody(message("m1", true))).toBe("cannot_decrypt_m1")
	})

	it("returns the message body when decryptable", () => {
		expect(messageDisplayBody(message("m1", false, "hello"))).toBe("hello")
	})

	it("returns empty string when message is undefined but decryptable", () => {
		expect(messageDisplayBody(message("m1", false))).toBe("")
	})

	it("returns empty string when message body is explicitly the empty string", () => {
		expect(messageDisplayBody(message("m1", false, ""))).toBe("")
	})
})

describe("chatDisplayName", () => {
	const ME = 1n
	const OTHER_A = 2n
	const OTHER_B = 3n
	const SOLO = "Just you"

	it("returns the placeholder when chat is undecryptable", () => {
		expect(chatDisplayName(chat("c1", true), ME, SOLO)).toBe("cannot_decrypt_c1")
	})

	it("uses chat.name when present and non-empty", () => {
		expect(
			chatDisplayName(
				chat("c1", false, {
					name: "Friends",
					participants: [participant(ME, "me@x.com"), participant(OTHER_A, "a@x.com", "Ann")]
				}),
				ME,
				SOLO
			)
		).toBe("Friends")
	})

	it("ignores empty chat.name and falls back to participants", () => {
		expect(
			chatDisplayName(
				chat("c1", false, {
					name: "",
					participants: [participant(ME, "me@x.com"), participant(OTHER_A, "a@x.com", "Ann")]
				}),
				ME,
				SOLO
			)
		).toBe("Ann")
	})

	it("1:1 fallback uses the other participant's nickName when present", () => {
		expect(
			chatDisplayName(
				chat("c1", false, {
					participants: [participant(ME, "me@x.com"), participant(OTHER_A, "a@x.com", "Ann")]
				}),
				ME,
				SOLO
			)
		).toBe("Ann")
	})

	it("1:1 fallback uses the other participant's email when no nickName", () => {
		expect(
			chatDisplayName(
				chat("c1", false, {
					participants: [participant(ME, "me@x.com"), participant(OTHER_A, "a@x.com")]
				}),
				ME,
				SOLO
			)
		).toBe("a@x.com")
	})

	it("1:1 fallback ignores an empty nickName and uses email", () => {
		expect(
			chatDisplayName(
				chat("c1", false, {
					participants: [participant(ME, "me@x.com"), participant(OTHER_A, "a@x.com", "")]
				}),
				ME,
				SOLO
			)
		).toBe("a@x.com")
	})

	it("multi-party fallback joins names with comma", () => {
		expect(
			chatDisplayName(
				chat("c1", false, {
					participants: [participant(ME, "me@x.com"), participant(OTHER_A, "a@x.com", "Ann"), participant(OTHER_B, "b@x.com")]
				}),
				ME,
				SOLO
			)
		).toBe("Ann, b@x.com")
	})

	it("bigint userId comparison filters self out correctly", () => {
		expect(
			chatDisplayName(
				chat("c1", false, {
					participants: [participant(ME, "me@x.com", "Me"), participant(OTHER_A, "a@x.com", "Ann")]
				}),
				ME,
				SOLO
			)
		).toBe("Ann")
	})

	it("multi-party fallback sorts display names regardless of participant order", () => {
		expect(
			chatDisplayName(
				chat("c1", false, {
					participants: [participant(ME, "me@x.com"), participant(OTHER_B, "b@x.com"), participant(OTHER_A, "a@x.com", "Ann")]
				}),
				ME,
				SOLO
			)
		).toBe("Ann, b@x.com")
	})

	it("returns the solo fallback when every other participant left (only self remains)", () => {
		expect(
			chatDisplayName(
				chat("c1", false, {
					participants: [participant(ME, "me@x.com")]
				}),
				ME,
				SOLO
			)
		).toBe(SOLO)
	})

	it("returns the solo fallback when the participants array is completely empty", () => {
		expect(chatDisplayName(chat("c1", false, { participants: [] }), ME, SOLO)).toBe(SOLO)
	})

	it("a custom chat name wins over the solo fallback", () => {
		expect(
			chatDisplayName(
				chat("c1", false, {
					name: "Friends",
					participants: [participant(ME, "me@x.com")]
				}),
				ME,
				SOLO
			)
		).toBe("Friends")
	})

	it("the undecryptable placeholder wins over the solo fallback", () => {
		expect(chatDisplayName(chat("c1", true, { participants: [] }), ME, SOLO)).toBe("cannot_decrypt_c1")
	})
})
