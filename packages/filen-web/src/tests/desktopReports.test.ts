// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"

const app = vi.hoisted(() => ({ setUnloadHolds: vi.fn(), setAudioPlaying: vi.fn() }))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => ({ platform: "linux", app }) }))
vi.mock("@/lib/storage/kvBestEffort", () => ({ kvLoadOnce: () => () => Promise.resolve(), kvSetJsonQuiet: vi.fn() }))

const { holdUnload } = await import("@/lib/unloadGuard")
const { useAudioStore } = await import("@/features/audio/store/useAudioStore")

describe("desktop shell reports", () => {
	it("reports every unload hold count change", () => {
		const releaseFirst = holdUnload()
		const releaseSecond = holdUnload()

		releaseFirst()
		releaseFirst()
		releaseSecond()

		expect(app.setUnloadHolds.mock.calls).toEqual([[1], [2], [1], [0]])
	})

	it("reports audio playback only when it starts or stops", () => {
		const { setStatus } = useAudioStore.getState()

		setStatus("loading")
		setStatus("playing")
		setStatus("paused")
		setStatus("idle")

		expect(app.setAudioPlaying.mock.calls).toEqual([[true], [false]])
	})
})
