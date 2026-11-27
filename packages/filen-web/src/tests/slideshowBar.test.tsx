// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { SlideshowBar } from "@/features/preview/components/slideshowBar"
import type { Slideshow } from "@/features/preview/hooks/useSlideshow"
import { setSlideshowPrefs, slideshowPrefs } from "@/features/preview/lib/slideshowPrefs"
import { i18n } from "@/lib/i18n"

// The slideshow's control bar: what it shows, the preferences it sets, when it hides, and the end.

function makeSlideshow(overrides: Partial<Slideshow> = {}): Slideshow {
	return {
		running: true,
		paused: false,
		position: 12,
		total: 80,
		start: vi.fn(),
		stop: vi.fn(),
		togglePause: vi.fn(),
		go: vi.fn(),
		setMenuOpen: vi.fn(),
		slot: {} as Slideshow["slot"],
		...overrides
	}
}

function renderBar(slideshow: Slideshow, subfolders = { available: false, loading: false }, onSubfoldersChange = vi.fn()) {
	return render(
		<div data-testid="stage">
			<SlideshowBar
				slideshow={slideshow}
				subfolders={subfolders}
				onSubfoldersChange={onSubfoldersChange}
			/>
		</div>
	)
}

function bar(): HTMLElement {
	return screen.getByRole("group", { name: "Slideshow controls" })
}

beforeEach(async () => {
	vi.useFakeTimers()
	await i18n.changeLanguage("en")
	setSlideshowPrefs({ intervalSeconds: 5, shuffle: false, subfolders: false })
})

afterEach(() => {
	cleanup()
	vi.useRealTimers()
})

describe("SlideshowBar", () => {
	it("shows position, interval and toggles", () => {
		renderBar(makeSlideshow())

		expect(screen.getByText("12/80")).toBeTruthy()
		expect(screen.getByRole("button", { name: "Time per image" }).textContent).toBe("5 s")
		expect(screen.getByRole("button", { name: "Shuffle" }).getAttribute("aria-pressed")).toBe("false")
		expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Shuffle" }))

		expect(slideshowPrefs().shuffle).toBe(true)
		expect(screen.getByRole("button", { name: "Shuffle" }).getAttribute("aria-pressed")).toBe("true")
	})

	it("offers Resume while paused and steps", () => {
		const slideshow = makeSlideshow({ paused: true })

		renderBar(slideshow)
		fireEvent.click(screen.getByRole("button", { name: "Resume" }))
		fireEvent.click(screen.getByRole("button", { name: "Next file" }))
		fireEvent.click(screen.getByRole("button", { name: "Previous file" }))

		expect(slideshow.togglePause).toHaveBeenCalledTimes(1)
		expect(slideshow.go).toHaveBeenNthCalledWith(1, 1)
		expect(slideshow.go).toHaveBeenNthCalledWith(2, -1)
	})

	it("the interval menu sets the preference, closes on a pick and reports open/closed", async () => {
		const slideshow = makeSlideshow()
		renderBar(slideshow)
		fireEvent.click(screen.getByRole("button", { name: "Time per image" }))
		await act(async () => {
			await vi.advanceTimersByTimeAsync(50)
		})

		expect(slideshow.setMenuOpen).toHaveBeenLastCalledWith(true)

		fireEvent.click(screen.getByRole("menuitemradio", { name: "10 s" }))
		await act(async () => {
			await vi.advanceTimersByTimeAsync(300)
		})

		expect(slideshowPrefs().intervalSeconds).toBe(10)
		expect(screen.queryByRole("menu")).toBeNull()
		expect(slideshow.setMenuOpen).toHaveBeenLastCalledWith(false)
	})

	it("an Escape closes the interval menu and reports it closed", async () => {
		const slideshow = makeSlideshow()

		renderBar(slideshow)
		fireEvent.click(screen.getByRole("button", { name: "Time per image" }))
		await act(async () => {
			await vi.advanceTimersByTimeAsync(50)
		})
		fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" })
		await act(async () => {
			await vi.advanceTimersByTimeAsync(300)
		})

		expect(screen.queryByRole("menu")).toBeNull()
		expect(slideshow.setMenuOpen).toHaveBeenLastCalledWith(false)
		expect(slideshow.stop).not.toHaveBeenCalled()
	})

	it("sits over the slide: positioned and raised on its stage", () => {
		renderBar(makeSlideshow())

		expect(bar().className).toContain("absolute")
		expect(bar().className).toContain("z-10")
	})

	it("the subfolders toggle shows only when available and disables while loading", () => {
		const onChange = vi.fn()
		const view = renderBar(makeSlideshow())

		expect(screen.queryByRole("button", { name: "Include subdirectories" })).toBeNull()

		view.unmount()
		const loading = renderBar(makeSlideshow(), { available: true, loading: true }, onChange)
		const toggle = screen.getByRole("button", { name: "Include subdirectories" })

		expect((toggle as HTMLButtonElement).disabled).toBe(true)

		loading.unmount()
		renderBar(makeSlideshow(), { available: true, loading: false }, onChange)
		fireEvent.click(screen.getByRole("button", { name: "Include subdirectories" }))

		expect(onChange).toHaveBeenCalledWith(true)
	})

	it("hides after 2.5 s idle and shows on pointer move", () => {
		renderBar(makeSlideshow())
		const stage = screen.getByTestId("stage")

		expect(bar().className).toContain("opacity-100")

		act(() => {
			vi.advanceTimersByTime(2500)
		})

		expect(bar().className).toContain("opacity-0")
		expect(stage.classList.contains("cursor-none")).toBe(true)

		fireEvent.pointerMove(stage)

		expect(bar().className).toContain("opacity-100")
		expect(stage.classList.contains("cursor-none")).toBe(false)
	})

	it("stays while paused", () => {
		renderBar(makeSlideshow({ paused: true }))
		act(() => {
			vi.advanceTimersByTime(5000)
		})

		expect(bar().className).toContain("opacity-100")
	})

	it("✕ stops", () => {
		const slideshow = makeSlideshow()

		renderBar(slideshow)
		fireEvent.click(screen.getByRole("button", { name: "End slideshow" }))

		expect(slideshow.stop).toHaveBeenCalledTimes(1)
	})
})
