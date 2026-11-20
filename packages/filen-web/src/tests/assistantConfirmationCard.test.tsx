// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import "@/lib/i18n"

// Only the browser can dispatch a trusted click, so the trust check is the one thing stood in for here.
const { trusted } = vi.hoisted(() => ({ trusted: { value: false } }))

vi.mock("@/features/assistant/components/userActivation", () => ({ isTrustedActivation: () => trusted.value }))

import { AssistantConfirmationCard } from "@/features/assistant/components/assistantConfirmationCard"
import { registerAssistantSession, sendAssistantMessage } from "@/features/assistant/store/assistantSession"
import { createMockAssistantSession, MOCK_ASSISTANT_MODEL } from "@/features/assistant/store/mockAssistantSession"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import type { ProposalStatus } from "@/features/assistant/store/transcript"
import type { AssistantProposal, AssistantSession } from "@/features/assistant/types"

const MOVE: AssistantProposal = {
	id: "p1",
	action: "move",
	targets: [
		{ handle: "f1", name: "Taxes 2025.pdf" },
		{ handle: "d4", name: "Scans" }
	],
	destination: "Documents/Archive",
	text: {}
}

let session: AssistantSession
let unregister: () => void

// Only a card the session itself proposed can be confirmed: one a turn is waiting on, as in production.
function propose(): AssistantProposal {
	sendAssistantMessage("move my receipts")
	vi.runAllTimers()

	const card = useAssistantStore.getState().entries.find(entry => entry.kind === "proposal")

	if (card?.kind !== "proposal") {
		throw new Error("no card")
	}

	return card.proposal
}

beforeEach(() => {
	vi.useFakeTimers()
	trusted.value = false
	session = createMockAssistantSession({ initialState: { kind: "ready", model: MOCK_ASSISTANT_MODEL }, stepMs: 10 })
	unregister = registerAssistantSession(session)
})

afterEach(() => {
	unregister()
	cleanup()
	vi.useRealTimers()
})

function renderCard(proposal: AssistantProposal, status: ProposalStatus = "pending"): void {
	render(
		<AssistantConfirmationCard
			proposal={proposal}
			status={status}
		/>
	)
}

describe("AssistantConfirmationCard", () => {
	it("spells out the count, every name and the destination, never a handle", () => {
		renderCard(MOVE)

		const card = screen.getByRole("group", { name: "Move 2 items" })
		const items = within(card).getByRole("list", { name: "Items" })

		expect(
			within(items)
				.getAllByRole("listitem")
				.map(item => item.textContent)
		).toEqual(["Taxes 2025.pdf", "Scans"])
		expect(card.textContent).toContain("Documents/Archive")
		expect(card.textContent).not.toMatch(/\bf1\b|\bd4\b/)
	})

	it("ignores a click the browser did not dispatch itself", () => {
		const confirm = vi.spyOn(session, "confirm")

		renderCard(MOVE)
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }))

		expect(confirm).not.toHaveBeenCalled()
	})

	// Asserted straight after the dispatch returns, with no await in between: a confirm that only ran after
	// a microtask would have lost the user activation a download needs.
	it("runs a trusted confirm synchronously, inside the click", () => {
		const confirm = vi.spyOn(session, "confirm")

		const proposal = propose()

		trusted.value = true
		renderCard(proposal)
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }))

		expect(confirm).toHaveBeenCalledWith(proposal.id)
	})

	// A card restored from a saved conversation, or left from another one, never reaches the session.
	it("never confirms a card this page's session did not propose", () => {
		const confirm = vi.spyOn(session, "confirm")

		trusted.value = true
		renderCard(MOVE)
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }))

		expect(confirm).not.toHaveBeenCalled()
	})

	it("confirms a proposed card once only", () => {
		const confirm = vi.spyOn(session, "confirm")

		const proposal = propose()

		trusted.value = true
		renderCard(proposal)
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }))
		fireEvent.click(screen.getByRole("button", { name: "Confirm" }))

		expect(confirm).toHaveBeenCalledTimes(1)
	})

	it("declines through the session", () => {
		const reject = vi.spyOn(session, "reject")

		renderCard(MOVE)
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(reject).toHaveBeenCalledWith("p1")
	})

	it("labels a rename's new name and a new note's title, type and text", () => {
		renderCard({
			id: "p2",
			action: "rename",
			targets: [{ handle: "f1", name: "a.pdf" }],
			destination: null,
			text: { new_name: "b.pdf" }
		})

		expect(screen.getByText("New name").nextElementSibling?.textContent).toBe("b.pdf")

		cleanup()
		renderCard({
			id: "p3",
			action: "create-note",
			targets: [],
			destination: null,
			text: { title: "Packing", content: "socks", type: "checklist" }
		})

		const card = screen.getByRole("group", { name: "Create a note" })

		expect(within(card).getByText("Title").nextElementSibling?.textContent).toBe("Packing")
		expect(within(card).getByText("Type").nextElementSibling?.textContent).toBe("checklist")
		expect(within(card).getByText("Text").nextElementSibling?.textContent).toBe("socks")
	})

	it("states each change a note-flags card makes to its note, never the raw flags", () => {
		renderCard({
			id: "p4",
			action: "note-flags",
			targets: [{ handle: "n1", name: "Plan" }],
			destination: null,
			text: { pinned: "true", archived: "false" }
		})

		const card = screen.getByRole("group", { name: "Change a note" })

		expect(within(card).getByRole("list", { name: "Items" }).textContent).toBe("Plan")
		expect(
			within(within(card).getByRole("list", { name: "Changes" }))
				.getAllByRole("listitem")
				.map(item => item.textContent)
		).toEqual(["Pin", "Take out of the archive"])
		expect(within(card).queryByText("true")).toBeNull()
		expect(within(card).getByRole("button", { name: "Confirm" })).toBeDefined()
		expect(within(card).getByRole("button", { name: "Cancel" })).toBeDefined()
	})

	it("names a playlist card's playlist and counts and lists every track", () => {
		renderCard({
			id: "p5",
			action: "add-to-playlist",
			targets: [
				{ handle: "f1", name: "Bella Ciao.mp3" },
				{ handle: "t2", name: "Volare.mp3" }
			],
			destination: "Road trip",
			text: {}
		})

		const card = screen.getByRole("group", { name: "Add 2 tracks to a playlist" })

		expect(
			within(within(card).getByRole("list", { name: "Items" }))
				.getAllByRole("listitem")
				.map(item => item.textContent)
		).toEqual(["Bella Ciao.mp3", "Volare.mp3"])
		expect(within(card).getByText("Playlist").nextElementSibling?.textContent).toBe("Road trip")
	})

	it("labels a trash confirm as what it does", () => {
		renderCard({ ...MOVE, action: "trash", destination: null })

		expect(screen.getByRole("group", { name: "Move 2 items to the trash" })).toBeDefined()
		expect(screen.getByRole("button", { name: "Move to trash" })).toBeDefined()
	})

	it("shows a drafted message verbatim with the chat it goes into", () => {
		const text = "Line one\n  indented <b>not html</b>"

		renderCard({ id: "p2", action: "draft-message", targets: [{ handle: "c1", name: "Family" }], destination: null, text: { text } })

		const card = screen.getByRole("group", { name: "Put this draft into Family?" })

		expect(within(card).getByLabelText("Draft").textContent).toBe(text)
		expect(card.textContent).toContain("You still send it yourself.")
		expect(within(card).getByRole("button", { name: "Add draft" })).toBeDefined()
	})

	it("names who a draft reaches by address, two contacts with one display name apart", () => {
		const draft = (recipients: string[]): AssistantProposal => ({
			id: "p3",
			action: "draft-message",
			targets: [{ handle: "c1", name: "Maria Schmidt", recipients }],
			destination: null,
			text: { text: "Hi" }
		})

		renderCard(draft(["maria@example.com"]))

		expect(screen.getByRole("group", { name: "Put this draft into Maria Schmidt?" }).textContent).toContain("To: maria@example.com")

		cleanup()
		renderCard(draft(["a@x.io", "b@x.io", "c@x.io", "d@x.io", "e@x.io", "f@x.io", "g@x.io"]))

		expect(screen.getByText("To: a@x.io, b@x.io, c@x.io, d@x.io, e@x.io and 2 more")).toBeDefined()
	})

	it("hands focus to the composer when its buttons leave, rather than dropping it to the page", () => {
		const composer = document.createElement("textarea")
		const panel = document.createElement("aside")

		panel.id = "assistant-panel"
		composer.setAttribute("data-assistant-autofocus", "")
		panel.append(composer)
		document.body.append(panel)

		try {
			renderCard(MOVE)
			fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

			expect(document.activeElement).toBe(composer)
		} finally {
			panel.remove()
		}
	})

	it("replaces the buttons with the outcome once answered", () => {
		renderCard(MOVE, "expired")

		expect(screen.queryByRole("button")).toBeNull()
		expect(screen.getByText("Expired. Ask again to do this.")).toBeDefined()
	})

	it("shows a saved card that was still running as interrupted, with no buttons", () => {
		renderCard(MOVE, "interrupted")

		expect(screen.queryByRole("button")).toBeNull()
		expect(screen.getByText("This may have finished after you left. Check before asking again.")).toBeDefined()
	})
})
