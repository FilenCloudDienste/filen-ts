// @vitest-environment jsdom

// The chat info panel: opening and closing it beside the thread or as a sheet, what each role sees, the per-row menus,
// the add picker, mute and the Leave/Delete confirms. The writes themselves are stubbed; chatsParticipants and
// chatsActions cover them.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { useState } from "react"
import type { Chat, ChatParticipant } from "@filen/sdk-rs"
import { deriveBlockedUsers, EMPTY_BLOCKED_USERS, type BlockedUsers } from "@filen/shared"
import { testUuid } from "@/tests/support/uuid"
import { mockChat, mockChatParticipant, mockUndecryptableChat } from "@/tests/fixtures/sdk"
import { mockBlockedContact, mockContact } from "@/tests/support/contactFixtures"
import "@/lib/i18n"
import { stubElementSize } from "@/tests/stubElementSize"

const { viewport, online, contacts, participants, block, directActions, actions, navigate, router } = vi.hoisted(() => ({
	viewport: { wide: true },
	online: { current: true },
	contacts: { data: { contacts: [] as unknown[], blocked: [] as unknown[] } },
	participants: { addChatParticipants: vi.fn(), removeChatParticipant: vi.fn() },
	block: { toggleParticipantBlocked: vi.fn() },
	directActions: { runSetChatMuted: vi.fn(), runMarkChatRead: vi.fn() },
	actions: { renameChat: vi.fn(), leaveChat: vi.fn(), deleteChat: vi.fn() },
	navigate: vi.fn(() => Promise.resolve()),
	router: { state: { location: { pathname: "/chats" } } }
}))

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }) }))
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})
vi.mock("@/features/shell/lib/sidePanelLayout", () => ({
	isSidePanelNarrow: () => !viewport.wide,
	subscribeToSidePanelBreakpoint: () => () => undefined,
	useIsSidePanelNarrow: () => !viewport.wide
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.current }))
vi.mock("@/features/contacts/queries/contacts", () => ({ useContactsQuery: () => ({ status: "success", ...contacts }) }))
vi.mock("@/features/chats/lib/participants", () => participants)
vi.mock("@/features/contacts/lib/actions", () => block)
vi.mock("@/features/chats/lib/directActions", () => directActions)
vi.mock("@/features/chats/lib/actions", () => actions)
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate, useRouter: () => router, useRouterState: () => "" }))

const { ChatInfoHost, ChatInfoToggle } = await import("@/features/chats/components/chatInfoPanel")
const { registerAllActions } = await import("@/lib/keymap/actions")
const { openChatInfo, useChatInfoStore } = await import("@/features/chats/store/useChatInfoStore")
const { SidePanelSlotContext } = await import("@/features/shell/lib/sidePanelSlot")

function participant(userId: bigint, email: string, nickName?: string): ChatParticipant {
	return mockChatParticipant({ userId, email, nickName })
}

const SELF = participant(1n, "me@x.io", "Me")
const BOB = participant(2n, "bob@x.io", "Bob")
const CAROL = participant(3n, "carol@x.io", "Carol")

function chat(overrides: Partial<Chat> = {}): Chat {
	return mockChat({ name: "Design team", participants: [BOB, SELF, CAROL], ...overrides })
}

// The thread's header toggle and its host, with the shell's side-panel slot beside them.
function Thread({ target, blocked }: { target: Chat; blocked: BlockedUsers }) {
	const [slot, setSlot] = useState<HTMLDivElement | null>(null)

	return (
		<SidePanelSlotContext value={slot}>
			<ChatInfoToggle chat={target} />
			<ChatInfoHost
				chat={target}
				currentUserId={1n}
				blocked={blocked}
			/>
			<div ref={setSlot} />
		</SidePanelSlotContext>
	)
}

function renderThread(target: Chat = chat(), blocked: BlockedUsers = EMPTY_BLOCKED_USERS) {
	return render(
		<Thread
			target={target}
			blocked={blocked}
		/>
	)
}

function openPanel(): HTMLElement {
	fireEvent.click(screen.getByRole("button", { name: "Participants" }))

	return screen.getByRole("complementary", { name: "Chat info" })
}

// The contact picker is virtualized: jsdom lays nothing out, so it gets a box to window over.
let restoreSize: () => void = () => undefined

beforeAll(() => {
	// The toggle's tooltip names its action's keys.
	registerAllActions()
	restoreSize = stubElementSize({ clientHeight: 400, clientWidth: 400 })
})

afterAll(() => {
	restoreSize()
})

beforeEach(() => {
	vi.clearAllMocks()
	viewport.wide = true
	online.current = true
	contacts.data = { contacts: [], blocked: [] }
	useChatInfoStore.setState({ panelOpen: false, drawerKey: null, focusRequestedFor: null })
})

afterEach(() => {
	cleanup()
})

describe("chat info panel — beside the thread", () => {
	it("mounts nothing until opened, then takes focus and reports itself expanded", () => {
		renderThread()

		expect(screen.queryByRole("complementary")).toBeNull()

		const panel = openPanel()

		expect(document.activeElement).toBe(panel)
		expect(screen.getByRole("button", { name: "Participants" }).getAttribute("aria-expanded")).toBe("true")
	})

	it("stays open for the next conversation in the session, without taking focus again", () => {
		const { rerender } = renderThread()
		const toggle = screen.getByRole("button", { name: "Participants" })

		openPanel()
		toggle.focus()
		rerender(
			<Thread
				target={chat({ uuid: testUuid("other"), name: "Other" })}
				blocked={EMPTY_BLOCKED_USERS}
			/>
		)

		expect(within(screen.getByRole("complementary", { name: "Chat info" })).getByText("Other")).toBeTruthy()
		expect(document.activeElement).toBe(toggle)
	})

	it("focuses the open panel at once when opened again, arming nothing a later conversation could take", () => {
		const { rerender } = renderThread()
		const toggle = screen.getByRole("button", { name: "Participants" })
		const panel = openPanel()

		toggle.focus()
		// The menu's entry (or its key) on the conversation whose panel is already showing.
		act(() => {
			openChatInfo(testUuid("chat"))
		})

		expect(document.activeElement).toBe(panel)
		expect(useChatInfoStore.getState().focusRequestedFor).toBeNull()

		toggle.focus()
		rerender(
			<Thread
				target={chat({ uuid: testUuid("other"), name: "Other" })}
				blocked={EMPTY_BLOCKED_USERS}
			/>
		)

		expect(document.activeElement).toBe(toggle)
	})

	it("hands focus to the panel of the conversation it was opened for, never to another one's", () => {
		useChatInfoStore.setState({ panelOpen: true })
		const { rerender } = renderThread()
		const toggle = screen.getByRole("button", { name: "Participants" })

		toggle.focus()
		// Opened from another conversation's row: that conversation opens next.
		act(() => {
			openChatInfo(testUuid("other"))
		})
		rerender(
			<Thread
				target={chat({ uuid: testUuid("other"), name: "Other" })}
				blocked={EMPTY_BLOCKED_USERS}
			/>
		)

		expect(document.activeElement).toBe(screen.getByRole("complementary", { name: "Chat info" }))
		expect(useChatInfoStore.getState().focusRequestedFor).toBeNull()
	})

	it("closes on Escape from inside, handing focus back to the toggle", () => {
		renderThread()

		const panel = openPanel()

		fireEvent.keyDown(within(panel).getByRole("switch"), { key: "Escape" })

		expect(screen.queryByRole("complementary")).toBeNull()
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Participants" }))
	})

	it("closes from its close button", () => {
		renderThread()

		fireEvent.click(within(openPanel()).getByRole("button", { name: "Close" }))

		expect(screen.queryByRole("complementary")).toBeNull()
	})

	it("is never offered for an undecryptable conversation", () => {
		useChatInfoStore.setState({ panelOpen: true })
		// No `key` at all: the group key did not decrypt.
		renderThread(mockUndecryptableChat({ participants: [SELF, BOB] }))

		expect(screen.queryByRole("button", { name: "Participants" })).toBeNull()
		expect(screen.queryByRole("complementary")).toBeNull()
	})
})

describe("chat info panel — contents", () => {
	it("shows the name, count and every participant, the viewer first as You, the owner badged, a blocked one marked", () => {
		renderThread(chat(), deriveBlockedUsers([{ userId: 3n, email: CAROL.email }]))

		const panel = openPanel()
		const rows = within(within(panel).getByRole("list", { name: "Participants" })).getAllByRole("listitem")

		expect(within(panel).getByText("Design team")).toBeTruthy()
		expect(within(panel).getByText("3 participants")).toBeTruthy()
		expect(rows.map(row => row.textContent)).toEqual([
			// After each avatar's initial.
			expect.stringMatching(/^MYou.*me@x\.io.*Owner$/),
			expect.stringMatching(/^BBob/),
			expect.stringMatching(/^CCarol · Blocked/)
		])
		// The viewer's own row has no menu.
		expect(
			within(panel)
				.getAllByRole("button", { name: /^Actions for / })
				.map(button => button.getAttribute("aria-label"))
		).toEqual(["Actions for Bob", "Actions for Carol"])
	})

	it("gives the owner rename, add and Delete", () => {
		renderThread()

		const panel = openPanel()

		expect(within(panel).getByRole("button", { name: "Rename" })).toBeTruthy()
		expect(within(panel).getByRole("button", { name: "Add participants" })).toBeTruthy()
		expect(within(panel).getByRole("button", { name: "Delete" })).toBeTruthy()
		expect(within(panel).queryByRole("button", { name: "Leave" })).toBeNull()
	})

	it("gives a participant neither rename nor add, and Leave instead of Delete", () => {
		renderThread(chat({ ownerId: 2n }))

		const panel = openPanel()

		expect(within(panel).queryByRole("button", { name: "Rename" })).toBeNull()
		expect(within(panel).queryByRole("button", { name: "Add participants" })).toBeNull()
		expect(within(panel).getByRole("button", { name: "Leave" })).toBeTruthy()
	})

	it("mutes from its switch", () => {
		const target = chat()

		renderThread(target)
		fireEvent.click(within(openPanel()).getByRole("switch", { name: "Mute notifications" }))

		expect(directActions.runSetChatMuted).toHaveBeenCalledExactlyOnceWith(target, true)
	})

	it("disables every write offline with the offline reason, but still opens", () => {
		online.current = false
		renderThread()

		const panel = openPanel()

		const rename = within(panel).getByRole("button", { name: "Rename" })

		expect(rename.getAttribute("aria-disabled")).toBe("true")
		expect((rename as HTMLButtonElement).disabled).toBe(false)
		expect(rename.getAttribute("title")).toBeNull()
		expect(document.getElementById(rename.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Unavailable while offline")

		for (const control of [
			within(panel).getByRole("button", { name: "Add participants" }),
			within(panel).getByRole("button", { name: "Delete" })
		]) {
			expect((control as HTMLButtonElement).disabled).toBe(true)
			expect(control.getAttribute("title")).toBe("Unavailable while offline")
		}

		fireEvent.click(within(panel).getByRole("switch", { name: "Mute notifications" }))
		expect(directActions.runSetChatMuted).not.toHaveBeenCalled()
	})
})

describe("chat info panel — participant actions", () => {
	it("removes a participant after the confirm (owner)", async () => {
		const target = chat()

		participants.removeChatParticipant.mockResolvedValue({ status: "success", item: target })
		renderThread(target)
		fireEvent.click(within(openPanel()).getByRole("button", { name: "Actions for Bob" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }))
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }))

		await vi.waitFor(() => {
			expect(participants.removeChatParticipant).toHaveBeenCalledExactlyOnceWith(target, BOB)
		})
	})

	it("offers a participant block only, and unblocks a blocked one", async () => {
		const blockedRecord = mockBlockedContact({ userId: 3n, email: CAROL.email })

		contacts.data = { contacts: [], blocked: [blockedRecord] }
		block.toggleParticipantBlocked.mockResolvedValue({ status: "success" })
		renderThread(chat({ ownerId: 2n }), deriveBlockedUsers([blockedRecord]))

		const panel = openPanel()

		fireEvent.click(within(panel).getByRole("button", { name: "Actions for Bob" }))
		expect((await screen.findAllByRole("menuitem")).map(item => item.textContent)).toEqual(["Block"])
		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })

		fireEvent.click(within(panel).getByRole("button", { name: "Actions for Carol" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Unblock" }))

		await vi.waitFor(() => {
			expect(block.toggleParticipantBlocked).toHaveBeenCalledExactlyOnceWith(CAROL, [blockedRecord], true)
		})
		// The menu's Escape stayed with the menu: the panel is still open.
		expect(screen.getByRole("complementary", { name: "Chat info" })).toBeTruthy()
	})

	// Block asks for confirmation first (a modal of its own); unblock runs straight away, so it is the toggle that can
	// still be in flight while another participant's removal is confirmed.
	it("keeps a removal's confirm pending while an unblock of someone else settles", async () => {
		const target = chat()
		const blockedRecord = mockBlockedContact({ userId: 3n, email: CAROL.email })
		let finishRemove: (value: unknown) => void = () => undefined
		let finishBlock: (value: unknown) => void = () => undefined

		participants.removeChatParticipant.mockReturnValue(
			new Promise(resolve => {
				finishRemove = resolve
			})
		)
		block.toggleParticipantBlocked.mockReturnValue(
			new Promise(resolve => {
				finishBlock = resolve
			})
		)
		contacts.data = { contacts: [], blocked: [blockedRecord] }
		renderThread(target, deriveBlockedUsers([blockedRecord]))

		const panel = openPanel()

		// Carol's unblock starts first; Bob's remove confirm is not pending because of it.
		fireEvent.click(within(panel).getByRole("button", { name: "Actions for Carol" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Unblock" }))
		fireEvent.click(within(panel).getByRole("button", { name: "Actions for Bob" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }))

		const confirm = await screen.findByRole("alertdialog")
		const confirmButton = within(confirm).getByRole<HTMLButtonElement>("button", { name: "Remove" })

		expect(confirmButton.disabled).toBe(false)
		fireEvent.click(confirmButton)
		await vi.waitFor(() => {
			expect(within(confirm).getByRole<HTMLButtonElement>("button", { name: /Remove/ }).disabled).toBe(true)
		})

		// The unblock settling leaves the removal running: its confirm stays pending and open.
		await act(async () => {
			finishBlock({ status: "success" })
			await Promise.resolve()
		})
		await vi.waitFor(() => {
			// Behind the modal confirm, so reached as hidden.
			expect(within(panel).getByRole("button", { name: "Actions for Carol", hidden: true })).toBeTruthy()
		})
		expect(screen.getByRole("alertdialog")).toBeTruthy()
		expect(within(screen.getByRole("alertdialog")).getByRole<HTMLButtonElement>("button", { name: /Remove/ }).disabled).toBe(true)
		expect(within(panel).queryByRole("button", { name: "Actions for Bob", hidden: true })).toBeNull()

		await act(async () => {
			finishRemove({ status: "success", item: target })
			await Promise.resolve()
		})
		await vi.waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull()
		})
		expect(within(panel).getByRole("button", { name: "Actions for Bob" })).toBeTruthy()
	})

	it("adds contacts from the picker inside the panel, then returns to the list", async () => {
		const target = chat()
		const dave = mockContact({ uuid: testUuid("dave"), userId: 9n, email: "dave@x.io", nickName: "Dave" })

		contacts.data = { contacts: [dave], blocked: [] }
		participants.addChatParticipants.mockResolvedValue({ status: "success", item: target })
		renderThread(target)

		const panel = openPanel()

		fireEvent.click(within(panel).getByRole("button", { name: "Add participants" }))
		expect(document.activeElement?.tagName).toBe("INPUT")
		fireEvent.click(within(panel).getByRole("option", { name: /Dave/ }))
		fireEvent.click(within(panel).getByRole("button", { name: "Add" }))

		await vi.waitFor(() => {
			expect(within(panel).getByRole("list", { name: "Participants" })).toBeTruthy()
		})
		expect(participants.addChatParticipants).toHaveBeenCalledExactlyOnceWith(target, [dave])
		expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Add participants" }))
	})

	it("leaves through the chat's own confirm (participant)", async () => {
		const target = chat({ ownerId: 2n })

		actions.leaveChat.mockResolvedValue({ status: "success", item: undefined })
		renderThread(target)
		fireEvent.click(within(openPanel()).getByRole("button", { name: "Leave" }))
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }))

		await vi.waitFor(() => {
			expect(actions.leaveChat).toHaveBeenCalledExactlyOnceWith(target, expect.anything())
		})
	})
})

describe("chat info panel — below the breakpoint", () => {
	it("opens as a sheet for this conversation only", async () => {
		viewport.wide = false
		const { rerender } = renderThread()

		fireEvent.click(screen.getByRole("button", { name: "Participants" }))

		expect(await screen.findByRole("dialog", { name: "Chat info" })).toBeTruthy()
		expect(screen.queryByRole("complementary", { name: "Chat info" })).toBeTruthy()

		rerender(
			<Thread
				target={chat({ uuid: testUuid("other") })}
				blocked={EMPTY_BLOCKED_USERS}
			/>
		)
		await act(() => new Promise(resolve => setTimeout(resolve, 50)))

		expect(screen.queryByRole("dialog", { name: "Chat info" })).toBeNull()
		expect(useChatInfoStore.getState().drawerKey).toBeNull()
	})
})
