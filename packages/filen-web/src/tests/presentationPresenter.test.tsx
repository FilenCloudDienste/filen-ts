// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState, type ReactNode } from "react"
import { slideRef, type DeckOp } from "@filen/office/core/presentation"
import type { CommandResult, PresentationSessionApi } from "@filen/office/dom/presentation"
import {
	DEFAULT_SHOW_BINDINGS,
	IDLE_PRESENTATION,
	unavailableShowController,
	type PresentationDocument,
	type ShowController,
	type ShowEvent
} from "@filen/office/react/presentation"
import { PRESENTER_START, presenterNext, presenterReduce } from "@/features/presentation/components/presenter/presenter.logic"
import { usePresenter, type PresenterSession } from "@/features/presentation/components/presenter/usePresenter"
import { PRESENTATION_SHOW_ACTIONS, presentationShowBindings } from "@/features/presentation/lib/keymap/show"
import { toast } from "sonner"
import "@/lib/i18n"

// The presenter side of the slideshow: its key table, where the show is from the controller's events, the
// presenter view in its popup or (blocked) in this window, keys from either window, and "Keep ink annotations?".

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const slides = [
	{ ref: slideRef(10), hidden: false },
	{ ref: slideRef(11), hidden: true },
	{ ref: slideRef(12), hidden: false }
]

afterEach(() => {
	cleanup()
	vi.restoreAllMocks()
})

describe("show key table", () => {
	it("registers the show's own defaults (the office package's) for every command", () => {
		expect(presentationShowBindings({})).toEqual(DEFAULT_SHOW_BINDINGS)
	})

	it("lists every show command once with PowerPoint's keys, in the editor scope", () => {
		expect(PRESENTATION_SHOW_ACTIONS.map(action => action.id)).toEqual(
			Object.keys(DEFAULT_SHOW_BINDINGS).map(command => `presentation.show.${command}`)
		)
		expect(PRESENTATION_SHOW_ACTIONS.find(action => action.id === "presentation.show.next")?.defaultCombo).toBe(
			"arrowright,arrowdown,pagedown,space,enter,n"
		)
		expect(new Set(PRESENTATION_SHOW_ACTIONS.map(action => action.scope))).toEqual(new Set(["editor"]))
	})

	it("applies the user's overrides to the show's bindings", () => {
		const bindings = presentationShowBindings({ "presentation.show.black": "mod+shift+b" })

		expect(bindings.black).toBe("mod+shift+b")
		expect(bindings.white).toBe(DEFAULT_SHOW_BINDINGS.white)
	})
})

describe("presenter position", () => {
	it("follows the controller's events", () => {
		const events: ShowEvent[] = [
			{ type: "slide", index: 2, slide: slideRef(12), step: 0, steps: 2 },
			{ type: "step", index: 2, step: 1 },
			{ type: "screen", screen: "black" },
			{ type: "ended" }
		]
		const position = events.reduce(presenterReduce, PRESENTER_START)

		expect(position).toMatchObject({ index: 2, step: 1, steps: 2, screen: "black", ended: true })
	})

	it("shows the next animation, then the next visible slide, then the end", () => {
		const at = (index: number, step: number, steps: number) => ({ ...PRESENTER_START, index, step, steps })

		expect(presenterNext(at(0, 0, 1), slides)).toEqual({ kind: "step" })
		expect(presenterNext(at(0, 1, 1), slides)).toEqual({ kind: "slide", index: 2 })
		expect(presenterNext(at(2, 0, 0), slides)).toEqual({ kind: "end" })
		// A custom show's order.
		expect(presenterNext(at(2, 0, 0), slides, [2, 0])).toEqual({ kind: "slide", index: 0 })
	})

	it("the next preview follows the show's next slide when the player tells it", () => {
		const told = presenterReduce(PRESENTER_START, {
			type: "slide",
			index: 0,
			slide: slideRef(10),
			step: 0,
			steps: 0,
			next: 1
		})
		const last = presenterReduce(PRESENTER_START, {
			type: "slide",
			index: 0,
			slide: slideRef(10),
			step: 0,
			steps: 0,
			next: null
		})

		expect(presenterNext(told, slides)).toEqual({ kind: "slide", index: 1 })
		expect(presenterNext(last, slides)).toEqual({ kind: "end" })
	})
})

// A controller that records calls and lets the test emit events.
function testController() {
	const listeners = new Map<string, Set<(event: ShowEvent) => void>>()
	const calls: string[] = []
	const controller: ShowController = {
		...unavailableShowController(),
		next: () => {
			calls.push("next")
		},
		prev: () => {
			calls.push("prev")
		},
		end: () => {
			calls.push("end")
		},
		on: (type, listener) => {
			const set = listeners.get(type) ?? new Set()

			listeners.set(type, set)
			set.add(listener as (event: ShowEvent) => void)

			return () => set.delete(listener as (event: ShowEvent) => void)
		}
	}
	const emit = (event: ShowEvent) => {
		for (const listener of listeners.get(event.type) ?? []) listener(event)
	}

	return { controller, calls, emit }
}

function fakeSession(commands: DeckOp[]): PresentationSessionApi {
	return {
		command: (op: DeckOp): Promise<CommandResult> => {
			commands.push(op)

			return Promise.resolve({ ok: true, revision: 1, dirty: true })
		}
	} as unknown as PresentationSessionApi
}

function deckOf(session?: PresentationSessionApi): PresentationDocument {
	return { ...IDLE_PRESENTATION, status: "ready", slides, ...(session === undefined ? {} : { session }) }
}

function Host({
	deck,
	onSession,
	children
}: {
	deck: PresentationDocument
	onSession: (session: PresenterSession) => void
	children?: ReactNode
}) {
	const [fullscreenActive] = useState(false)
	const presenter = usePresenter({ deck, editable: true, fullscreen: () => Promise.resolve(false), fullscreenActive })

	onSession(presenter)

	return (
		<>
			<div
				data-testid="stage"
				data-fo-show-stage=""
				tabIndex={-1}
				onKeyDown={event => presenter.stageProps.onKey(event)}
			>
				{presenter.stageOverlay}
			</div>
			{presenter.layer}
			{children}
		</>
	)
}

describe("presenter view", () => {
	it("falls back to this window when the popup is blocked, and its keys drive the show", () => {
		vi.spyOn(window, "open").mockReturnValue(null)

		const { controller, calls, emit } = testController()
		let session: PresenterSession | undefined

		render(
			<Host
				deck={deckOf()}
				onSession={value => {
					session = value
				}}
			/>
		)
		act(() => {
			expect(session?.openPresenter()).toBe("sameWindow")
			session?.attach(controller)
			emit({ type: "slide", index: 0, slide: slideRef(10), step: 0, steps: 0 })
		})

		const view = screen.getByRole("region", { name: "Presenter view" })

		// Its notes are a landmark of their own, apart from the editor's notes under it.
		expect(screen.getByRole("region", { name: "Speaker notes" })).toBeTruthy()
		// The preview of what comes next is named apart from the Next button.
		expect(screen.getByRole("region", { name: "Next slide" })).toBeTruthy()
		expect(screen.getByRole("button", { name: "Next" })).toBeTruthy()
		expect(screen.getByText("Slide 1 of 3")).toBeTruthy()
		expect(screen.getByText(/blocked the presenter window/u)).toBeTruthy()
		fireEvent.keyDown(view, { key: "ArrowRight", code: "ArrowRight" })
		fireEvent.click(screen.getByRole("button", { name: "Previous" }))
		expect(calls).toEqual(["next", "prev"])

		// The stage's keys too.
		fireEvent.keyDown(screen.getByTestId("stage"), { key: "PageDown", code: "PageDown" })
		expect(calls).toEqual(["next", "prev", "next"])

		act(() => {
			emit({ type: "slide", index: 2, slide: slideRef(12), step: 0, steps: 0 })
		})
		expect(screen.getByText("Slide 3 of 3")).toBeTruthy()
		expect(screen.getByText("End of slideshow")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Show slideshow" }))
		expect(screen.queryByRole("region", { name: "Presenter view" })).toBeNull()
	})

	it("portals into the popup and closes it when the show ends", () => {
		const popupDocument = document.implementation.createHTMLDocument("")
		const close = vi.fn()
		const popup = {
			document: popupDocument,
			closed: false,
			focus: vi.fn(),
			close,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		}

		vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window)

		const { controller, emit } = testController()
		let session: PresenterSession | undefined

		render(
			<Host
				deck={deckOf()}
				onSession={value => {
					session = value
				}}
			/>
		)
		act(() => {
			expect(session?.openPresenter()).toBe("window")
			session?.attach(controller)
			emit({ type: "slide", index: 0, slide: slideRef(10), step: 0, steps: 1 })
		})
		expect(popupDocument.title).toBe("Presenter view")
		expect(popupDocument.body.textContent).toContain("Next animation on this slide")
		// The audience window waits for its own click to go full screen.
		expect(screen.getByRole("button", { name: "Start slideshow" })).toBeTruthy()
		act(() => {
			emit({ type: "ended" })
		})
		expect(close).toHaveBeenCalled()
	})

	it("asks to keep ink after the show and adds it as one op per slide", async () => {
		const commands: DeckOp[] = []
		const { controller, emit } = testController()
		let session: PresenterSession | undefined

		render(
			<Host
				deck={deckOf(fakeSession(commands))}
				onSession={value => {
					session = value
				}}
			/>
		)
		act(() => {
			session?.attach(controller)
			emit({ type: "slide", index: 0, slide: slideRef(10), step: 0, steps: 0 })
			session?.ink.setTool("pen")
			session?.ink.begin(slideRef(10), 0, 0)
			session?.ink.extend([1000, 1000])
			session?.ink.end()
			emit({ type: "ended" })
		})
		expect(await screen.findByText("Keep ink annotations?")).toBeTruthy()
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Keep" }))
			await Promise.resolve()
		})
		expect(commands).toHaveLength(1)
		expect(commands[0]).toMatchObject({ family: "ink", kind: "add", slide: slideRef(10), name: "Ink annotations" })
		expect(session?.ink.getSnapshot().inked).toBe(false)
	})

	it("keeps the ink of a slide the deck refused, adds the others', and says so", async () => {
		const commands: DeckOp[] = []
		const refusing = {
			command: (op: DeckOp): Promise<CommandResult> => {
				commands.push(op)

				return Promise.resolve(
					op.family === "ink" && op.slide === slideRef(10)
						? ({ ok: false, refusal: { kind: "refused", reason: "tooLarge" } } as unknown as CommandResult)
						: { ok: true, revision: 1, dirty: true }
				)
			}
		} as unknown as PresentationSessionApi
		const { controller, emit } = testController()
		const error = vi.spyOn(toast, "error")
		let session: PresenterSession | undefined

		render(
			<Host
				deck={deckOf(refusing)}
				onSession={value => {
					session = value
				}}
			/>
		)
		act(() => {
			session?.attach(controller)
			session?.ink.setTool("pen")

			for (const slide of [slideRef(10), slideRef(12)]) {
				session?.ink.begin(slide, 0, 0)
				session?.ink.extend([1000, 1000])
				session?.ink.end()
			}

			emit({ type: "ended" })
		})
		await act(async () => {
			fireEvent.click(await screen.findByRole("button", { name: "Keep" }))

			for (let k = 0; k < 5; k++) await Promise.resolve()
		})
		expect(error).toHaveBeenCalledWith("The ink on 1 slide could not be added. It stays for the next slideshow.")
		// Both slides tried, in order; the refused one's ink stays for the next show.
		expect(commands.map(op => (op.family === "ink" ? op.slide : undefined))).toEqual([slideRef(10), slideRef(12)])
		expect(session?.ink.strokes(slideRef(10))).toHaveLength(1)
		expect(session?.ink.strokes(slideRef(12))).toHaveLength(0)
	})

	it("keeps a key pressed in the presenter view from the page under it", () => {
		vi.spyOn(window, "open").mockReturnValue(null)

		const { controller, emit } = testController()
		const page = vi.fn()
		let session: PresenterSession | undefined

		render(
			<div onKeyDown={page}>
				<Host
					deck={deckOf()}
					onSession={value => {
						session = value
					}}
				/>
			</div>
		)
		act(() => {
			session?.openPresenter()
			session?.attach(controller)
			emit({ type: "slide", index: 0, slide: slideRef(10), step: 0, steps: 0 })
		})

		const view = screen.getByRole("region", { name: "Presenter view" })

		for (const [key, code] of [
			["m", "KeyM"],
			["d", "KeyD"],
			["ArrowRight", "ArrowRight"]
		] as const)
			fireEvent.keyDown(view, { key, code, ctrlKey: key !== "ArrowRight" })

		expect(page).not.toHaveBeenCalled()
	})

	it("hands a key that lands on the popup's body to the presenter view", () => {
		const popupDocument = document.implementation.createHTMLDocument("")
		const popup = {
			document: popupDocument,
			closed: false,
			focus: vi.fn(),
			close: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		}

		vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window)

		const { controller, calls, emit } = testController()
		let session: PresenterSession | undefined

		render(
			<Host
				deck={deckOf()}
				onSession={value => {
					session = value
				}}
			/>
		)
		act(() => {
			session?.openPresenter()
			session?.attach(controller)
			emit({ type: "slide", index: 0, slide: slideRef(10), step: 0, steps: 0 })
		})
		act(() => {
			popupDocument.body.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", code: "ArrowRight", bubbles: true }))
		})
		expect(calls).toEqual(["next"])
	})

	it("gives the keys back to the stage when the presenter's popup is closed during the show", () => {
		const gone: (() => void)[] = []
		const popup = {
			document: document.implementation.createHTMLDocument(""),
			closed: false,
			focus: vi.fn(),
			close: vi.fn(),
			addEventListener: (type: string, listener: () => void) => {
				if (type === "pagehide") gone.push(listener)
			},
			removeEventListener: vi.fn()
		}

		vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window)

		const { controller, emit } = testController()
		let session: PresenterSession | undefined

		render(
			<Host
				deck={deckOf()}
				onSession={value => {
					session = value
				}}
			/>
		)
		act(() => {
			session?.openPresenter()
			session?.attach(controller)
			emit({ type: "slide", index: 0, slide: slideRef(10), step: 0, steps: 0 })
		})
		act(() => {
			popup.closed = true

			for (const listener of gone) listener()
		})
		expect(document.activeElement).toBe(screen.getByTestId("stage"))
	})
})
