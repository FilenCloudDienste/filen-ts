import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import { MailOpenIcon, Volume2Icon, VolumeOffIcon, Trash2Icon, LogOutIcon } from "lucide-react"

// chatsBulkActionBar.logic.ts's own imports are all pure/type-only, but resolving its module path
// still resolves selectionFlags.ts's — mirrors notesBulkActionBar.test.ts's own mock boundary
// (isChatOwner's sdk/queryClient chain, unresolvable/unwanted under node vitest).
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { chatBulkActions } from "@/features/chats/components/chatsBulkActionBar.logic"
import { type ChatSelectionFlags } from "@/features/chats/lib/selectionFlags"

function flags(overrides: Partial<ChatSelectionFlags> = {}): ChatSelectionFlags {
	return {
		count: 2,
		includesMuted: false,
		includesUndecryptable: false,
		includesUnread: false,
		everyOwned: false,
		noneOwned: false,
		...overrides
	}
}

function ids(descriptors: ReturnType<typeof chatBulkActions>): string[] {
	return descriptors.map(d => d.id)
}

describe("chatBulkActions — undecryptable gate", () => {
	it("suppresses markRead/mute when the selection includes an undecryptable chat", () => {
		const descriptors = chatBulkActions(flags({ includesUndecryptable: true, includesUnread: true }))

		expect(ids(descriptors)).not.toEqual(expect.arrayContaining(["markRead", "mute"]))
	})

	it("still offers mute when nothing is undecryptable", () => {
		const descriptors = chatBulkActions(flags({ includesUndecryptable: false }))

		expect(ids(descriptors)).toContain("mute")
	})

	it("delete/leave survive includesUndecryptable — pure-uuid dispositions", () => {
		const deletable = chatBulkActions(flags({ includesUndecryptable: true, everyOwned: true }))
		const leavable = chatBulkActions(flags({ includesUndecryptable: true, noneOwned: true }))

		expect(ids(deletable)).toContain("delete")
		expect(ids(leavable)).toContain("leave")
	})
})

describe("chatBulkActions — markRead gate", () => {
	it("appears only when includesUnread is true", () => {
		const withUnread = chatBulkActions(flags({ includesUnread: true }))
		const withoutUnread = chatBulkActions(flags({ includesUnread: false }))

		expect(ids(withUnread)).toContain("markRead")
		expect(ids(withoutUnread)).not.toContain("markRead")
	})

	it("markRead runs directly and carries its expected label/icon", () => {
		const descriptor = chatBulkActions(flags({ includesUnread: true })).find(d => d.id === "markRead")

		expect(descriptor).toMatchObject({ run: "direct", labelKey: "chatActionMarkRead", icon: MailOpenIcon })
	})
})

describe("chatBulkActions — mute SET-semantics label", () => {
	it("labels Mute (not Unmute) when nothing in the selection is muted", () => {
		const descriptor = chatBulkActions(flags({ includesMuted: false })).find(d => d.id === "mute")

		expect(descriptor).toMatchObject({ labelKey: "chatActionMute", icon: VolumeOffIcon, run: "direct" })
	})

	it("labels Unmute when ANY selected chat is already muted", () => {
		const descriptor = chatBulkActions(flags({ includesMuted: true })).find(d => d.id === "mute")

		expect(descriptor).toMatchObject({ labelKey: "chatActionUnmute", icon: Volume2Icon })
	})
})

describe("chatBulkActions — delete (owner gate)", () => {
	it("appears only when everyOwned is true, dispatches deleteSelected, destructive-styled", () => {
		const eligible = chatBulkActions(flags({ everyOwned: true })).find(d => d.id === "delete")
		const absent = chatBulkActions(flags({ everyOwned: false }))

		expect(eligible).toMatchObject({ run: "dialog", dialogKind: "deleteSelected", destructive: true, icon: Trash2Icon })
		expect(ids(absent)).not.toContain("delete")
	})
})

describe("chatBulkActions — leave (non-owner gate)", () => {
	it("appears only when noneOwned is true, dispatches leaveSelected, destructive-styled", () => {
		const eligible = chatBulkActions(flags({ noneOwned: true })).find(d => d.id === "leave")
		const absent = chatBulkActions(flags({ noneOwned: false }))

		expect(eligible).toMatchObject({ run: "dialog", dialogKind: "leaveSelected", destructive: true, icon: LogOutIcon })
		expect(ids(absent)).not.toContain("leave")
	})
})

describe("chatBulkActions — everyOwned/noneOwned are independent of the undecryptable/unread gates", () => {
	it("a mixed selection can offer delete/leave-adjacent-free markRead+mute alongside neither lifecycle action", () => {
		const descriptors = chatBulkActions(flags({ includesUnread: true, everyOwned: false, noneOwned: false }))

		expect(ids(descriptors)).toEqual(["markRead", "mute"])
	})
})

describe("chatBulkActions — returns a fresh array each call", () => {
	it("callers may safely treat the result as their own", () => {
		const first = chatBulkActions(flags({ everyOwned: true }))
		const second = chatBulkActions(flags({ everyOwned: true }))

		expect(first).not.toBe(second)
		expect(first).toEqual(second)
	})
})
