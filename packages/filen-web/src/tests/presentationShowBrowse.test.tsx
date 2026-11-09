// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useImperativeHandle, useRef, type KeyboardEvent, type ReactNode, type Ref } from "react"
import { slideRef, type ShowSettings } from "@filen/office/core/presentation"
import {
	DEFAULT_SHOW_OPTIONS,
	IDLE_PRESENTATION,
	type PresentationDocument,
	type PresentationStore,
	type ShowBarState,
	type ShowController
} from "@filen/office/react/presentation"
import { setUpForm, setUpOptions, showSettingsOf } from "@/features/presentation/components/slideshow/setUpDialog.logic"
import "@/lib/i18n"

// A show browsed by an individual: it runs in the page's window (never full screen on its own) over PowerPoint's
// status bar, whose counter, Previous, Next and menu (Go to slide, Full screen, End show) drive the show; leaving
// full screen goes back to the window, and Escape in full screen leaves it before it ends the show. Other show types
// still go full screen and carry no bar.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/lib/trustedLinks/trustedDomainsQuery", () => ({
	useTrustedDomainsQuery: () => ({ data: new Set<string>(), refetch: () => Promise.resolve() })
}))
vi.mock("@/lib/media/fullscreen", () => ({ fullscreenSupported: () => true }))
vi.mock("@/features/presentation/components/slideshow/setUpHost", () => ({ SetUpShowHost: () => null }))

const player = vi.hoisted(() => ({
	calls: {} as Record<"next" | "prev" | "goto" | "end", (...args: unknown[]) => void>,
	onKey: undefined as ((event: KeyboardEvent<HTMLDivElement>) => boolean) | undefined
}))

vi.mock("@filen/office/react/presentation", async importOriginal => {
	const actual = await importOriginal<typeof import("@filen/office/react/presentation")>()

	return {
		...actual,
		SlideShow: ({
			ref,
			onKey,
			statusBar
		}: {
			ref?: Ref<ShowController>
			onKey?: (event: KeyboardEvent<HTMLDivElement>) => boolean
			statusBar?: (state: ShowBarState) => ReactNode
		}) => {
			player.onKey = onKey
			useImperativeHandle(ref, () => ({ ...actual.unavailableShowController(), ...player.calls }))

			return (
				<div
					data-fo-show-stage=""
					data-testid="stage"
					tabIndex={-1}
				>
					{statusBar?.({ index: 1, screen: "slide" })}
				</div>
			)
		}
	}
})

const { useDeckPresentation } = await import("@/features/presentation/hooks/useDeckPresentation")

const SLIDES = [0, 1, 2].map(n => ({ ref: slideRef(800 + n), hidden: n === 2 }))
const SHOW: ShowSettings = {
	kind: "browse",
	loop: false,
	showNarration: true,
	showAnimation: true,
	useTimings: true,
	range: { kind: "all" }
}

function deckOf(show: ShowSettings): PresentationDocument {
	return {
		...IDLE_PRESENTATION,
		status: "ready",
		slides: SLIDES,
		info: { slides: SLIDES, size: { cx: 9144000, cy: 6858000 }, customShows: [], show }
	} as unknown as PresentationDocument
}

let fullscreen: Element | null = null

Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen })
document.documentElement.requestFullscreen = () => {
	fullscreen = document.documentElement
	document.dispatchEvent(new Event("fullscreenchange"))

	return Promise.resolve()
}
document.exitFullscreen = () => {
	fullscreen = null
	document.dispatchEvent(new Event("fullscreenchange"))

	return Promise.resolve()
}

afterEach(() => {
	cleanup()
	fullscreen = null
	player.onKey = undefined
})

function Page({ deck, onShow }: { deck: PresentationDocument; onShow: (start: () => void) => void }) {
	const focusSlide = useRef<HTMLElement | null>(null)
	const show = useDeckPresentation({
		store: { setWindow: () => undefined } as unknown as PresentationStore,
		deck,
		index: 0,
		go: () => undefined,
		focusSlide
	})

	onShow(show.startShow)

	return <>{show.layer}</>
}

async function startShow(show: ShowSettings = SHOW) {
	const calls = { next: vi.fn(), prev: vi.fn(), goto: vi.fn(), end: vi.fn() }
	let start: () => void = () => undefined

	player.calls = calls
	render(
		<Page
			deck={deckOf(show)}
			onShow={value => {
				start = value
			}}
		/>
	)
	await act(async () => {
		start()
		await Promise.resolve()
	})

	return calls
}

function escape(): { readonly consumed: boolean; readonly prevented: boolean } {
	let prevented = false
	let consumed = false

	act(() => {
		consumed =
			player.onKey?.({
				key: "Escape",
				code: "Escape",
				shiftKey: false,
				ctrlKey: false,
				metaKey: false,
				altKey: false,
				repeat: false,
				preventDefault: () => {
					prevented = true
				},
				stopPropagation: () => undefined
			} as unknown as KeyboardEvent<HTMLDivElement>) ?? false
	})

	return { consumed, prevented }
}

function bar(): HTMLElement {
	return screen.getByRole("toolbar", { name: "Slide show status bar" })
}

async function openMenu(): Promise<HTMLElement> {
	// The last one has closed.
	await waitFor(() => {
		expect(screen.queryByRole("menu")).toBeNull()
	})
	act(() => {
		fireEvent.click(within(bar()).getByRole("button", { name: "Menu" }))
	})

	return screen.findByRole("menu")
}

describe("a show browsed by an individual", () => {
	it("runs in the window with the status bar: the slide counter, Previous and Next", async () => {
		const calls = await startShow()

		expect(fullscreen).toBeNull()
		expect(within(bar()).getByText("Slide 2 of 3")).toBeTruthy()
		act(() => {
			fireEvent.click(within(bar()).getByRole("button", { name: "Next" }))
		})
		act(() => {
			fireEvent.click(within(bar()).getByRole("button", { name: "Previous" }))
		})
		expect(calls.next).toHaveBeenCalledTimes(1)
		expect(calls.prev).toHaveBeenCalledTimes(1)
	})

	it("goes to a slide from the menu and ends the show from it", async () => {
		const calls = await startShow()

		await openMenu()
		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Go to slide" }))
		})
		await waitFor(() => {
			expect(screen.getByRole("menuitemradio", { name: "Slide 2" }).getAttribute("aria-checked")).toBe("true")
		})
		expect(screen.getByRole("menuitemradio", { name: "Slide 3 (hidden)" })).toBeTruthy()
		act(() => {
			fireEvent.click(screen.getByRole("menuitemradio", { name: "Slide 1" }))
		})
		expect(calls.goto).toHaveBeenCalledExactlyOnceWith(0)
		await openMenu()
		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "End slide show" }))
		})
		expect(calls.end).toHaveBeenCalledTimes(1)
	})

	it("goes full screen from the menu; Escape there and leaving it go back to the window, Escape in it ends", async () => {
		const calls = await startShow()
		await openMenu()

		const item = screen.getByRole("menuitemcheckbox", { name: "Full screen" })

		expect(item.getAttribute("aria-checked")).toBe("false")
		await act(async () => {
			fireEvent.click(item)
			await Promise.resolve()
		})
		expect(fullscreen).not.toBeNull()
		expect(escape()).toEqual({ consumed: true, prevented: true })
		expect(fullscreen).toBeNull()
		expect(screen.getByTestId("stage")).toBeTruthy()
		expect(calls.end).not.toHaveBeenCalled()

		await openMenu()
		await act(async () => {
			fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Full screen" }))
			await Promise.resolve()
		})
		// The browser's own Escape (Firefox, Safari) leaves full screen: the show stays, in its window.
		act(() => {
			fullscreen = null
			document.dispatchEvent(new Event("fullscreenchange"))
		})
		expect(screen.getByTestId("stage")).toBeTruthy()
		// In the window Escape is the show's: it ends.
		escape()
		expect(calls.end).toHaveBeenCalledTimes(1)
	})

	it("leaves a speaker's show full screen, with no status bar", async () => {
		await startShow({ ...SHOW, kind: "present" })

		expect(fullscreen).not.toBeNull()
		expect(screen.queryByRole("toolbar", { name: "Slide show status bar" })).toBeNull()
		act(() => {
			fullscreen = null
			document.dispatchEvent(new Event("fullscreenchange"))
		})
		await waitFor(() => {
			expect(screen.queryByTestId("stage")).toBeNull()
		})
	})
})

describe("Set Up Slide Show's browsed show type", () => {
	it("keeps browsed by an individual through the form and saves it as p:browse", () => {
		const browsed = { ...DEFAULT_SHOW_OPTIONS, browse: true }

		expect(setUpForm(browsed, 3)).toMatchObject({ browse: true, kiosk: false })
		expect(setUpOptions(setUpForm(browsed, 3))).toEqual(browsed)
		expect(showSettingsOf(browsed, undefined).kind).toBe("browse")
		// A kiosk is never browsed; a speaker's show leaves a browsed file's type.
		expect(setUpOptions({ ...setUpForm(browsed, 3), kiosk: true }).browse).toBeUndefined()
		expect(showSettingsOf(DEFAULT_SHOW_OPTIONS, SHOW).kind).toBe("present")
	})
})
