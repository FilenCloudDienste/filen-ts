// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import "@/lib/i18n"

const { kvStore, viewport } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>(), viewport: { wide: true } }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvEntriesJson: (prefix: string) => Promise.resolve([...kvStore].filter(([key]) => key.startsWith(prefix))),
	kvKeys: (prefix: string) => Promise.resolve([...kvStore.keys()].filter(key => key.startsWith(prefix))),
	// Signed in: the session row is there.
	kvHas: (key: string) => Promise.resolve(kvStore.has(key)),
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	},
	kvDeletePrefix: (prefix: string) => {
		for (const key of [...kvStore.keys()].filter(key => key.startsWith(prefix))) {
			kvStore.delete(key)
		}

		return Promise.resolve()
	}
}))

vi.mock("@/lib/sdk/session", () => ({ hasPersistedSession: () => Promise.resolve(true), onAuthBroadcast: () => () => undefined }))

// The real toast functions, the bare call observed: no Toaster is mounted here.
vi.mock("sonner", async importOriginal => {
	const actual = await importOriginal<typeof import("sonner")>()

	return { ...actual, toast: Object.assign(vi.fn(), actual.toast) }
})

// The width query only feeds the resize handle; no query client needed.
vi.mock("@/features/shell/queries/sidebarWidth", () => ({
	useSidebarWidthQuery: () => ({ data: 360, refetch: () => Promise.resolve() })
}))

// One fake MediaQueryList for the file: breakpoints.ts caches the first one it gets.
vi.mock("@/features/shell/lib/breakpoints", () => ({
	isNarrowViewport: () => !viewport.wide,
	subscribeToLayoutBreakpoint: () => () => undefined
}))

import { toast } from "sonner"
import { registerAllActions } from "@/lib/keymap/actions"
import { AssistantDrawer, AssistantSidePanel } from "@/features/assistant/components/assistantPanel"
import { AssistantToggle } from "@/features/assistant/components/assistantToggle"
import { useAssistantStore } from "@/features/assistant/store/useAssistantStore"
import { INITIAL_TRANSCRIPT_STATE } from "@/features/assistant/store/transcript"
import { useAssistantHistoryStore } from "@/features/assistant/store/conversationHistory"
import { registerAssistantSession, sendAssistantMessage } from "@/features/assistant/store/assistantSession"
import { createMockAssistantSession, MOCK_ASSISTANT_MODEL } from "@/features/assistant/store/mockAssistantSession"
import type { AssistantModelState, AssistantSession } from "@/features/assistant/types"

let session: AssistantSession
let unregister: () => void = () => undefined

// The toggle binds app.toggleAssistant, which must be registered like main.tsx does before the first render.
registerAllActions()

function withSession(initialState: AssistantModelState): AssistantSession {
	session = createMockAssistantSession({ initialState, stepMs: 10, downloadSteps: 2 })
	unregister = registerAssistantSession(session)

	return session
}

beforeEach(() => {
	viewport.wide = true
	kvStore.clear()
	useAssistantStore.setState({ ...INITIAL_TRANSCRIPT_STATE, panelOpen: false, drawerOpen: false, draft: "", focusRequested: false })
})

afterEach(() => {
	unregister()
	cleanup()
	vi.useRealTimers()
})

describe("AssistantToggle", () => {
	function toggleButton(): HTMLElement {
		return screen.getByRole("button", { name: "Assistant" })
	}

	it("opens and closes the inline panel at desktop widths, reporting it as pressed", () => {
		render(<AssistantToggle itemClass={active => (active ? "active" : "idle")} />)

		expect(toggleButton().getAttribute("aria-pressed")).toBe("false")

		fireEvent.click(toggleButton())

		expect(useAssistantStore.getState().panelOpen).toBe(true)
		expect(toggleButton().getAttribute("aria-pressed")).toBe("true")
		expect(toggleButton().className).toBe("active")

		fireEvent.click(toggleButton())

		expect(useAssistantStore.getState().panelOpen).toBe(false)
	})

	it("continues an interrupted download once it shows, saying so with the way to cancel it", () => {
		const resume = vi.fn()
		const cancel = vi.fn()
		const size = MOCK_ASSISTANT_MODEL.sizeBytes
		const downloading = (receivedBytes: number, resumed: boolean): AssistantModelState => ({
			kind: "downloading",
			model: MOCK_ASSISTANT_MODEL,
			receivedBytes,
			waiting: false,
			resumed
		})

		session = {
			...createMockAssistantSession({
				initialState: { kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL, partialBytes: size / 2 }
			}),
			resumeInterruptedDownload: resume,
			cancelDownload: cancel
		}
		unregister = registerAssistantSession(session)

		const { rerender } = render(<AssistantToggle itemClass={() => ""} />)

		rerender(<AssistantToggle itemClass={() => ""} />)

		expect(resume).toHaveBeenCalledTimes(1)
		expect(toast).not.toHaveBeenCalled()

		act(() => {
			useAssistantStore.getState().applyEvent({ type: "model", state: downloading(size / 2, true) })
		})
		act(() => {
			useAssistantStore.getState().applyEvent({ type: "model", state: downloading((size * 3) / 5, true) })
		})

		expect(toast).toHaveBeenCalledTimes(1)

		const [title, options] = vi.mocked(toast).mock.calls[0] ?? []

		expect(title).toBe("Continuing the assistant's model download")
		expect(options?.description).toMatch(/ of .* is already on this device\.$/)

		const action = options?.action

		expect(action).toMatchObject({ label: "Cancel download" })

		if (typeof action === "object" && action !== null && "onClick" in action) {
			action.onClick(new MouseEvent("click") as never)
		}

		expect(cancel).toHaveBeenCalledTimes(1)
		// The rail says it too, for as long as it runs.
		expect(screen.getByRole("button", { name: "Assistant, downloading the model" })).toBeDefined()
	})

	it.each<[string, AssistantModelState]>([
		["completes", { kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: false }],
		["is cancelled", { kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL, partialBytes: 1 }]
	])("takes the announcement and its Cancel away once the continued download %s", (_label, after) => {
		const dismiss = vi.spyOn(toast, "dismiss")

		withSession({ kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL, partialBytes: 1 })
		render(<AssistantToggle itemClass={() => ""} />)

		act(() => {
			useAssistantStore.getState().applyEvent({
				type: "model",
				state: { kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes: 1, waiting: false, resumed: true }
			})
		})

		expect(dismiss).not.toHaveBeenCalled()

		act(() => {
			useAssistantStore.getState().applyEvent({ type: "model", state: after })
		})

		expect(dismiss).toHaveBeenCalledWith("assistant-download-resumed")
		dismiss.mockRestore()
	})

	it("keeps the button's accessible name still while the percentage moves", () => {
		withSession({ kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantToggle itemClass={() => ""} />)

		for (const receivedBytes of [0, MOCK_ASSISTANT_MODEL.sizeBytes / 3, MOCK_ASSISTANT_MODEL.sizeBytes / 2]) {
			act(() => {
				useAssistantStore.getState().applyEvent({
					type: "model",
					state: { kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes, waiting: false, resumed: false }
				})
			})

			expect(screen.getByRole("button", { name: "Assistant, downloading the model" })).toBeDefined()
		}
	})

	it("announces nothing for a download a click started, but still shows it on the rail", () => {
		withSession({ kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantToggle itemClass={() => ""} />)

		act(() => {
			useAssistantStore.getState().applyEvent({
				type: "model",
				state: { kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes: 0, waiting: false, resumed: false }
			})
		})

		expect(toast).not.toHaveBeenCalled()
		expect(screen.getByRole("button", { name: "Assistant, downloading the model" })).toBeDefined()

		act(() => {
			useAssistantStore
				.getState()
				.applyEvent({ type: "model", state: { kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: false } })
		})

		expect(screen.getByRole("button", { name: "Assistant" })).toBeDefined()
	})

	it("says on the rail that a hidden panel's turn works, waits for a confirmation or finished, until it shows", () => {
		vi.useFakeTimers()
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantToggle itemClass={() => ""} />)

		act(() => {
			sendAssistantMessage("draft a note to the family")
		})

		expect(screen.getByRole("button", { name: "Assistant, working" })).toBeDefined()

		act(() => {
			vi.runAllTimers()
		})

		expect(screen.getByRole("button", { name: "Assistant, waiting for your confirmation" })).toBeDefined()
		expect(toast).toHaveBeenCalledTimes(1)

		const [title, options] = vi.mocked(toast).mock.calls[0] ?? []

		expect(title).toBe("The assistant is waiting for your confirmation")

		const action = options?.action

		expect(action).toMatchObject({ label: "Show" })

		const dismiss = vi.spyOn(toast, "dismiss")

		act(() => {
			if (typeof action === "object" && action !== null && "onClick" in action) {
				action.onClick(new MouseEvent("click") as never)
			}
		})

		expect(useAssistantStore.getState().panelOpen).toBe(true)
		expect(dismiss).toHaveBeenCalledWith("assistant-confirmation")
		// Shown, the panel says it all.
		expect(screen.getByRole("button", { name: "Assistant" })).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: "Assistant" }))

		expect(screen.getByRole("button", { name: "Assistant, waiting for your confirmation" })).toBeDefined()

		// Answered by the next message (sent from anywhere); that turn finishes while the panel stays hidden.
		act(() => {
			sendAssistantMessage("find my taxes")
		})
		act(() => {
			vi.runAllTimers()
		})

		expect(screen.getByRole("button", { name: "Assistant, new reply" })).toBeDefined()
		expect(toast).toHaveBeenCalledTimes(1)

		fireEvent.click(screen.getByRole("button", { name: "Assistant, new reply" }))
		fireEvent.click(screen.getByRole("button", { name: "Assistant" }))

		expect(screen.getByRole("button", { name: "Assistant" })).toBeDefined()
	})

	it("raises no cue or toast for a turn the shown panel already shows", () => {
		vi.useFakeTimers()
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		useAssistantStore.setState({ panelOpen: true })
		render(<AssistantToggle itemClass={() => ""} />)

		act(() => {
			sendAssistantMessage("draft a note to the family")
		})
		act(() => {
			vi.runAllTimers()
		})

		expect(screen.getByRole("button", { name: "Assistant" })).toBeDefined()
		expect(toast).not.toHaveBeenCalled()
	})

	it("opens the drawer below the breakpoint instead", () => {
		viewport.wide = false
		render(<AssistantToggle itemClass={() => ""} />)

		fireEvent.click(toggleButton())

		expect(useAssistantStore.getState().drawerOpen).toBe(true)
		expect(useAssistantStore.getState().panelOpen).toBe(false)
	})
})

describe("AssistantSidePanel", () => {
	it("is a labelled complementary landmark, never a dialog that would silence every shortcut", () => {
		withSession({ kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		expect(screen.getByRole("complementary", { name: "Assistant" })).toBeDefined()
		expect(screen.queryByRole("dialog")).toBeNull()
	})

	it("tells the session the panel shows while it is mounted", () => {
		const shown: boolean[] = []

		withSession({ kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL })
		vi.spyOn(session, "setPanelOpen").mockImplementation(open => {
			shown.push(open)
		})

		const { unmount } = render(<AssistantSidePanel />)

		unmount()

		expect(shown).toEqual([true, false])
	})

	it("shows neither the opt-in nor a status before its check answered, then hands focus to what it found", () => {
		withSession({ kind: "checking", model: null })
		useAssistantStore.setState({ focusRequested: true })
		render(<AssistantSidePanel />)

		const panel = screen.getByRole("complementary")

		expect(screen.getByRole("status", { name: "Checking the assistant" })).toBeDefined()
		expect(screen.queryByRole("button", { name: "Download model" })).toBeNull()
		expect(document.activeElement).toBe(panel)

		act(() => {
			useAssistantStore.setState({ modelState: { kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: false } })
		})

		return vi.waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Ask the assistant" }))
		})
	})

	it("explains the opt-in with the model and its size, then downloads on click", () => {
		vi.useFakeTimers()
		withSession({ kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		expect(screen.getByText("Qwen3.5 4B")).toBeDefined()
		expect(screen.getByText(/runs entirely on this device/)).toBeDefined()

		fireEvent.click(screen.getByRole("button", { name: "Download model" }))

		expect(screen.getByRole("progressbar", { name: "Model download" })).toBeDefined()
		expect(screen.getByRole("button", { name: "Cancel download" })).toBeDefined()

		// Downloaded is not loaded: the composer shows, and the model waits for a message or the Load action.
		const load = vi.spyOn(session, "loadModel")

		act(() => {
			vi.runAllTimers()
		})

		expect(screen.getByRole("textbox", { name: "Ask the assistant" })).toBeDefined()
		expect(screen.getByRole("button", { name: "Load model" })).toBeDefined()
		expect(useAssistantStore.getState().modelState.kind).toBe("downloaded")
		expect(load).not.toHaveBeenCalled()
	})

	it("restored open after a reload with the model on disk, shows the composer and loads nothing", () => {
		vi.useFakeTimers()
		withSession({ kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: false })

		const load = vi.spyOn(session, "loadModel")
		const send = vi.spyOn(session, "send")

		useAssistantStore.setState({ panelOpen: true })
		render(<AssistantSidePanel />)
		act(() => {
			vi.runAllTimers()
		})

		expect(screen.getByRole("textbox", { name: "Ask the assistant" })).toBeDefined()
		expect(screen.getByRole("status").textContent).toBe("The model loads when you send a message.")
		expect(screen.getByText("Not loaded")).toBeDefined()
		expect(load).not.toHaveBeenCalled()
		expect(send).not.toHaveBeenCalled()
		expect(useAssistantStore.getState().modelState.kind).toBe("downloaded")
	})

	it("says quietly that an idle model was unloaded, and loads it from the Load action", () => {
		vi.useFakeTimers()
		withSession({ kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: true })
		render(<AssistantSidePanel />)

		expect(screen.getByRole("status").textContent).toBe("Unloaded while unused to free memory. It loads again when you send a message.")

		fireEvent.click(screen.getByRole("button", { name: "Load model" }))

		expect(screen.getByRole("status").textContent).toBe("Loading model…")
		expect(screen.getByText("Loading")).toBeDefined()
		expect(screen.queryByRole("button", { name: "Load model" })).toBeNull()

		act(() => {
			vi.runAllTimers()
		})

		expect(screen.queryByRole("status")).toBeNull()
		expect(screen.getByText("On this device")).toBeDefined()
	})

	it("keeps focus in the panel when the Load action that had it goes away", () => {
		vi.useFakeTimers()
		withSession({ kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: false })
		render(<AssistantSidePanel />)

		const load = screen.getByRole("button", { name: "Load model" })

		load.focus()
		fireEvent.click(load)

		expect(screen.queryByRole("button", { name: "Load model" })).toBeNull()
		expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Ask the assistant" }))
	})

	it("reads as loading in the header too while a sent message waits for the runtime to start the load", () => {
		withSession({ kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: false })
		render(<AssistantSidePanel />)

		const heading = screen.getByRole("heading", { name: "Assistant" })

		expect(heading.nextElementSibling?.textContent).toBe("Not loaded")

		act(() => {
			useAssistantStore.setState({ activeTurnId: "turn-1" })
		})

		expect(heading.nextElementSibling?.textContent).toBe("Loading")
		expect(screen.getByRole("status").textContent).toBe("Loading model…")
	})

	it("loads the model for a sent message, showing it is loading, then answers", () => {
		vi.useFakeTimers()
		withSession({ kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: true })
		render(<AssistantSidePanel />)

		const composer = screen.getByRole("textbox", { name: "Ask the assistant" })

		fireEvent.change(composer, { target: { value: "find my taxes" } })
		fireEvent.keyDown(composer, { key: "Enter" })

		expect(useAssistantStore.getState().entries[0]).toMatchObject({ kind: "user", text: "find my taxes" })
		expect(screen.getByRole("status").textContent).toBe("Loading model…")
		expect(screen.getByRole("button", { name: "Stop" })).toBeDefined()

		act(() => {
			vi.runAllTimers()
		})

		expect(useAssistantStore.getState().modelState.kind).toBe("ready")
		expect(useAssistantStore.getState().entries.some(entry => entry.kind === "reply" && entry.final)).toBe(true)
	})

	it("reports typing in the composer as activity", () => {
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })

		const noteActivity = vi.spyOn(session, "noteActivity")

		render(<AssistantSidePanel />)
		fireEvent.change(screen.getByRole("textbox", { name: "Ask the assistant" }), { target: { value: "f" } })

		expect(noteActivity).toHaveBeenCalledTimes(1)
	})

	it("names every model state in the header chip, the waiting download included", () => {
		const size = MOCK_ASSISTANT_MODEL.sizeBytes
		const chips: [AssistantModelState, string][] = [
			[{ kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL }, "Not set up"],
			[
				{ kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes: size / 2, waiting: false, resumed: false },
				"Downloading 50%"
			],
			[
				{ kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes: size / 2, waiting: true, resumed: false },
				"Waiting for connection"
			],
			[{ kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes: size, waiting: true, resumed: false }, "Downloading 100%"],
			[{ kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: false }, "Not loaded"],
			[{ kind: "downloaded", model: MOCK_ASSISTANT_MODEL, idleUnloaded: true }, "Not loaded"],
			[{ kind: "loading", model: MOCK_ASSISTANT_MODEL, verifying: false }, "Loading"],
			[{ kind: "ready", model: MOCK_ASSISTANT_MODEL }, "On this device"],
			[{ kind: "error", error: "load-failed", model: MOCK_ASSISTANT_MODEL }, "Error"],
			[{ kind: "unavailable", reason: "in-use-elsewhere", model: MOCK_ASSISTANT_MODEL }, "In use elsewhere"],
			[{ kind: "unavailable", reason: "insufficient-memory", model: MOCK_ASSISTANT_MODEL }, "Unavailable"]
		]

		for (const [state, chip] of chips) {
			withSession(state)
			render(<AssistantSidePanel />)

			const heading = screen.getByRole("heading", { name: "Assistant" })

			expect(heading.nextElementSibling?.textContent).toBe(chip)

			unregister()
			cleanup()
		}
	})

	it("words the download and start-up phases instead of leaving a stale figure", () => {
		const size = MOCK_ASSISTANT_MODEL.sizeBytes
		const phases: [AssistantModelState, string | RegExp][] = [
			[{ kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes: size / 2, waiting: false, resumed: false }, / of /],
			[
				{ kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes: size / 2, waiting: true, resumed: false },
				"Waiting for the connection…"
			],
			[
				{ kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes: size, waiting: false, resumed: false },
				"Finishing the download…"
			],
			[
				{ kind: "downloading", model: MOCK_ASSISTANT_MODEL, receivedBytes: size / 2, waiting: false, resumed: true },
				"Continued where your last download stopped."
			],
			[{ kind: "loading", model: MOCK_ASSISTANT_MODEL, verifying: true }, "Checking the downloaded model…"],
			[{ kind: "loading", model: MOCK_ASSISTANT_MODEL, verifying: false }, "Loading model…"]
		]

		for (const [state, text] of phases) {
			withSession(state)
			render(<AssistantSidePanel />)

			expect(screen.getByText(text)).toBeDefined()

			unregister()
			cleanup()
		}
	})

	it("disables the download on a device that cannot run the model, saying why", () => {
		withSession({ kind: "unavailable", reason: "insufficient-memory", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		const button = screen.getByRole("button", { name: "Download model" })

		expect(button.hasAttribute("disabled")).toBe(true)
		expect(button.getAttribute("aria-describedby")).toBe("assistant-unavailable-reason")
		expect(screen.getByText(/doesn't have enough memory/)).toBeDefined()
	})

	it("keeps the download clickable when only free space was lacking, so freeing some lets it check again", () => {
		withSession({ kind: "unavailable", reason: "insufficient-storage", model: MOCK_ASSISTANT_MODEL })

		const download = vi.spyOn(session, "downloadModel")

		render(<AssistantSidePanel />)

		const button = screen.getByRole("button", { name: "Download model" })

		expect(button.hasAttribute("disabled")).toBe(false)
		fireEvent.click(button)
		expect(download).toHaveBeenCalledTimes(1)
	})

	it("offers no action while another tab holds the model", () => {
		withSession({ kind: "unavailable", reason: "in-use-elsewhere", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		expect(screen.getByText("Already open elsewhere")).toBeDefined()
		expect(screen.queryByRole("button", { name: "Download model" })).toBeNull()
	})

	it("focuses the composer when the user opened the panel, and not when it was restored", () => {
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })

		const restored = render(<AssistantSidePanel />)

		expect(document.activeElement).toBe(document.body)

		restored.unmount()
		useAssistantStore.setState({ focusRequested: true })
		render(<AssistantSidePanel />)

		expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Ask the assistant" }))
	})

	it("sends on Enter, keeps Shift+Enter and IME confirmation as typing, and offers Stop while replying", () => {
		vi.useFakeTimers()
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		const composer = screen.getByRole("textbox", { name: "Ask the assistant" })

		fireEvent.change(composer, { target: { value: "find my taxes" } })
		fireEvent.keyDown(composer, { key: "Enter", shiftKey: true })
		fireEvent.keyDown(composer, { key: "Enter", isComposing: true })
		// Safari's Enter confirming a candidate arrives after the composition ended.
		fireEvent.keyDown(composer, { key: "Enter", keyCode: 229 })

		expect(useAssistantStore.getState().entries).toEqual([])

		fireEvent.keyDown(composer, { key: "Enter" })

		expect(useAssistantStore.getState().entries[0]).toMatchObject({ kind: "user", text: "find my taxes" })
		expect(useAssistantStore.getState().draft).toBe("")

		const live = document.querySelector('[aria-live="polite"]')

		// The live region reads the step under way, not a generic line.
		expect(live?.textContent).toBe('Searching for "taxes"')

		fireEvent.click(screen.getByRole("button", { name: "Stop" }))

		expect(useAssistantStore.getState().activeTurnId).toBeNull()
		expect(screen.getByRole("button", { name: "Send" })).toBeDefined()
		expect(live?.textContent).toContain("Stopped")
	})

	it("keeps focus in the composer when Stop turns back into a disabled Send", () => {
		vi.useFakeTimers()
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		const composer = screen.getByRole("textbox", { name: "Ask the assistant" })

		fireEvent.change(composer, { target: { value: "find my taxes" } })
		fireEvent.keyDown(composer, { key: "Enter" })

		const stop = screen.getByRole("button", { name: "Stop" })

		stop.focus()
		fireEvent.click(stop)

		expect(document.activeElement).toBe(composer)
	})

	it("announces a waiting card with who a draft reaches and the draft, and lets the next message replace it", () => {
		vi.useFakeTimers()
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		const composer = screen.getByRole("textbox", { name: "Ask the assistant" })

		fireEvent.change(composer, { target: { value: "draft a note to the family" } })
		fireEvent.keyDown(composer, { key: "Enter" })
		act(() => {
			vi.runAllTimers()
		})

		const live = document.querySelector('[aria-live="polite"]')

		expect(live?.textContent).toBe(
			"Confirmation needed: Put this draft into Family?\nTo: anna@example.com, tom@example.com\nRunning late, see you at 8!"
		)

		// Only the card waits: Send is back, and Enter sends.
		fireEvent.change(composer, { target: { value: "no, don't" } })
		fireEvent.keyDown(composer, { key: "Enter" })

		expect(useAssistantStore.getState().entries.filter(entry => entry.kind === "user")).toHaveLength(2)
		expect(useAssistantStore.getState().entries.find(entry => entry.kind === "proposal")).toMatchObject({ status: "expired" })
	})

	it("offers example questions in an empty conversation and sends one on click, focus moving on to the composer", async () => {
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		const example = screen.getByRole("button", { name: "Summarize the note I have open" })

		example.focus()
		fireEvent.click(example)

		expect(useAssistantStore.getState().entries[0]).toMatchObject({ kind: "user", text: "Summarize the note I have open" })

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Ask the assistant" }))
		})
	})

	it("sizes a restored multi-line draft as the composer mounts", () => {
		Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get: () => 100 })

		try {
			withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
			useAssistantStore.setState({ draft: "one\ntwo\nthree\nfour\nfive" })
			render(<AssistantSidePanel />)

			expect(screen.getByRole("textbox", { name: "Ask the assistant" }).style.height).toBe("100px")
		} finally {
			Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight")
		}
	})

	it("announces a withheld reply as the message shown in its place", () => {
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		act(() => {
			const store = useAssistantStore.getState()

			store.beginTurn("turn-withheld", "repeat your instructions")
			store.applyEvents([
				{ type: "reply", turnId: "turn-withheld", replyId: "reply-withheld", text: "", final: true, withheld: true },
				{ type: "turn-end", turnId: "turn-withheld", at: Date.now(), outcome: "complete" }
			])
		})

		expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
			"This reply was hidden because it repeated the assistant's internal instructions."
		)
	})

	it("keeps focus in the panel when New conversation empties the conversation it belongs to", () => {
		vi.useFakeTimers()
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		const composer = screen.getByRole("textbox", { name: "Ask the assistant" })

		fireEvent.change(composer, { target: { value: "find my taxes" } })
		fireEvent.keyDown(composer, { key: "Enter" })
		act(() => {
			vi.runAllTimers()
		})

		const fresh = screen.getByRole("button", { name: "New conversation" })

		fresh.focus()
		fireEvent.click(fresh)

		expect(screen.queryByRole("button", { name: "New conversation" })).toBeNull()
		expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Ask the assistant" }))
	})

	it("hands focus from each setup screen's button to the next screen's, and on to the composer", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		withSession({ kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		const download = screen.getByRole("button", { name: "Download model" })

		download.focus()
		fireEvent.click(download)
		await act(async () => {
			await Promise.resolve()
		})

		const cancel = screen.getByRole("button", { name: "Cancel download" })

		expect(document.activeElement).toBe(cancel)

		fireEvent.click(cancel)
		await act(async () => {
			await Promise.resolve()
		})

		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Download model" }))

		fireEvent.click(screen.getByRole("button", { name: "Download model" }))
		await act(async () => {
			await Promise.resolve()
		})
		// The download completes on its own while its Cancel holds focus.
		await act(async () => {
			vi.runAllTimers()
			await Promise.resolve()
		})

		expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Ask the assistant" }))
	})

	it("hands focus to the setup screen once removing the model takes the menu that opened the dialog", async () => {
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		fireEvent.click(screen.getByRole("button", { name: "More options" }))
		fireEvent.click(await screen.findByRole("menuitem", { name: "Remove downloaded model" }))
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }))

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(screen.getByRole("button", { name: "Download model" }))
		})
	})

	it("closes from its header", () => {
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		useAssistantStore.setState({ panelOpen: true })
		render(<AssistantSidePanel />)

		fireEvent.click(screen.getByRole("button", { name: "Close assistant" }))

		expect(useAssistantStore.getState().panelOpen).toBe(false)
	})
})

describe("AssistantDrawer", () => {
	it("leaves nothing behind when the window widens with the drawer open and narrows again", async () => {
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })

		const { rerender } = render(
			<AssistantDrawer
				open={true}
				narrow={true}
			/>
		)

		expect(await screen.findByRole("dialog", { name: "Assistant" })).toBeTruthy()

		// The shell closes the drawer on the crossing, in the same render that drops its narrow layout.
		rerender(
			<AssistantDrawer
				open={false}
				narrow={false}
			/>
		)
		rerender(
			<AssistantDrawer
				open={false}
				narrow={true}
			/>
		)
		await act(() => new Promise(resolve => setTimeout(resolve, 50)))

		expect(screen.queryByRole("dialog", { name: "Assistant" })).toBeNull()
	})
})

describe("AssistantHistory", () => {
	// jsdom has no Web Locks; one tab needs none.
	beforeEach(() => {
		useAssistantHistoryStore.setState({ open: false, conversations: null })
		Object.defineProperty(navigator, "locks", {
			configurable: true,
			value: { request: (_name: string, task: () => Promise<unknown>) => task() }
		})
	})

	// Past the mock's turn and the save's delay; the list's minute clock keeps re-arming, so never "all".
	async function settle(): Promise<void> {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000)
		})
	}

	async function ask(text: string): Promise<void> {
		const composer = screen.getByRole("textbox", { name: "Ask the assistant" })

		fireEvent.change(composer, { target: { value: text } })
		fireEvent.keyDown(composer, { key: "Enter" })
		await settle()
	}

	async function showHistory(): Promise<void> {
		fireEvent.click(screen.getByRole("button", { name: "Conversation history" }))
		await settle()
	}

	it("lists saved conversations by day, opens one, starts a new one and deletes one after confirming", async () => {
		vi.useFakeTimers()
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		await ask("find my taxes")
		await showHistory()

		expect(screen.getByRole("button", { name: "Conversation history" }).getAttribute("aria-pressed")).toBe("true")

		const list = screen.getByRole("navigation", { name: "Saved conversations" })

		expect(within(list).getByRole("heading", { name: "Today" })).toBeDefined()
		expect(within(list).getByRole("button", { name: "find my taxes" }).getAttribute("aria-current")).toBe("true")

		fireEvent.click(screen.getByRole("button", { name: "New conversation" }))
		await settle()

		expect(screen.queryByRole("navigation", { name: "Saved conversations" })).toBeNull()
		expect(useAssistantStore.getState().entries).toEqual([])

		await showHistory()
		fireEvent.click(screen.getByRole("button", { name: "find my taxes" }))
		await settle()

		expect(screen.queryByRole("navigation", { name: "Saved conversations" })).toBeNull()
		expect(useAssistantStore.getState().entries[0]).toMatchObject({ kind: "user", text: "find my taxes" })
		expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Ask the assistant" }))

		await showHistory()
		fireEvent.click(screen.getByRole("button", { name: "Delete “find my taxes”" }))
		fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }))
		await settle()

		expect(screen.queryByRole("button", { name: "find my taxes" })).toBeNull()
		expect(screen.getByText("No saved conversations yet")).toBeDefined()
		expect(useAssistantStore.getState().entries).toEqual([])
		// Its row, and the button that opened the dialog, are gone.
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "New conversation" }))
	})

	it("clears every saved conversation after confirming", async () => {
		vi.useFakeTimers()
		withSession({ kind: "ready", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		await ask("find my taxes")
		await showHistory()
		fireEvent.click(screen.getByRole("button", { name: "Clear history" }))
		fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear history" }))
		await settle()

		expect(screen.getByText("No saved conversations yet")).toBeDefined()
		expect([...kvStore.keys()].some(key => key.startsWith("assistant.v1.history."))).toBe(false)
	})

	it("stays reachable without a usable model: conversations can be deleted, opened only once it is ready", async () => {
		vi.useFakeTimers()
		kvStore.set("assistant.v1.history.meta.c1", {
			id: "c1",
			title: "find my taxes",
			createdAt: 1,
			updatedAt: Date.now(),
			bytes: 10,
			rev: "r1"
		})
		kvStore.set("assistant.v1.history.body.c1", {
			v: 1,
			rev: "r1",
			entries: [{ kind: "user", turn: 0, text: "find my taxes" }],
			history: []
		})
		withSession({ kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL })
		render(<AssistantSidePanel />)

		await showHistory()

		const row = screen.getByRole("button", { name: "find my taxes" })

		expect(row.hasAttribute("disabled")).toBe(true)
		expect(screen.getByRole("button", { name: "New conversation" }).hasAttribute("disabled")).toBe(true)
		expect(screen.getByText("Conversations open once the assistant is ready.")).toBeDefined()

		fireEvent.click(row)
		await settle()

		expect(useAssistantStore.getState().entries).toEqual([])

		fireEvent.click(screen.getByRole("button", { name: "Delete “find my taxes”" }))
		fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }))
		await settle()

		expect(screen.getByText("No saved conversations yet")).toBeDefined()
		expect([...kvStore.keys()].some(key => key.startsWith("assistant.v1.history."))).toBe(false)

		// Closing the list shows the setup screen again.
		await showHistory()

		expect(screen.queryByText("No saved conversations yet")).toBeNull()
	})
})
