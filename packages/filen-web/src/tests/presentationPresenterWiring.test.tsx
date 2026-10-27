// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import { useImperativeHandle, useState, type Ref } from "react"
import { slideRef } from "@filen/office/core/presentation"
import {
	IDLE_PRESENTATION,
	type PresentationDocument,
	type PresentationStore,
	type ShowController,
	type ShowEvent
} from "@filen/office/react/presentation"
import "@/lib/i18n"

// The presenter side wired to the stage through DeckSlideShow, as the deck's show layer does it: the player's ref
// handle (a new one on every render), and the stage going away without an "ended" event (full screen left).

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))

const listeners = vi.hoisted(() => new Map<string, Set<(event: unknown) => void>>())

vi.mock("@filen/office/react/presentation", async importOriginal => {
	const actual = await importOriginal<typeof import("@filen/office/react/presentation")>()
	const controller: ShowController = {
		...actual.unavailableShowController(),
		on: (type, listener) => {
			const set = listeners.get(type) ?? new Set()

			listeners.set(type, set)
			set.add(listener as (event: unknown) => void)

			return () => set.delete(listener as (event: unknown) => void)
		}
	}

	return {
		...actual,
		// A new handle on every render, as a player whose handle has no deps gives.
		SlideShow: ({ ref }: { ref?: Ref<ShowController> }) => {
			useImperativeHandle(ref, () => ({ ...controller }))

			return null
		}
	}
})

const { usePresenter } = await import("@/features/presentation/components/presenter/usePresenter")
const { DeckSlideShow } = await import("@/features/presentation/components/slideshow/deckSlideShow")

const deck: PresentationDocument = {
	...IDLE_PRESENTATION,
	status: "ready",
	slides: [
		{ ref: slideRef(10), hidden: false },
		{ ref: slideRef(11), hidden: false }
	]
}
const store = {} as PresentationStore

interface Handles {
	readonly rerender: () => void
	readonly setShowing: (on: boolean) => void
	readonly presenter: ReturnType<typeof usePresenter>
}

function Host({ onRender }: { onRender: (handles: Handles) => void }) {
	const [, setTick] = useState(0)
	const [showing, setShowing] = useState(true)
	const presenter = usePresenter({ deck, editable: true, fullscreen: () => Promise.resolve(true), fullscreenActive: true })

	onRender({
		rerender: () => {
			setTick(tick => tick + 1)
		},
		setShowing,
		presenter
	})

	return (
		<>
			{showing ? (
				<DeckSlideShow
					store={store}
					deck={deck}
					from={{ index: 0 }}
					policy={{ link: { allow: () => true, open: () => undefined } }}
					onSlide={() => undefined}
					onEnd={() => undefined}
					controllerRef={presenter.attach}
					overlay={presenter.stageOverlay}
					onKey={presenter.stageProps.onKey}
					onPointer={presenter.stageProps.onPointer}
				/>
			) : null}
			{presenter.layer}
		</>
	)
}

afterEach(() => {
	cleanup()
	listeners.clear()
	vi.restoreAllMocks()
})

function emitSlide(): void {
	const event: ShowEvent = { type: "slide", index: 0, slide: slideRef(10), step: 0, steps: 0 }

	for (const listener of listeners.get("slide") ?? []) listener(event)
}

describe("presenter wiring through the deck's stage", () => {
	it("keeps one set of show listeners however often the stage renders", () => {
		let handles: Handles | undefined

		render(
			<Host
				onRender={value => {
					handles = value
				}}
			/>
		)

		for (let k = 0; k < 20; k++)
			act(() => {
				handles?.rerender()
			})

		expect(listeners.get("slide")?.size ?? 0).toBe(1)
	})

	it("ends the presenter side when the stage goes away without an ended event", async () => {
		const close = vi.fn()

		vi.spyOn(window, "open").mockReturnValue({
			document: document.implementation.createHTMLDocument(""),
			closed: false,
			focus: vi.fn(),
			close,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn()
		} as unknown as Window)
		let handles: Handles | undefined

		render(
			<Host
				onRender={value => {
					handles = value
				}}
			/>
		)
		act(() => {
			handles?.presenter.openPresenter()
		})
		act(() => {
			emitSlide()
		})
		act(() => {
			handles?.setShowing(false)
		})
		await act(async () => {
			await Promise.resolve()
			await Promise.resolve()
		})
		expect(close).toHaveBeenCalled()
		expect(listeners.get("slide")?.size ?? 0).toBe(0)
	})
})
