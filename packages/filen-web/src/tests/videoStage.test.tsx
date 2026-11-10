// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactElement, type ReactNode } from "react"
import "@/lib/i18n"

const narrow = vi.hoisted(() => ({ value: false }))

vi.mock("@/features/shell/hooks/useIsNarrowViewport", () => ({ useIsNarrowViewport: () => narrow.value }))

import { VideoStage, type VideoStageProps } from "@/components/media/video/videoStage"
import { StageCenterCard, StageNotice } from "@/components/media/video/stageCards"
import { useStagePopupOpen } from "@/components/media/video/stageContext"
import type { VideoKeyAction } from "@/lib/media/videoKeys.logic"

let video: HTMLVideoElement | null = null

function props(overrides: Partial<VideoStageProps> = {}): VideoStageProps {
	return {
		title: "Movie",
		backLabel: "Back",
		onBack: () => undefined,
		videoLabel: "Movie",
		onVideo: element => {
			video = element
		},
		chapters: [],
		cues: null,
		cueOffset: 0,
		loading: false,
		hasNext: false,
		hasPrevious: false,
		trailing: () => null,
		holdControls: false,
		onAction: () => false,
		...overrides
	}
}

// jsdom's media element doesn't play: the stage reads these.
function playing(element: HTMLVideoElement): void {
	Object.defineProperty(element, "paused", { configurable: true, get: () => false })
	Object.defineProperty(element, "readyState", { configurable: true, get: () => 4 })
	Object.defineProperty(element, "duration", { configurable: true, get: () => 600 })
	fireEvent(element, new Event("play"))
}

function stageRoot(): HTMLElement {
	return screen.getByRole("dialog", { name: "Movie" })
}

function controlsHidden(): boolean {
	return stageRoot().className.includes("cursor-none")
}

function startPlaying(): void {
	const element = video

	if (element === null) {
		throw new Error("no video")
	}

	act(() => {
		playing(element)
	})
}

function Popup({ open }: { open: boolean }): ReactElement {
	useStagePopupOpen(open)

	return createElement("span", null, open ? "open" : "closed")
}

beforeEach(() => {
	vi.useFakeTimers()
	narrow.value = false
	video = null
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("VideoStage", () => {
	it("phone: the centre buttons take no pointer while the controls are hidden", () => {
		narrow.value = true
		render(createElement(VideoStage, props()))

		const element = video

		if (element === null) {
			throw new Error("no video")
		}

		act(() => {
			playing(element)
		})

		expect(screen.getAllByRole("button", { name: "Back 10 seconds" })[0]?.className).toContain("pointer-events-auto")

		act(() => {
			vi.advanceTimersByTime(3100)
		})

		expect(screen.getAllByRole("button", { name: "Back 10 seconds" })[0]?.className).toContain("pointer-events-none")
	})

	it("leaves Escape inside a popup to the popup, and takes it on the stage", () => {
		const onAction = vi.fn((_action: VideoKeyAction) => false)
		const onBack = vi.fn()

		render(
			createElement(
				VideoStage,
				props({
					onAction,
					onBack,
					trailing: (): ReactNode =>
						createElement("div", { "data-stage-popup": "" }, createElement("button", { type: "button" }, "inside"))
				})
			)
		)

		fireEvent.keyDown(screen.getByRole("button", { name: "inside" }), { key: "Escape", code: "Escape" })
		expect(onAction).not.toHaveBeenCalled()
		expect(onBack).not.toHaveBeenCalled()

		// Nothing of the caller's is open over the picture: Escape leaves the player.
		fireEvent.keyDown(stageRoot(), { key: "Escape", code: "Escape" })
		expect(onAction).toHaveBeenCalledWith({ type: "dismiss" })
		expect(onBack).toHaveBeenCalledTimes(1)
	})

	it("closes the caller's panel on Escape before the player", () => {
		const onBack = vi.fn()

		render(createElement(VideoStage, props({ onAction: action => action.type === "dismiss", onBack })))

		fireEvent.keyDown(stageRoot(), { key: "Escape", code: "Escape" })
		expect(onBack).not.toHaveBeenCalled()
	})

	it("fires a toggle once for a held key, and leaves a key a text field types", () => {
		const onAction = vi.fn((_action: VideoKeyAction) => true)

		render(
			createElement(
				VideoStage,
				props({
					onAction,
					trailing: (): ReactNode => createElement("input", { "aria-label": "field" })
				})
			)
		)

		fireEvent.keyDown(stageRoot(), { key: "c", code: "KeyC" })
		fireEvent.keyDown(stageRoot(), { key: "c", code: "KeyC", repeat: true })
		expect(onAction).toHaveBeenCalledTimes(1)
		expect(onAction).toHaveBeenCalledWith({ type: "toggleSubtitles" })

		fireEvent.keyDown(screen.getByRole("textbox", { name: "field" }), { key: "c", code: "KeyC" })
		expect(onAction).toHaveBeenCalledTimes(1)
	})

	it("drops a pending coalesced seek when the element is emptied (the next item)", () => {
		render(createElement(VideoStage, props()))

		const element = video

		if (element === null) {
			throw new Error("no video")
		}

		act(() => {
			playing(element)
		})
		element.currentTime = 100

		fireEvent.keyDown(stageRoot(), { key: "l", code: "KeyL" })
		fireEvent.keyDown(stageRoot(), { key: "l", code: "KeyL" })

		const afterFirst = element.currentTime

		fireEvent(element, new Event("emptied"))
		element.currentTime = 0

		act(() => {
			vi.advanceTimersByTime(500)
		})

		expect(afterFirst).toBe(110)
		expect(element.currentTime).toBe(0)
	})

	it("gives the keyboard back to the stage when a card closes", () => {
		const { rerender } = render(
			createElement(
				VideoStage,
				props({
					centerCard: createElement(StageCenterCard, {
						title: "Still watching?",
						onEscape: () => undefined,
						actions: createElement("button", { type: "button", "data-primary": "" }, "Continue")
					})
				})
			)
		)

		act(() => {
			vi.advanceTimersByTime(20)
		})

		expect(document.activeElement?.textContent).toBe("Continue")

		rerender(createElement(VideoStage, props({ centerCard: null })))

		act(() => {
			vi.advanceTimersByTime(50)
		})

		expect(document.activeElement).toBe(stageRoot())
	})

	it("lets the controls hide while the stage itself holds a keyboard focus", () => {
		const { matches } = Object.getOwnPropertyDescriptors(Element.prototype)

		vi.spyOn(Element.prototype, "matches").mockImplementation(function (this: Element, selector: string) {
			return selector === ":focus-visible"
				? true
				: (matches.value as (this: Element, selector: string) => boolean).call(this, selector)
		})

		render(createElement(VideoStage, props({ trailing: () => createElement("button", { type: "button" }, "Tracks") })))
		startPlaying()
		fireEvent.focus(stageRoot())

		act(() => {
			vi.advanceTimersByTime(3100)
		})

		expect(controlsHidden()).toBe(true)

		// A control reached by keyboard holds them.
		fireEvent.focus(screen.getByRole("button", { name: "Tracks" }))
		expect(controlsHidden()).toBe(false)
		vi.restoreAllMocks()
	})

	it("holds the controls while a popup shows, and lets go however it closes", () => {
		const view = render(createElement(VideoStage, props({ trailing: () => createElement(Popup, { open: true }) })))

		startPlaying()
		act(() => {
			vi.advanceTimersByTime(3100)
		})
		expect(controlsHidden()).toBe(false)

		// Closed through its prop (no open-change event).
		view.rerender(createElement(VideoStage, props({ trailing: () => createElement(Popup, { open: false }) })))
		act(() => {
			vi.advanceTimersByTime(3100)
		})
		expect(controlsHidden()).toBe(true)

		view.rerender(createElement(VideoStage, props({ trailing: () => createElement(Popup, { open: true }) })))
		expect(controlsHidden()).toBe(false)

		// Unmounted with the bar when a failure replaces it.
		view.rerender(
			createElement(
				VideoStage,
				props({ trailing: () => createElement(Popup, { open: true }), failure: createElement("p", null, "Failed") })
			)
		)
		act(() => {
			vi.advanceTimersByTime(3100)
		})
		expect(controlsHidden()).toBe(true)
	})

	it("shows notices in a status region that was there before the text", () => {
		const view = render(createElement(VideoStage, props()))
		const region = screen.getByRole("status")

		expect(region.textContent).toBe("")

		view.rerender(createElement(VideoStage, props({ notice: createElement(StageNotice, null, "You're offline") })))
		expect(screen.getByRole("status")).toBe(region)
		expect(region.textContent).toBe("You're offline")
	})

	it("announces through a live region that was there before the text", () => {
		const view = render(createElement(VideoStage, props()))
		const region = stageRoot().querySelector("[aria-live=polite]")

		expect(region?.textContent).toBe("")

		view.rerender(createElement(VideoStage, props({ announcement: "Up next: Episode 2" })))
		expect(stageRoot().querySelector("[aria-live=polite]")).toBe(region)
		expect(region?.textContent).toBe("Up next: Episode 2")
	})
})
