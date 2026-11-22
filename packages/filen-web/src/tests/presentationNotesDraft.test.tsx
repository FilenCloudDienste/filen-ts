// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { slideRef, type DeckOp } from "@filen/office/core/presentation"
import "@/lib/i18n"
import { assistant } from "@/locales/en/assistant"
import { registerAssistantNotesWriter } from "@/features/assistant/store/assistantTransform"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import type { AssistantNotesOutcome, AssistantNotesRequest } from "@/features/assistant/types"
import { NotesDraft } from "@/features/presentation/components/notesDraft"
import type { PresentationRibbonEditor } from "@/features/presentation/components/ribbon/tabs"

// Speaker notes drafted from a slide: the slide's text read once from the worker (no edit state), the draft shown,
// Accept writes it as one setNotes; a draft with a number the slide does not hold cannot be added.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const MODEL = { id: "m", name: "Model", sizeBytes: 1 }
const SLIDE = slideRef(7)
let outcome: AssistantNotesOutcome
let seen: AssistantNotesRequest[] = []
let unregister: () => void

beforeEach(() => {
	seen = []
	unregister = registerAssistantNotesWriter({
		run: request => {
			seen.push(request)
			request.onText(outcome.ok ? outcome.text : "")

			return Promise.resolve(outcome)
		},
		shutdown: () => undefined
	})
	useAssistantStore.setState({ modelState: { kind: "ready", model: MODEL } })
})

afterEach(() => {
	unregister()
	cleanup()
})

function mount() {
	const commands: DeckOp[] = []
	const text = vi.fn(() => Promise.resolve({ slides: [{ index: 2, text: "Q3 results\nRevenue +12 %", notes: "" }], truncated: false }))
	const editor = {
		session: { text },
		command: (op: DeckOp) => {
			commands.push(op)

			return Promise.resolve({ ok: true, revision: 1, dirty: true })
		}
	} as unknown as PresentationRibbonEditor
	const onClose = vi.fn()

	render(
		<NotesDraft
			editor={editor}
			slide={SLIDE}
			index={2}
			notesEmpty
			onClose={onClose}
		/>
	)

	return { commands, text, onClose }
}

describe("the speaker notes draft", () => {
	it("drafts from the slide's text and adds the draft as the slide's notes", async () => {
		outcome = { ok: true, text: "Revenue grew 12 percent.\nThanks.", truncated: false, foreignLinks: [], foreignNumbers: [] }

		const { commands, text, onClose } = mount()

		expect(await screen.findByText(/Revenue grew 12 percent/u)).toBeTruthy()
		expect(text).toHaveBeenCalledWith(2, 2, expect.any(Number))
		expect(seen[0]?.slideText).toBe("Q3 results\nRevenue +12 %")

		const accept = screen.getByRole("button", { name: new RegExp(assistant.assistantTransformAccept, "u") })

		await waitFor(() => {
			expect((accept as HTMLButtonElement).disabled).toBe(false)
		})
		fireEvent.click(accept)
		await waitFor(() => {
			expect(onClose).toHaveBeenCalled()
		})
		expect(commands).toEqual([
			{
				family: "notes",
				kind: "setNotes",
				slide: SLIDE,
				body: {
					bodyPr: {},
					paragraphs: [
						{ pPr: {}, runs: [{ kind: "r", text: "Revenue grew 12 percent.", rPr: {} }] },
						{ pPr: {}, runs: [{ kind: "r", text: "Thanks.", rPr: {} }] }
					]
				}
			}
		])
	})

	it("keeps a draft with a number the slide does not hold from being added", async () => {
		outcome = { ok: true, text: "Revenue grew 40 percent.", truncated: false, foreignLinks: [], foreignNumbers: ["40"] }

		const { commands } = mount()

		expect(await screen.findByRole("alert")).toBeTruthy()
		expect(screen.getByRole<HTMLButtonElement>("button", { name: new RegExp(assistant.assistantTransformAccept, "u") }).disabled).toBe(
			true
		)
		expect(commands).toEqual([])
	})
})
