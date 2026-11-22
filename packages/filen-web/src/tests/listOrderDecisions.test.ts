import { describe, expect, it } from "vitest"
import type { FileVersion, UserAccountSubs, UserAccountSubsInvoices } from "@filen/sdk-rs"
import { chatInfoParticipantRows } from "@/features/chats/components/chatInfoPanel.logic"
import { participantRows } from "@/features/notes/components/noteParticipantsPanel.logic"
import { compareTagsByName } from "@/features/notes/lib/sort"
import { compareInvoicesNewestFirst, compareSubsNewestFirst } from "@/queries/account"
import { compareVersionsNewestFirst } from "@/features/drive/queries/drive"
import { byTitleName } from "@/features/videos/lib/homeRows.logic"
import type { VideoTitleView } from "@/workers/videoIndex/view.logic"
import { mockChat, mockChatParticipant } from "@/tests/fixtures/sdk"
import { mockNote, mockNoteParticipant, mockNoteTag } from "@/tests/fixtures/notes"
import { testUuid } from "@/tests/support/uuid"

// Each order is checked from two input orders: the result must not depend on the one the server sent.
function bothWays<T, R>(items: readonly T[], order: (items: readonly T[]) => readonly R[]): [readonly R[], readonly R[]] {
	return [order(items), order(items.toReversed())]
}

describe("chat info participants", () => {
	it("lists the viewer, the owner, then everyone else by name and user id", () => {
		const self = mockChatParticipant({ userId: 1n, email: "me@example.com", nickName: "" })
		const owner = mockChatParticipant({ userId: 2n, email: "owner@example.com", nickName: "" })
		const zed = mockChatParticipant({ userId: 3n, email: "zed@example.com", nickName: "" })
		const ann10 = mockChatParticipant({ userId: 4n, email: "x@example.com", nickName: "Ann 10" })
		const ann2 = mockChatParticipant({ userId: 5n, email: "y@example.com", nickName: "ann 2" })
		const twinA = mockChatParticipant({ userId: 7n, email: "t1@example.com", nickName: "Twin" })
		const twinB = mockChatParticipant({ userId: 6n, email: "t2@example.com", nickName: "twin" })
		const expected = [1n, 2n, 5n, 4n, 6n, 7n, 3n]

		for (const rows of bothWays([zed, twinA, ann10, owner, self, twinB, ann2], participants =>
			chatInfoParticipantRows(mockChat({ ownerId: 2n, participants: [...participants] }), 1n)
		)) {
			expect(rows.map(row => row.participant.userId)).toEqual(expected)
		}
	})
})

describe("note participants", () => {
	it("lists the viewer, the owner, then everyone else by name and user id", () => {
		const owner = mockNoteParticipant({ userId: 2n, isOwner: true, nickName: "Zoe" })
		const bob = mockNoteParticipant({ userId: 3n, nickName: "bob" })
		const amy = mockNoteParticipant({ userId: 4n, nickName: "Amy" })
		const amyTwin = mockNoteParticipant({ userId: 5n, nickName: "amy" })
		const self = mockNoteParticipant({ userId: 1n, nickName: "Zz" })

		for (const rows of bothWays([bob, amyTwin, self, owner, amy], participants =>
			participantRows(mockNote({ participants: [...participants] }), 1n, false)
		)) {
			expect(rows.map(row => row.participant.userId)).toEqual([1n, 2n, 4n, 5n, 3n])
		}
	})
})

describe("note tag lists", () => {
	it("order by display name, then uuid", () => {
		const b = mockNoteTag({ uuid: testUuid("b"), name: "Work" })
		const a = mockNoteTag({ uuid: testUuid("a"), name: "Work" })
		const home = mockNoteTag({ uuid: testUuid("c"), name: "home" })

		for (const tags of bothWays([b, home, a], tags => tags.toSorted(compareTagsByName))) {
			expect(tags.map(tag => tag.uuid)).toEqual([home.uuid, a.uuid, b.uuid])
		}
	})
})

describe("billing lists", () => {
	it("list subscriptions newest first, then by id, an unrecorded start last", () => {
		const subs = [
			{ id: "b", startTimestamp: 5n },
			{ id: "none", startTimestamp: undefined },
			{ id: "a", startTimestamp: 5n },
			{ id: "new", startTimestamp: 9n }
		] as UserAccountSubs[]

		for (const sorted of bothWays(subs, list => list.toSorted(compareSubsNewestFirst))) {
			expect(sorted.map(sub => sub.id)).toEqual(["new", "a", "b", "none"])
		}
	})

	it("list invoices newest first, then by id", () => {
		const invoices = [
			{ id: "b", timestamp: 5n },
			{ id: "old", timestamp: 0n },
			{ id: "a", timestamp: 5n }
		] as UserAccountSubsInvoices[]

		for (const sorted of bothWays(invoices, list => list.toSorted(compareInvoicesNewestFirst))) {
			expect(sorted.map(invoice => invoice.id)).toEqual(["a", "b", "old"])
		}
	})
})

describe("file versions", () => {
	it("list newest first, then by uuid", () => {
		const versions = [
			{ uuid: "b", timestamp: 5n },
			{ uuid: "old", timestamp: 1n },
			{ uuid: "a", timestamp: 5n }
		] as unknown as FileVersion[]

		for (const sorted of bothWays(versions, list => list.toSorted(compareVersionsNewestFirst))) {
			expect(sorted.map(version => version.uuid)).toEqual(["a", "b", "old"])
		}
	})
})

describe("video title order", () => {
	it("is the drive's natural name order, then year, then id", () => {
		const titles = [
			{ id: "b", sortName: "Movie 10", year: 0 },
			{ id: "c", sortName: "movie 2", year: 2001 },
			{ id: "a", sortName: "Movie 2", year: 2001 },
			{ id: "d", sortName: "movie 2", year: 1990 }
		] as VideoTitleView[]

		for (const sorted of bothWays(titles, list => list.toSorted(byTitleName))) {
			expect(sorted.map(title => title.id)).toEqual(["d", "a", "c", "b"])
		}
	})
})
