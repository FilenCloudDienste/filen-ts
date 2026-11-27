// @vitest-environment jsdom

// The note participants panel: its rows for the owner and for a participant, the permission select, remove and block
// with their confirms, one operation at a time, offline gating, and the menu entry toggling it beside the note or as a
// sheet. The writes themselves are stubbed; notesParticipants covers them.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { useState } from "react"
import type { Note } from "@filen/sdk-rs"
import { mockNote, mockNoteParticipant } from "@/tests/fixtures/notes"
import { testUuid } from "@/tests/support/uuid"
import "@/lib/i18n"

const { viewport, online, account, participants, block, toast, navigate, router } = vi.hoisted(() => ({
	viewport: { wide: true },
	online: { current: true },
	account: { id: 1n },
	participants: { addNoteParticipants: vi.fn(), removeNoteParticipant: vi.fn(), setNoteParticipantPermission: vi.fn() },
	block: { toggleParticipantBlocked: vi.fn() },
	toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() }),
	navigate: vi.fn(() => Promise.resolve()),
	router: { state: { location: { pathname: "/notes" } } }
}))

vi.mock("sonner", () => ({ toast }))
vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})
vi.mock("@/features/shell/lib/sidePanelLayout", () => ({
	isSidePanelNarrow: () => !viewport.wide,
	subscribeToSidePanelBreakpoint: () => () => undefined,
	useIsSidePanelNarrow: () => !viewport.wide
}))
vi.mock("@/features/contacts/components/addContactDialog", () => ({ AddContactDialog: () => null }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.current }))
vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: { id: account.id } }) }))
vi.mock("@/features/contacts/queries/contacts", () => ({
	useContactsQuery: () => ({ status: "success", data: { contacts: [], blocked: [] } })
}))
vi.mock("@/features/notes/lib/participants", () => participants)
vi.mock("@/features/contacts/lib/actions", () => block)
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate, useRouter: () => router, useRouterState: () => "" }))

const { NoteParticipantsHost, NoteParticipantsToggle } = await import("@/features/notes/components/noteParticipantsPanel")
const { noteParticipantsPanel } = await import("@/features/notes/store/useNoteParticipantsPanel")
const { useNoteDialogHost } = await import("@/features/notes/hooks/useNoteDialogHost")
const { SidePanelSlotContext } = await import("@/features/shell/lib/sidePanelSlot")

const ANNA = mockNoteParticipant({ userId: 1n, isOwner: true, nickName: "Anna", email: "anna@x.io", permissionsWrite: true })
const TOM = mockNoteParticipant({ userId: 2n, nickName: "Tom", email: "tom@x.io", permissionsWrite: true })
const JO = mockNoteParticipant({ userId: 3n, nickName: "Jo", email: "jo@x.io", permissionsWrite: false })
const NOTE = mockNote({ ownerId: 1n, participants: [JO, ANNA, TOM] })

// The note header's toggle, the pane's host, a stand-in for the menu's Participants entry, and the shell's side-panel
// slot beside them.
function NotePane({ note }: { note: Note }) {
	const [slot, setSlot] = useState<HTMLDivElement | null>(null)
	const dialogHost = useNoteDialogHost()

	return (
		<SidePanelSlotContext value={slot}>
			<button
				type="button"
				onClick={() => {
					dialogHost.openNoteDialog("participants", note)
				}}
			>
				Menu entry
			</button>
			<NoteParticipantsToggle note={note} />
			<NoteParticipantsHost note={note} />
			<div ref={setSlot} />
		</SidePanelSlotContext>
	)
}

function renderPane(note: Note = NOTE) {
	return render(<NotePane note={note} />)
}

function openPanel(): HTMLElement {
	fireEvent.click(screen.getByRole("button", { name: "Menu entry" }))

	return screen.getByRole("complementary", { name: "Participants (3)" })
}

function choose(option: HTMLElement): void {
	fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 })
	fireEvent.mouseDown(option, { button: 0 })
	fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 })
	fireEvent.mouseUp(option, { button: 0 })
	fireEvent.click(option)
}

function rowOf(panel: HTMLElement, name: string): HTMLElement {
	const row = within(panel)
		.getAllByRole("listitem")
		.find(item => item.textContent.includes(name))

	if (row === undefined) {
		throw new Error(`no row for ${name}`)
	}

	return row
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve: (value: T) => void = () => undefined
	const promise = new Promise<T>(settle => {
		resolve = settle
	})

	return { promise, resolve }
}

beforeEach(() => {
	vi.clearAllMocks()
	viewport.wide = true
	online.current = true
	account.id = 1n
	router.state.location.pathname = `/notes/${NOTE.uuid}`
	noteParticipantsPanel.useStore.setState({ panelOpen: false, drawerKey: null, focusRequestedFor: null })
})

afterEach(() => {
	cleanup()
})

describe("note participants panel — owner view", () => {
	it("lists everyone with the viewer first, an explanatory line, and labelled header buttons", () => {
		renderPane()

		const panel = openPanel()

		expect(document.activeElement).toBe(panel)
		expect(within(panel).getByText("People who can open this note")).toBeTruthy()
		expect(within(panel).getByRole("button", { name: "Add participants" })).toBeTruthy()
		expect(within(panel).getByRole("button", { name: "Close" })).toBeTruthy()

		const rows = within(panel).getAllByRole("listitem")

		expect(rows.map(row => row.querySelector("p")?.textContent)).toEqual(["Anna (you)", "Jo", "Tom"])
		expect(within(rows[0] ?? panel).getByText("Owner")).toBeTruthy()
		expect(within(rows[0] ?? panel).queryByRole("combobox")).toBeNull()
		expect(within(rows[0] ?? panel).queryByRole("button")).toBeNull()
	})

	it("gives every other row a permission select, a remove button and a block button, each named for the person", () => {
		renderPane()

		const panel = openPanel()
		const tom = rowOf(panel, "Tom")
		const jo = rowOf(panel, "Jo")

		expect(within(tom).getByRole("combobox", { name: "Permission for Tom" }).textContent).toContain("Can edit")
		expect(within(jo).getByRole("combobox", { name: "Permission for Jo" }).textContent).toContain("Can view")
		expect(within(tom).getByRole("button", { name: "Remove Tom" })).toBeTruthy()
		expect(within(jo).getByRole("button", { name: "Block Jo" })).toBeTruthy()
	})

	it("changes the permission through the select, showing the new value until the write settles", async () => {
		const write = deferred<{ status: "success" }>()

		participants.setNoteParticipantPermission.mockReturnValue(write.promise)
		renderPane()

		const tom = rowOf(openPanel(), "Tom")

		fireEvent.click(within(tom).getByRole("combobox", { name: "Permission for Tom" }))
		choose(screen.getByRole("option", { name: "Can view" }))

		expect(participants.setNoteParticipantPermission).toHaveBeenCalledExactlyOnceWith(NOTE, TOM, false)
		expect(within(tom).getByRole("combobox", { name: "Permission for Tom" }).textContent).toContain("Can view")

		await act(async () => {
			write.resolve({ status: "success" })
			await write.promise
		})

		// The stubbed write patched no cache, so the row shows the note's own value again.
		expect(within(tom).getByRole("combobox", { name: "Permission for Tom" }).textContent).toContain("Can edit")
	})

	it("reverts the select and reports a failed permission change", async () => {
		participants.setNoteParticipantPermission.mockResolvedValue({ status: "error", dto: { kind: "plain", message: "nope" } })
		renderPane()

		const jo = rowOf(openPanel(), "Jo")

		fireEvent.click(within(jo).getByRole("combobox", { name: "Permission for Jo" }))

		await act(async () => {
			choose(screen.getByRole("option", { name: "Can edit" }))
			await Promise.resolve()
		})

		expect(participants.setNoteParticipantPermission).toHaveBeenCalledExactlyOnceWith(NOTE, JO, true)
		expect(toast.error).toHaveBeenCalledTimes(1)
		expect(within(jo).getByRole("combobox", { name: "Permission for Jo" }).textContent).toContain("Can view")
	})

	it("removes a participant only once the confirm is accepted", async () => {
		participants.removeNoteParticipant.mockResolvedValue({ status: "success" })
		renderPane()

		fireEvent.click(within(rowOf(openPanel(), "Tom")).getByRole("button", { name: "Remove Tom" }))

		expect(participants.removeNoteParticipant).not.toHaveBeenCalled()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Remove" }))
			await Promise.resolve()
		})

		expect(participants.removeNoteParticipant).toHaveBeenCalledExactlyOnceWith(NOTE, TOM)
	})

	it("locks every row's controls while one participant's change is in flight", async () => {
		const write = deferred<{ status: "success" }>()

		participants.setNoteParticipantPermission.mockReturnValue(write.promise)
		renderPane()

		const panel = openPanel()

		fireEvent.click(within(rowOf(panel, "Tom")).getByRole("combobox", { name: "Permission for Tom" }))
		choose(screen.getByRole("option", { name: "Can view" }))

		const blockOther: HTMLButtonElement = within(rowOf(panel, "Jo")).getByRole("button", { name: "Block Jo" })

		expect(blockOther.disabled).toBe(true)

		fireEvent.click(blockOther)

		expect(block.toggleParticipantBlocked).not.toHaveBeenCalled()

		await act(async () => {
			write.resolve({ status: "success" })
			await write.promise
		})

		expect(blockOther.disabled).toBe(false)
	})

	it("opens a block confirm and blocks nothing until it is confirmed; cancel blocks nothing", async () => {
		block.toggleParticipantBlocked.mockReturnValue(Promise.resolve({ status: "success" }))
		renderPane()

		const panel = openPanel()

		fireEvent.click(within(rowOf(panel, "Tom")).getByRole("button", { name: "Block Tom" }))

		expect(screen.getByText("Block contact?")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(screen.queryByText("Block contact?")).toBeNull()
		expect(block.toggleParticipantBlocked).not.toHaveBeenCalled()

		fireEvent.click(within(rowOf(panel, "Tom")).getByRole("button", { name: "Block Tom" }))

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Block" }))
			await Promise.resolve()
		})

		expect(block.toggleParticipantBlocked).toHaveBeenCalledExactlyOnceWith(TOM, [], false)
	})

	it("disables every write offline", () => {
		online.current = false
		renderPane()

		const panel = openPanel()

		for (const button of within(panel).getAllByRole("button")) {
			if (button.getAttribute("aria-label") !== "Close") {
				expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(true)
			}
		}

		expect(within(rowOf(panel, "Tom")).getByRole("combobox", { name: "Permission for Tom" }).hasAttribute("data-disabled")).toBe(true)
	})

	it("switches to the contacts picker and back", () => {
		renderPane()

		const panel = openPanel()

		fireEvent.click(within(panel).getByRole("button", { name: "Add participants" }))

		expect(within(panel).getByText("Choose one or more contacts to add to this note.")).toBeTruthy()
		expect(
			within(panel)
				.queryAllByRole("listitem")
				.filter(item => item.textContent.includes("Tom"))
		).toEqual([])

		fireEvent.click(within(panel).getByRole("button", { name: "Cancel" }))

		expect(document.activeElement).toBe(within(panel).getByRole("button", { name: "Add participants" }))
	})
})

describe("note participants panel — participant view", () => {
	it("shows read-only rows: permissions as text, no select, no remove, no add", () => {
		account.id = 3n
		renderPane()

		const panel = openPanel()

		expect(within(panel).queryByRole("combobox")).toBeNull()
		expect(within(panel).queryByRole("button", { name: /^Remove/ })).toBeNull()
		expect(within(panel).queryByRole("button", { name: "Add participants" })).toBeNull()

		const rows = within(panel).getAllByRole("listitem")

		expect(rows.map(row => row.querySelector("p")?.textContent)).toEqual(["Jo (you)", "Anna", "Tom"])
		expect(within(rows[0] ?? panel).getByText("Can view")).toBeTruthy()
		expect(within(rows[0] ?? panel).queryByRole("button")).toBeNull()
		expect(within(rows[1] ?? panel).getByText("Owner")).toBeTruthy()
		expect(within(rows[1] ?? panel).getByRole("button", { name: "Block Anna" })).toBeTruthy()
		expect(within(rows[2] ?? panel).getByText("Can edit")).toBeTruthy()
	})
})

describe("note participants panel — toggling", () => {
	it("the menu entry toggles the panel, and closing hands focus back", () => {
		renderPane()

		const entry = screen.getByRole("button", { name: "Menu entry" })

		entry.focus()
		openPanel()
		fireEvent.click(entry)

		expect(screen.queryByRole("complementary")).toBeNull()
		expect(noteParticipantsPanel.useStore.getState().panelOpen).toBe(false)
	})

	it("closes from its close button and on Escape from inside, handing focus to the header toggle", () => {
		renderPane()

		fireEvent.click(within(openPanel()).getByRole("button", { name: "Close" }))

		expect(screen.queryByRole("complementary")).toBeNull()
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Participants" }))

		const panel = openPanel()

		fireEvent.keyDown(within(panel).getByRole("button", { name: "Close" }), { key: "Escape" })

		expect(screen.queryByRole("complementary")).toBeNull()
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Participants" }))
	})

	it("stays open for the next note in the session", () => {
		const { rerender } = renderPane()

		openPanel()
		rerender(<NotePane note={mockNote({ uuid: testUuid("other"), ownerId: 1n, participants: [ANNA] })} />)

		expect(screen.getByRole("complementary", { name: "Participants (1)" })).toBeTruthy()
	})

	it("opens another note first when the entry came from that note's row", () => {
		router.state.location.pathname = "/notes/elsewhere"
		renderPane()
		openPanel()

		expect(navigate).toHaveBeenCalledExactlyOnceWith({ to: "/notes/$uuid", params: { uuid: NOTE.uuid } })
	})

	it("opens as a sheet below the breakpoint", async () => {
		viewport.wide = false
		renderPane()

		fireEvent.click(screen.getByRole("button", { name: "Menu entry" }))

		expect(await screen.findByRole("dialog", { name: "Participants" })).toBeTruthy()
		expect(noteParticipantsPanel.useStore.getState().drawerKey).toBe(NOTE.uuid)
	})
})

describe("note participants panel — header toggle", () => {
	it("shows the participant count and toggles the panel, reporting itself expanded", () => {
		renderPane()

		const toggle = screen.getByRole("button", { name: "Participants" })

		expect(toggle.textContent).toBe("3")
		expect(toggle.getAttribute("aria-expanded")).toBe("false")

		fireEvent.click(toggle)

		const panel = screen.getByRole("complementary", { name: "Participants (3)" })

		expect(document.activeElement).toBe(panel)
		expect(toggle.getAttribute("aria-expanded")).toBe("true")
		expect(toggle.getAttribute("aria-controls")).toBe(panel.id)

		fireEvent.click(toggle)

		expect(screen.queryByRole("complementary")).toBeNull()
		expect(toggle.getAttribute("aria-expanded")).toBe("false")
	})

	it("opens the read-only panel for a participant who does not own the note", () => {
		account.id = 2n
		renderPane()

		fireEvent.click(screen.getByRole("button", { name: "Participants" }))

		const panel = screen.getByRole("complementary", { name: "Participants (3)" })

		expect(within(panel).queryByRole("combobox")).toBeNull()
		expect(within(panel).queryByRole("button", { name: "Add participants" })).toBeNull()
	})

	it("opens the sheet below the breakpoint", async () => {
		viewport.wide = false
		renderPane()

		fireEvent.click(screen.getByRole("button", { name: "Participants" }))

		expect(await screen.findByRole("dialog", { name: "Participants" })).toBeTruthy()
	})
})
