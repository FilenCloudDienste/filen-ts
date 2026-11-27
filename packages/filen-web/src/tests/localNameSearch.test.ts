import { describe, expect, it } from "vitest"
import type { ChatParticipant, Dir, DirPublicLink, LinkedDirsAndFiles, LinkedRootDir } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { filterDriveItemsByLocalSearch } from "@/features/drive/components/directoryListing.logic"
import { linkedItemName } from "@/features/publicLinks/lib/browse.logic"
import { createLinkedSearch } from "@/workers/linkedSearch"
import { filterContactsBySearch } from "@/features/contacts/components/contactsList.logic"
import { filterNotesBySearch } from "@/features/notes/lib/sort"
import { filterMentionParticipants } from "@/features/chats/lib/composer.logic"
import { buildNotesByTag, filterTagsForView } from "@/features/notes/components/notesSidebar.logic"
import { testUuid } from "@/tests/support/uuid"
import { mockNote, mockNoteTag } from "@/tests/fixtures/notes"
import { mockChatParticipant } from "@/tests/fixtures/sdk"
import { nameSearchKey } from "@filen/shared"

// A name uploaded from macOS arrives decomposed; the query is typed composed (and the reverse).
const NFC_NAME = "Übersicht"
const NFD_NAME = NFC_NAME.normalize("NFD")

function dirNamed(id: string, name: string): Dir {
	return {
		uuid: testUuid(id),
		parent: testUuid("parent"),
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}
}

describe("local name search across Unicode compositions", () => {
	it("fixture names differ only in composition", () => {
		expect(NFD_NAME).not.toBe(NFC_NAME)
		expect(NFD_NAME.normalize("NFC")).toBe(NFC_NAME)
	})

	it("filterDriveItemsByLocalSearch matches an NFD name with an NFC query and the reverse", () => {
		const decomposed = narrowItem(dirNamed("nfd", NFD_NAME))
		const composed = narrowItem(dirNamed("nfc", NFC_NAME))
		const other = narrowItem(dirNamed("other", "Reports"))

		expect(filterDriveItemsByLocalSearch([decomposed, other], "übers")).toEqual([decomposed])
		expect(filterDriveItemsByLocalSearch([composed, other], "ÜBERS".normalize("NFD"))).toEqual([composed])
	})

	it("a directory link's search matches an NFD name with an NFC query", async () => {
		const listing: LinkedDirsAndFiles = {
			dirs: [
				{ inner: { ...dirNamed("link-nfd", NFD_NAME) }, linkedTag: true },
				{ inner: { ...dirNamed("link-other", "Reports") }, linkedTag: true }
			],
			files: []
		}
		const root = { inner: { uuid: testUuid("parent") } } as LinkedRootDir
		const link = { linkUuid: testUuid("link"), linkKey: "k", password: { type: "none" } } as DirPublicLink
		const search = createLinkedSearch(() => Promise.resolve(listing))

		await search.open(root, link, () => undefined)

		const result = search.range({ dirUuid: root.inner.uuid, link, name: "Übersicht", sort: "nameAsc", start: 0, end: 10 })

		expect(result.hits.map(hit => linkedItemName(hit.item))).toEqual([NFD_NAME])
	})

	it("filterContactsBySearch matches a decomposed nickname with a composed query", () => {
		const contact = { email: "a@example.com", nickName: NFD_NAME }

		expect(filterContactsBySearch([contact, { email: "b@example.com" }], "übersicht")).toEqual([contact])
	})

	it("filterNotesBySearch matches a decomposed title with a composed query", () => {
		const note = mockNote({ uuid: testUuid("note-nfd"), title: NFD_NAME, preview: "" })
		const other = mockNote({ uuid: testUuid("note-other"), title: "Groceries", preview: "" })

		expect(filterNotesBySearch([note, other], "übers")).toEqual([note])
	})

	it("filterNotesBySearch matches a folded NFD body with an NFC query, agreeing with the preview fallback", () => {
		const body = `Meeting notes: ${NFD_NAME} for Q3`
		const note = mockNote({ uuid: testUuid("note-body"), title: "Untitled", preview: body })
		const other = mockNote({ uuid: testUuid("note-body-other"), title: "Groceries", preview: "" })
		const loaded = new Map([[note.uuid, nameSearchKey(body)]])

		expect(filterNotesBySearch([note, other], "übersicht", loaded)).toEqual([note])
		expect(filterNotesBySearch([note, other], "übersicht")).toEqual([note])
	})

	it("filterMentionParticipants matches a decomposed nickname with a decomposed or composed query", () => {
		const participant = mockChatParticipant({ userId: 1n, email: "a@example.com", nickName: NFD_NAME })
		const other: ChatParticipant = { ...participant, userId: 2n, email: "b@example.com", nickName: "Reports" }

		expect(filterMentionParticipants([participant, other], "übers".normalize("NFD"), undefined)).toEqual([participant])
		expect(filterMentionParticipants([participant, other], "übers", undefined)).toEqual([participant])
	})

	it("filterTagsForView matches a decomposed tag name with a composed query and the reverse", () => {
		const decomposed = mockNoteTag({ uuid: testUuid("tag-nfd"), name: NFD_NAME })
		const composed = mockNoteTag({ uuid: testUuid("tag-nfc"), name: NFC_NAME })
		const other = mockNoteTag({ uuid: testUuid("tag-other"), name: "Reports" })
		const notesByTag = buildNotesByTag([])

		expect(filterTagsForView([decomposed, other], notesByTag, "übers").map(tag => tag.uuid)).toEqual([decomposed.uuid])
		expect(filterTagsForView([composed, other], notesByTag, "übers".normalize("NFD")).map(tag => tag.uuid)).toEqual([composed.uuid])
	})
})
