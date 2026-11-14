// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import type { AnyFile } from "@filen/sdk-rs"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

// audioEngine (the real singleton) wires real DOM/media-session/kv-persistence side effects on import —
// mocked at this boundary like playlistsScreen.test.ts's playlistPlayback mock, since NowPlayingPanel
// calls its methods directly from click handlers.
const { audioEngine } = vi.hoisted(() => ({
	audioEngine: {
		setShuffleEnabled: vi.fn(),
		setLoopMode: vi.fn(),
		clearQueue: vi.fn(),
		playIndex: vi.fn().mockResolvedValue(undefined),
		removeAt: vi.fn().mockResolvedValue(undefined)
	}
}))

vi.mock("@/features/audio/lib/audioEngine", () => ({ audioEngine }))
vi.mock("@/lib/storage/preference", () => ({
	kvPreference: () => ({ get: () => new Promise(() => undefined), set: () => Promise.resolve() })
}))

const { useAudioStore } = await import("@/features/audio/store/useAudioStore")
const { NowPlayingPanel } = await import("@/features/audio/components/nowPlayingPanel")
const { NOW_PLAYING_CONTROL_CLASS } = await import("@/features/audio/components/queueToggles")
const { useSmoothTransitionsStore } = await import("@/features/audio/store/useSmoothTransitionsStore")
const { DEFAULT_SMOOTH_TRANSITIONS_PREFS } = await import("@/features/audio/lib/smoothTransitions.types")

function track(uuid: string, name: string): QueueTrack {
	return { uuid, name, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
	useSmoothTransitionsStore.setState({ prefs: DEFAULT_SMOOTH_TRANSITIONS_PREFS, unavailable: null })
	useAudioStore.setState({ queue: [], currentIndex: 0, status: "idle", lastError: null, lastErrorTrack: null, coverUrlsByUuid: {} })
})

// The popover's Queue/Playlists tab bar is gone entirely (playlists moved to their
// own /playlists screen, see iconRail.tsx + features/audio/screens/playlists.tsx) — this only ever
// renders the live queue now.
describe("NowPlayingPanel — queue-only popover", () => {
	it("renders no tablist and no Playlists tab", () => {
		useAudioStore.setState({ queue: [track("t1", "one.mp3"), track("t2", "two.mp3")], currentIndex: 0 })

		render(createElement(NowPlayingPanel))

		expect(screen.queryByRole("tablist")).toBeNull()
		expect(screen.queryByRole("tab", { name: "Playlists" })).toBeNull()
		expect(screen.queryByRole("tab", { name: "Queue" })).toBeNull()
	})

	it("renders every queued track, highlighting the current one", () => {
		useAudioStore.setState({ queue: [track("t1", "one.mp3"), track("t2", "two.mp3")], currentIndex: 1 })

		render(createElement(NowPlayingPanel))

		// Each row's accessible name is its leading track-number span plus the title (e.g. "2 two.mp3") —
		// matched loosely since the number itself isn't under test here.
		const current = screen.getByRole("button", { name: /two\.mp3$/ })
		expect(current.getAttribute("aria-current")).toBe("true")
		expect(screen.getByRole("button", { name: /one\.mp3$/ }).getAttribute("aria-current")).toBeNull()
	})

	it("clicking a queued row jumps playback to that index", () => {
		useAudioStore.setState({ queue: [track("t1", "one.mp3"), track("t2", "two.mp3")], currentIndex: 0 })

		render(createElement(NowPlayingPanel))

		fireEvent.click(screen.getByRole("button", { name: /two\.mp3$/ }))

		expect(audioEngine.playIndex).toHaveBeenCalledWith(1)
	})

	it("removing a row targets its current index, also after the queue shifted", () => {
		useAudioStore.setState({ queue: [track("t1", "one.mp3"), track("t2", "two.mp3"), track("t3", "three.mp3")], currentIndex: 0 })

		render(createElement(NowPlayingPanel))

		act(() => {
			useAudioStore.setState({ queue: [track("t1", "one.mp3"), track("t3", "three.mp3")] })
		})

		const removeButtons = screen.getAllByRole("button", { name: "Remove from queue" })
		expect(removeButtons).toHaveLength(2)

		const lastRemove = removeButtons.at(-1)
		expect(lastRemove).toBeDefined()

		if (lastRemove) {
			fireEvent.click(lastRemove)
		}

		expect(audioEngine.removeAt).toHaveBeenCalledWith(1)
		expect(screen.getByRole("button", { name: /three\.mp3$/ }).textContent).toBe("2three.mp3")
	})

	it("moves the highlight and leading slot with the current index, status, error and covers", () => {
		const queue = [track("t1", "one.mp3"), track("t2", "two.mp3")]

		useAudioStore.setState({ queue, currentIndex: 0, status: "loading" })

		const { container } = render(createElement(NowPlayingPanel))
		const rowButton = (name: RegExp) => screen.getByRole("button", { name })

		expect(rowButton(/one\.mp3$/).querySelector("img")).toBeNull()
		expect(rowButton(/two\.mp3$/).textContent).toBe("2two.mp3")

		act(() => {
			useAudioStore.setState({ currentIndex: 1, status: "playing", coverUrlsByUuid: { t1: "blob:cover-1" } })
		})

		expect(rowButton(/one\.mp3$/).getAttribute("aria-current")).toBeNull()
		expect(
			rowButton(/one\.mp3$/)
				.querySelector("img")
				?.getAttribute("src")
		).toBe("blob:cover-1")
		expect(rowButton(/two\.mp3$/).getAttribute("aria-current")).toBe("true")
		expect(container.querySelectorAll("li.bg-muted")).toHaveLength(1)

		act(() => {
			useAudioStore.setState({
				currentIndex: 0,
				lastError: { species: "plain", label: "decode", message: "decode" },
				lastErrorTrack: queue[0] ?? null
			})
		})

		// An error on the failed row wins over its cached cover.
		expect(rowButton(/one\.mp3$/).querySelector("img")).toBeNull()
		expect(rowButton(/one\.mp3$/).querySelector("svg.text-destructive")).not.toBeNull()
		expect(rowButton(/two\.mp3$/).textContent).toBe("2two.mp3")
	})
})

describe("NowPlayingPanel — controls", () => {
	function smoothToggle(): HTMLElement | null {
		return screen.queryByRole("button", { name: "Smooth transitions" })
	}

	it("sizes every control for a coarse pointer the same way", () => {
		useAudioStore.setState({ queue: [track("t1", "one.mp3")], currentIndex: 0 })

		render(createElement(NowPlayingPanel))

		const rowButton = screen.getByRole("button", { name: /one\.mp3$/ })
		const controls = screen.getAllByRole("button").filter(button => button !== rowButton)

		expect(controls.map(button => button.getAttribute("aria-label"))).toEqual([
			"Shuffle",
			"Repeat off",
			"Smooth transitions",
			"Clear queue",
			"Remove from queue"
		])

		for (const control of controls) {
			expect(control.className).toContain(NOW_PLAYING_CONTROL_CLASS)
		}
	})

	it("shows no smooth transitions toggle on a device that can never blend", () => {
		useAudioStore.setState({ queue: [track("t1", "one.mp3")], currentIndex: 0 })
		useSmoothTransitionsStore.setState({ unavailable: "appleMobileGated" })

		render(createElement(NowPlayingPanel))

		expect(smoothToggle()).toBeNull()
		expect(screen.getByRole("button", { name: "Shuffle" })).toBeTruthy()
	})

	it("shows whether tracks blend now, and turns the kept pref off while they can't", () => {
		useAudioStore.setState({ queue: [track("t1", "one.mp3")], currentIndex: 0 })
		useSmoothTransitionsStore.setState({ prefs: { ...DEFAULT_SMOOTH_TRANSITIONS_PREFS, enabled: true } })

		render(createElement(NowPlayingPanel))

		expect(smoothToggle()?.getAttribute("aria-pressed")).toBe("true")

		act(() => {
			useSmoothTransitionsStore.setState({ unavailable: "degraded" })
		})

		expect(smoothToggle()?.getAttribute("aria-pressed")).toBe("false")
		expect(useSmoothTransitionsStore.getState().prefs.enabled).toBe(true)

		fireEvent.click(screen.getByRole("button", { name: "Smooth transitions" }))

		expect(useSmoothTransitionsStore.getState().prefs.enabled).toBe(false)
		expect(smoothToggle()?.getAttribute("aria-disabled")).toBe("true")
	})
})
