// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { onlineManager } from "@tanstack/react-query"
import type { PlaylistFile } from "@filen/shared"
import type { TrackMetadataOutcome } from "@/features/audio/lib/trackMetadata"

const { request } = vi.hoisted(() => ({ request: vi.fn() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvEntriesJson: () => Promise.resolve([]),
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/audio/lib/playlists", () => ({ playlistFileTrack: (file: PlaylistFile) => file }))
vi.mock("@/features/audio/lib/trackMetadata", () => ({
	trackMetadata: { request, peekCoverUrl: () => null, loadCoverUrl: () => Promise.resolve(null) }
}))

const { useTrackMetadata } = await import("@/features/audio/hooks/useTrackMetadata")
const { useTrackTagsStore } = await import("@/features/audio/store/useTrackTagsStore")

const file = { uuid: "a" } as unknown as PlaylistFile

function settled(outcome: TrackMetadataOutcome): { promise: Promise<TrackMetadataOutcome>; cancel: () => void } {
	return { promise: Promise.resolve(outcome), cancel: () => undefined }
}

describe("useTrackMetadata", () => {
	afterEach(() => {
		vi.useRealTimers()
		act(() => {
			onlineManager.setOnline(true)
		})
	})

	it("shows skeletons again while a read retried after a reconnect runs", async () => {
		vi.useFakeTimers()
		useTrackTagsStore.setState({ byUuid: {}, hydrated: true })
		onlineManager.setOnline(true)
		request.mockReturnValueOnce(settled({ type: "unavailable" }))

		const { result } = renderHook(() => useTrackMetadata(file))

		expect(result.current.pending).toBe(true)

		await act(async () => {
			await vi.advanceTimersByTimeAsync(150)
		})

		expect(result.current.pending).toBe(false)

		act(() => {
			onlineManager.setOnline(false)
		})
		request.mockReturnValueOnce({ promise: new Promise(() => undefined), cancel: () => undefined })
		act(() => {
			onlineManager.setOnline(true)
		})

		await act(async () => {
			await vi.advanceTimersByTimeAsync(150)
		})

		expect(request).toHaveBeenCalledTimes(2)
		expect(result.current.pending).toBe(true)
	})
})
