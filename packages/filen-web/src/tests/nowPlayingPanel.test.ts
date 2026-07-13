// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
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

const { useAudioStore } = await import("@/features/audio/store/useAudioStore")
const { NowPlayingPanel } = await import("@/features/audio/components/nowPlayingPanel")

function track(uuid: string, name: string): QueueTrack {
	return { uuid, name, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
	useAudioStore.setState({ queue: [], currentIndex: 0, status: "idle", lastError: null, coverUrlsByUuid: {} })
})

// The founder decision dropped the popover's Queue/Playlists tab bar entirely (playlists moved to their
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
})
