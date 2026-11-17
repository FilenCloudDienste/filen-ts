// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"

// A synthesized song's preview plays its decoded stream alone: where that breaks, Retry opens it again, never
// MediaSource, which has no route for it.

const mocks = vi.hoisted(() => ({
	openDecodedAudioStream: vi.fn(() => Promise.resolve({ url: "/sw/preview/song.wav", info: {}, release: vi.fn() })),
	audioMediaSource: vi.fn()
}))

vi.mock("@/lib/media/playback/audioStream", () => mocks)
vi.mock("@/features/preview/lib/previewStream", () => ({
	isMediaStreamAvailable: () => true,
	previewStreamUrl: vi.fn(),
	releasePreviewStream: vi.fn(),
	releasePreviewStreamSoon: vi.fn(),
	holdPreviewStream: vi.fn(),
	holdPreviewStreamAlive: () => () => undefined
}))
vi.mock("@/lib/media/mediaVolume", async importOriginal => ({
	...(await importOriginal<typeof import("@/lib/media/mediaVolume")>()),
	warmMediaVolume: () => Promise.resolve()
}))

const { MediaViewer } = await import("@/features/preview/components/mediaViewer")
const { linkedFileItem } = await import("@/tests/fixtures/sdk")

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("a synthesized song's preview", () => {
	it("plays the decoded stream, and opens it again on Retry when it breaks rather than MediaSource", async () => {
		vi.stubGlobal("MediaSource", { isTypeSupported: () => true })

		const { container } = render(createElement(MediaViewer, { item: linkedFileItem("song.mid"), category: "audio", alt: "a" }))

		await waitFor(() => {
			expect(mocks.openDecodedAudioStream).toHaveBeenCalledOnce()
		})
		expect(mocks.openDecodedAudioStream).toHaveBeenLastCalledWith(expect.objectContaining({ synth: "midi" }))

		const audio = await waitFor(() => container.querySelector("audio") ?? expect.unreachable())

		fireEvent.error(audio)
		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))

		await waitFor(() => {
			expect(mocks.openDecodedAudioStream).toHaveBeenCalledTimes(2)
		})
		expect(mocks.audioMediaSource).not.toHaveBeenCalled()
		vi.unstubAllGlobals()
	})
})
