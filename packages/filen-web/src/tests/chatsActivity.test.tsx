// @vitest-environment jsdom

// The chats' server writes as activity toasts: the chat menu's mark read / mute, the bulk bar's, the bulk
// delete/leave confirms' hand-off and the participants dialog's bulk remove. The writes themselves are
// stubbed; chatsActions/chatsBulk/chatsParticipants tests cover them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { ExternalToast } from "sonner"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"
import { testUuid } from "@/tests/support/uuid"
import { plainErrorDTO } from "@/lib/sdk/errors"
import "@/lib/i18n"

const { toast, actions, bulk, participants, navigate, router } = vi.hoisted(() => ({
	toast: Object.assign(
		vi.fn<(title: string, options?: ExternalToast) => string>(() => "id"),
		{
			success: vi.fn<(title: string, options?: ExternalToast) => string>(),
			error: vi.fn<(title: string, options?: ExternalToast) => string>(),
			warning: vi.fn<(title: string, options?: ExternalToast) => string>(),
			dismiss: vi.fn()
		}
	),
	actions: {
		markChatRead: vi.fn(),
		setChatMuted: vi.fn(),
		renameChat: vi.fn(),
		leaveChat: vi.fn(),
		deleteChat: vi.fn(),
		createChat: vi.fn()
	},
	bulk: { markChatsRead: vi.fn(), setChatsMuted: vi.fn(), deleteChatsPermanently: vi.fn(), leaveChats: vi.fn() },
	participants: { addChatParticipants: vi.fn(), removeChatParticipant: vi.fn(), removeChatParticipants: vi.fn() },
	navigate: vi.fn(() => Promise.resolve()),
	router: { state: { location: { pathname: "/chats" } } }
}))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/features/chats/lib/actions", () => actions)
vi.mock("@/features/chats/lib/bulk", () => bulk)
vi.mock("@/features/chats/lib/participants", () => participants)
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
	useRouter: () => router,
	useRouterState: () => ""
}))
vi.mock("@/queries/account", async importOriginal => ({
	...(await importOriginal<typeof import("@/queries/account")>()),
	useAccountQuery: () => ({ data: { id: 1n } }),
	accountQueryGet: () => ({ id: 1n })
}))
vi.mock("@/features/contacts/queries/contacts", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/contacts/queries/contacts")>()),
	useContactsQuery: () => ({ data: { contacts: [], blocked: [] } })
}))

const { chats } = vi.hoisted(() => ({ chats: { current: [] as Chat[] } }))

vi.mock("@/features/chats/queries/chats", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/chats/queries/chats")>()),
	useChats: () => ({ data: chats.current })
}))

const { ChatDropdownMenuContent } = await import("@/features/chats/components/chatMenu")
const { ChatsBulkActionBar } = await import("@/features/chats/components/chatsBulkActionBar")
const { ChatParticipantsDialog } = await import("@/features/chats/components/chatParticipantsDialog")
const { DropdownMenu, DropdownMenuTrigger } = await import("@/components/ui/dropdown-menu")
const { chatActivityName } = await import("@/features/chats/lib/activity")
const { useChatDialogHost } = await import("@/features/chats/hooks/useChatDialogHost")
const { useChatsSelectionStore } = await import("@/features/chats/store/useChatsSelectionStore")

function participant(userId: bigint, email: string, nickName?: string): ChatParticipant {
	return { userId, email, nickName, permissionsAdd: false, added: 0n, appearOffline: false, lastActive: 0n }
}

const SELF = participant(1n, "me@x.io")
const BOB = participant(2n, "bob@x.io", "Bob")
const CAROL = participant(3n, "carol@x.io")

function chat(overrides: Partial<Chat> = {}): Chat {
	return {
		uuid: testUuid("chat"),
		ownerId: 1n,
		key: "chat-key",
		name: "Team",
		participants: [SELF, BOB],
		muted: false,
		created: 0n,
		lastFocus: 0n,
		...overrides
	}
}

// A message from someone else after the chat was last focused: what makes "Mark as read" appear.
const UNREAD: Partial<Chat> = {
	lastMessage: { sentTimestamp: 10n, senderId: 2, senderEmail: BOB.email } as unknown as NonNullable<Chat["lastMessage"]>
}

beforeEach(() => {
	vi.clearAllMocks()
	router.state.location.pathname = "/chats"
	useChatsSelectionStore.getState().clearSelectedChats()
})

afterEach(() => {
	cleanup()
})

function clickItem(name: string): void {
	fireEvent.click(screen.getByRole("menuitem", { name }))
}

describe("chatActivityName", () => {
	it("names a conversation as its row does", () => {
		expect(chatActivityName(chat())).toBe("Team")
		expect(chatActivityName(chat({ name: "" }))).toBe("Bob")
		expect(chatActivityName(chat({ name: "", participants: [SELF] }))).toBe("Just you")

		// exactOptionalPropertyTypes: an undecryptable chat has no `key` at all, not an undefined one.
		const { uuid, ownerId, participants: members, muted, created, lastFocus } = chat()

		expect(chatActivityName({ uuid, ownerId, participants: members, muted, created, lastFocus })).toBe("Encrypted conversation")
	})
})

describe("chat menu — direct writes as activities", () => {
	function renderMenu(target: Chat): void {
		render(
			createElement(
				DropdownMenu,
				{ defaultOpen: true },
				createElement(DropdownMenuTrigger, null, "menu"),
				createElement(ChatDropdownMenuContent, {
					chat: target,
					currentUserId: 1n,
					blocked: EMPTY_BLOCKED_USERS,
					onAction: () => undefined
				})
			)
		)
	}

	it("marks a conversation read in its own words", async () => {
		const target = chat(UNREAD)
		actions.markChatRead.mockResolvedValue({ status: "success" })
		renderMenu(target)

		clickItem("Mark as read")

		expect(toast.mock.lastCall?.[0]).toBe("Marking Team as read")
		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Marked Team as read", expect.anything())
		})
		expect(actions.markChatRead).toHaveBeenCalledExactlyOnceWith(target)
	})

	it("unmutes a muted conversation and says why it failed, offering to try again", async () => {
		const target = chat({ muted: true })
		actions.setChatMuted.mockResolvedValue({ status: "error", dto: plainErrorDTO("nope") })
		renderMenu(target)

		clickItem("Unmute")

		expect(toast.mock.lastCall?.[0]).toBe("Unmuting Team")
		await vi.waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("Couldn't unmute Team", expect.anything())
		})
		expect(toast.error.mock.lastCall?.[1]?.action).toBeDefined()
		expect(actions.setChatMuted).toHaveBeenCalledExactlyOnceWith(target, false)
	})
})

describe("bulk bar — direct writes as activities", () => {
	const a = chat({ uuid: testUuid("a"), name: "A", ...UNREAD })
	const b = chat({ uuid: testUuid("b"), name: "B", ...UNREAD })

	function renderBar(): void {
		useChatsSelectionStore.getState().setSelectedChats([a, b])
		render(
			createElement(ChatsBulkActionBar, {
				selectedChats: [a, b],
				currentUserId: 1n,
				blocked: EMPTY_BLOCKED_USERS,
				onDialogAction: () => undefined
			})
		)
	}

	it("marks the selection read, counting it, and drops what succeeded from the selection", async () => {
		bulk.markChatsRead.mockResolvedValue({ succeeded: [a], failed: [{ item: b, error: plainErrorDTO("nope") }] })
		renderBar()

		fireEvent.click(screen.getByRole("button", { name: "Mark as read" }))

		expect(toast.mock.lastCall?.[0]).toBe("Marking 2 conversations as read")
		await vi.waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("Marked 1 conversation as read, 1 failed", expect.anything())
		})
		expect(useChatsSelectionStore.getState().selectedChats).toEqual([b])
	})

	it("mutes the whole selection to one value", async () => {
		bulk.setChatsMuted.mockResolvedValue({ succeeded: [a, b], failed: [] })
		renderBar()

		fireEvent.click(screen.getByRole("button", { name: "Mute" }))

		expect(toast.mock.lastCall?.[0]).toBe("Muting 2 conversations")
		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Muted 2 conversations", expect.anything())
		})
		expect(bulk.setChatsMuted).toHaveBeenCalledExactlyOnceWith([a, b], true, expect.any(Function))
	})
})

describe("bulk delete confirm", () => {
	function Host({ targets }: { targets: Chat[] }): ReactNode {
		const host = useChatDialogHost()

		return createElement(
			"div",
			null,
			createElement(
				"button",
				{
					type: "button",
					onClick: () => {
						host.openBulkDialog("deleteSelected", targets)
					}
				},
				"open"
			),
			host.renderActiveDialog()
		)
	}

	it("closes at once, hands several to the activity toast and leaves the conversation open at settle time", async () => {
		const a = chat({ uuid: testUuid("a"), name: "A" })
		const b = chat({ uuid: testUuid("b"), name: "B" })
		const { promise, resolve } = Promise.withResolvers<undefined>()
		bulk.deleteChatsPermanently.mockImplementation(async (targets: Chat[], opts: { beforeCacheRemoval: (target: Chat) => void }) => {
			await promise

			for (const target of targets) {
				opts.beforeCacheRemoval(target)
			}

			return { succeeded: targets, failed: [] }
		})
		render(createElement(Host, { targets: [a, b] }))

		fireEvent.click(screen.getByText("open"))
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))

		expect(screen.queryByRole("alertdialog")).toBeNull()
		expect(toast.mock.lastCall?.[0]).toBe("Deleting 2 conversations")

		// Opened after the confirm: still navigated away from, as the route is read when it settles.
		router.state.location.pathname = `/chats/${b.uuid}`

		await act(async () => {
			resolve(undefined)
			await promise
		})

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Deleted 2 conversations", expect.anything())
		})
		expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: "/chats" })
	})

	it("keeps the dialog's spinner for one conversation, then shows only the result", async () => {
		const a = chat({ uuid: testUuid("a"), name: "A" })
		bulk.deleteChatsPermanently.mockResolvedValue({ succeeded: [a], failed: [] })
		render(createElement(Host, { targets: [a] }))

		fireEvent.click(screen.getByText("open"))
		fireEvent.click(screen.getByRole("button", { name: "Delete" }))

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Deleted A", expect.anything())
		})
		expect(toast).not.toHaveBeenCalled()
	})
})

describe("participants dialog — bulk remove", () => {
	function renderDialog(target: Chat): void {
		chats.current = [target]
		render(createElement(ChatParticipantsDialog, { chat: target, onClose: () => undefined }))
	}

	function confirmRemove(count: number): void {
		fireEvent.click(screen.getByRole("button", { name: count === 1 ? "Remove 1 participant" : `Remove ${String(count)} participants` }))
		fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove" }))
	}

	it("closes the confirm at once and hands several to the activity toast, keeping a failed one selected", async () => {
		const target = chat({ participants: [SELF, BOB, CAROL] })
		participants.removeChatParticipants.mockResolvedValue({
			chat: target,
			outcome: { succeeded: [BOB], failed: [{ item: CAROL, error: plainErrorDTO("nope") }] }
		})
		renderDialog(target)

		fireEvent.click(screen.getByRole("option", { name: /Bob/ }))
		fireEvent.click(screen.getByRole("option", { name: /carol@x\.io/ }))
		confirmRemove(2)

		expect(screen.queryByRole("alertdialog")).toBeNull()
		expect(toast.mock.lastCall?.[0]).toBe("Removing 2 participants")

		await vi.waitFor(() => {
			expect(toast.error).toHaveBeenCalledWith("Removed 1 participant, 1 failed", expect.anything())
		})
		expect(participants.removeChatParticipants).toHaveBeenCalledExactlyOnceWith(target, [BOB, CAROL], expect.any(Function))
		expect(screen.getByRole("option", { name: /carol@x\.io/ }).getAttribute("aria-selected")).toBe("true")
		expect(screen.getByRole("option", { name: /Bob/ }).getAttribute("aria-selected")).toBe("false")
	})

	it("keeps the confirm's spinner for one participant, then shows only the result", async () => {
		const target = chat({ participants: [SELF, BOB, CAROL] })
		participants.removeChatParticipants.mockResolvedValue({ chat: target, outcome: { succeeded: [BOB], failed: [] } })
		renderDialog(target)

		fireEvent.click(screen.getByRole("option", { name: /Bob/ }))
		confirmRemove(1)

		await vi.waitFor(() => {
			expect(toast.success).toHaveBeenCalledWith("Removed Bob", expect.anything())
		})
		expect(toast).not.toHaveBeenCalled()
		expect(screen.queryByRole("alertdialog")).toBeNull()
	})
})
