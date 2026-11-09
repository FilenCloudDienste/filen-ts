// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useImperativeHandle, useRef, useState, type Ref } from "react"
import { slideRef } from "@filen/office/core/presentation"
import {
	createInkStore,
	IDLE_PRESENTATION,
	unavailableShowController,
	type PresentationDocument,
	type PresentationStore,
	type ShowController
} from "@filen/office/react/presentation"
import { ShowMenu, type ShowMenuAt } from "@/features/presentation/components/slideshow/showMenu"
import "@/lib/i18n"

// The slide show's shortcut menu (right click, Shift+F10 or the Menu key in the show): its commands drive the show's
// controller and the presenter's ink, it opens where the stage asks with what the show is at then, gives focus back
// to the stage, and Escape that closes it in full screen (the browser leaves full screen for it) keeps the show.

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
	menu: undefined as ((at: { x: number; y: number; stage: HTMLElement }) => void) | undefined,
	slide: undefined as ((index: number) => void) | undefined,
	listeners: new Map<string, Set<(event: unknown) => void>>()
}))

vi.mock("@filen/office/react/presentation", async importOriginal => {
	const actual = await importOriginal<typeof import("@filen/office/react/presentation")>()

	return {
		...actual,
		SlideShow: ({
			ref,
			onSlide,
			onContextMenu
		}: {
			ref?: Ref<ShowController>
			onSlide?: (index: number) => void
			onContextMenu?: (at: { x: number; y: number; stage: HTMLElement }) => void
		}) => {
			player.menu = onContextMenu
			player.slide = onSlide
			useImperativeHandle(ref, () => ({
				...actual.unavailableShowController(),
				on: (type, listener) => {
					const set = player.listeners.get(type) ?? new Set()

					player.listeners.set(type, set)
					set.add(listener as (event: unknown) => void)

					return () => set.delete(listener as (event: unknown) => void)
				}
			}))

			return (
				<div
					data-fo-show-stage=""
					data-testid="stage"
					tabIndex={-1}
				/>
			)
		}
	}
})

const { useDeckPresentation } = await import("@/features/presentation/hooks/useDeckPresentation")

const SLIDES = [0, 1, 2].map(n => ({ ref: slideRef(700 + n), hidden: n === 2 }))
const deck: PresentationDocument = { ...IDLE_PRESENTATION, status: "ready", slides: SLIDES }

let fullscreen: Element | null = null

Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen })
document.documentElement.requestFullscreen = () => {
	fullscreen = document.documentElement

	return Promise.resolve()
}
document.exitFullscreen = () => {
	fullscreen = null

	return Promise.resolve()
}

afterEach(() => {
	cleanup()
	fullscreen = null
	player.menu = undefined
	player.slide = undefined
	player.listeners.clear()
})

// The controller the menu drives, and its calls.
function controller(): {
	readonly show: ShowController
	readonly calls: Record<"next" | "prev" | "goto" | "black" | "white" | "end", ReturnType<typeof vi.fn>>
} {
	const calls = { next: vi.fn(), prev: vi.fn(), goto: vi.fn(), black: vi.fn(), white: vi.fn(), end: vi.fn() }

	return { show: { ...unavailableShowController(), ...calls }, calls }
}

function openMenu(show: ShowController, at: Partial<ShowMenuAt> = {}, onClose = vi.fn()) {
	const stage = document.createElement("div")

	stage.tabIndex = -1
	document.body.append(stage)

	const ink = createInkStore()

	render(
		<ShowMenu
			at={{ x: 10, y: 20, stage, index: 1, slide: SLIDES[1]?.ref, screen: "slide", ...at }}
			slides={SLIDES}
			controller={() => show}
			ink={ink}
			onClose={onClose}
		/>
	)

	return { stage, ink, onClose }
}

const item = (name: string): HTMLElement => screen.getByRole("menuitem", { name })

async function submenu(name: string): Promise<void> {
	act(() => {
		fireEvent.click(item(name))
	})
	await waitFor(() => {
		expect(screen.getAllByRole("menu").length).toBeGreaterThan(1)
	})
}

describe("the slide show menu", () => {
	it("goes on, back and ends the show", async () => {
		const { show, calls } = controller()

		openMenu(show)
		await waitFor(() => {
			expect(screen.getByRole("menu", { name: "Slide show menu" })).toBeTruthy()
		})
		act(() => {
			fireEvent.click(item("Next"))
		})
		expect(calls.next).toHaveBeenCalledTimes(1)
		cleanup()

		openMenu(show)
		act(() => {
			fireEvent.click(item("Previous"))
		})
		expect(calls.prev).toHaveBeenCalledTimes(1)
		cleanup()

		openMenu(show)
		act(() => {
			fireEvent.click(item("End slide show"))
		})
		expect(calls.end).toHaveBeenCalledTimes(1)
	})

	it("lists every slide, the one on stage checked and hidden ones marked, and goes to the one chosen", async () => {
		const { show, calls } = controller()

		openMenu(show)
		await submenu("See all slides")

		const current = screen.getByRole("menuitemradio", { name: "Slide 2" })

		expect(current.getAttribute("aria-checked")).toBe("true")
		expect(screen.getByRole("menuitemradio", { name: "Slide 3 (hidden)" })).toBeTruthy()
		act(() => {
			fireEvent.click(screen.getByRole("menuitemradio", { name: "Slide 1" }))
		})
		expect(calls.goto).toHaveBeenCalledExactlyOnceWith(0)
	})

	it("turns the black and white screens on and off, showing which is on", async () => {
		const { show, calls } = controller()

		openMenu(show, { screen: "black" })
		await submenu("Screen")
		expect(screen.getByRole("menuitemcheckbox", { name: "Black screen" }).getAttribute("aria-checked")).toBe("true")
		expect(screen.getByRole("menuitemcheckbox", { name: "White screen" }).getAttribute("aria-checked")).toBe("false")
		act(() => {
			fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "White screen" }))
		})
		expect(calls.white).toHaveBeenCalledTimes(1)
		expect(calls.black).not.toHaveBeenCalled()
	})

	it("picks the presenter's pointer and ink tools", async () => {
		const { ink } = openMenu(controller().show)

		await submenu("Pointer options")
		expect(screen.getByRole("menuitemradio", { name: "Arrow" }).getAttribute("aria-checked")).toBe("true")
		act(() => {
			fireEvent.click(screen.getByRole("menuitemradio", { name: "Pen" }))
		})
		expect(ink.getSnapshot().tool).toBe("pen")
	})

	it("gives focus back to the stage and says whether Escape closed it", async () => {
		const stage = document.createElement("div")
		const onClose = vi.fn()

		stage.tabIndex = -1
		document.body.append(stage)

		function Host() {
			const [at, setAt] = useState<ShowMenuAt | undefined>({ x: 0, y: 0, stage, index: 0, slide: SLIDES[0]?.ref, screen: "slide" })

			return (
				<ShowMenu
					at={at}
					slides={SLIDES}
					controller={() => undefined}
					ink={undefined}
					onClose={escaped => {
						onClose(escaped)
						setAt(undefined)
					}}
				/>
			)
		}

		render(<Host />)

		const menu = await screen.findByRole("menu", { name: "Slide show menu" })

		act(() => {
			fireEvent.keyDown(menu, { key: "Escape" })
		})
		expect(onClose).toHaveBeenCalledExactlyOnceWith(true)
		await waitFor(() => {
			expect(document.activeElement).toBe(stage)
		})
	})
})

function Page({ onShow }: { onShow: (start: () => void) => void }) {
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

async function startShow(): Promise<void> {
	let start: () => void = () => undefined

	render(
		<Page
			onShow={value => {
				start = value
			}}
		/>
	)
	await act(async () => {
		start()
		await Promise.resolve()
	})
	expect(fullscreen).not.toBeNull()
}

function leaveFullscreen(): void {
	act(() => {
		fullscreen = null
		document.dispatchEvent(new Event("fullscreenchange"))
	})
}

describe("the slide show menu in the deck's show", () => {
	it("opens where the stage asks, at the slide the show is on", async () => {
		await startShow()

		const stage = screen.getByTestId("stage")

		act(() => {
			player.slide?.(2)
		})
		stage.dataset["foScreen"] = "white"
		act(() => {
			player.menu?.({ x: 5, y: 6, stage })
		})
		await submenu("See all slides")
		expect(screen.getByRole("menuitemradio", { name: "Slide 3 (hidden)" }).getAttribute("aria-checked")).toBe("true")
		await submenu("Screen")
		expect(screen.getByRole("menuitemcheckbox", { name: "White screen" }).getAttribute("aria-checked")).toBe("true")
	})

	it("keeps the show when full screen is left with the menu open, and closes the menu", async () => {
		await startShow()
		act(() => {
			player.menu?.({ x: 5, y: 6, stage: screen.getByTestId("stage") })
		})
		await screen.findByRole("menu", { name: "Slide show menu" })
		leaveFullscreen()
		await waitFor(() => {
			expect(screen.queryByRole("menu")).toBeNull()
		})
		expect(screen.getByTestId("stage")).toBeTruthy()
	})

	it("keeps the show when Escape closed the menu just before full screen was left", async () => {
		await startShow()
		act(() => {
			player.menu?.({ x: 5, y: 6, stage: screen.getByTestId("stage") })
		})
		act(() => {
			fireEvent.keyDown(screen.getByRole("menu", { name: "Slide show menu" }), { key: "Escape" })
		})
		await waitFor(() => {
			expect(screen.queryByRole("menu")).toBeNull()
		})
		leaveFullscreen()
		expect(screen.getByTestId("stage")).toBeTruthy()
	})

	it("ends the show when full screen is left with no menu open", async () => {
		await startShow()
		leaveFullscreen()
		await waitFor(() => {
			expect(screen.queryByTestId("stage")).toBeNull()
		})
	})
})
