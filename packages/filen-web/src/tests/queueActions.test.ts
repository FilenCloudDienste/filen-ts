import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import type { Playlist } from "@filen/shared"
import "@/lib/i18n"
import type { QueueSnapshot, QueueTrack } from "@/features/audio/store/audioQueue"

const { audioEngine, toast } = vi.hoisted(() => ({
	audioEngine: {
		enqueue: vi.fn<(tracks: readonly QueueTrack[], placement: "next" | "end") => number>(),
		queueSnapshot: vi.fn<() => QueueSnapshot | null>(),
		clearQueue: vi.fn(),
		restoreQueue: vi.fn<(snapshot: QueueSnapshot) => Promise<void>>().mockResolvedValue(undefined)
	},
	toast: Object.assign(vi.fn(), { success: vi.fn(), info: vi.fn(), error: vi.fn() })
}))

vi.mock("@/features/audio/lib/audioEngine", () => ({ audioEngine }))
vi.mock("sonner", () => ({ toast }))

import { clearQueueWithUndo, queueDriveSongs, queuePlaylist, queueTracks } from "@/features/audio/lib/queueActions"
import { mockDirItem, ownedFileItem } from "@/tests/fixtures/sdk"
import { testUuid } from "@/tests/support/uuid"

function track(uuid: string): QueueTrack {
	return { uuid, name: uuid, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("queueTracks", () => {
	it("says how many tracks play next or joined the queue", () => {
		audioEngine.enqueue.mockReturnValueOnce(2).mockReturnValueOnce(1)

		queueTracks([track("a"), track("b")], "next")
		queueTracks([track("c")], "end")

		expect(toast.success).toHaveBeenNthCalledWith(1, "2 tracks play next")
		expect(toast.success).toHaveBeenNthCalledWith(2, "Added 1 track to the queue")
	})

	it("says so when nothing new went in", () => {
		audioEngine.enqueue.mockReturnValueOnce(0)

		queueTracks([track("a")], "next")

		expect(toast.info).toHaveBeenCalledOnce()
		expect(toast.success).not.toHaveBeenCalled()
	})

	it("does nothing for no tracks", () => {
		queueTracks([], "end")

		expect(audioEngine.enqueue).not.toHaveBeenCalled()
	})
})

describe("queueDriveSongs", () => {
	it("queues the songs of a drive selection, in order, skipping everything else", () => {
		audioEngine.enqueue.mockReturnValueOnce(2)

		queueDriveSongs(
			[
				ownedFileItem("b.mp3", "audio/mpeg", { uuid: testUuid("b") }),
				ownedFileItem("report.pdf", "application/pdf", { uuid: testUuid("report") }),
				mockDirItem({ uuid: testUuid("dir") }),
				ownedFileItem("a.flac", "audio/flac", { uuid: testUuid("a") })
			],
			"end"
		)

		const [tracks, placement] = audioEngine.enqueue.mock.calls[0] ?? []

		expect(tracks?.map(entry => entry.uuid)).toEqual([testUuid("b"), testUuid("a")])
		expect(placement).toBe("end")
	})
})

describe("queuePlaylist", () => {
	it("queues every track of the playlist", () => {
		audioEngine.enqueue.mockReturnValueOnce(0)

		queuePlaylist({ uuid: testUuid("p"), name: "Mix", files: [] } as unknown as Playlist, "next")

		expect(audioEngine.enqueue).not.toHaveBeenCalled()
	})
})

describe("clearQueueWithUndo", () => {
	it("clears, then restores the snapshot from the toast's Undo", () => {
		const snapshot: QueueSnapshot = { queue: [track("a")], currentIndex: 0, shuffleOrder: [], positionMs: 5_000, playing: true }

		audioEngine.queueSnapshot.mockReturnValueOnce(snapshot)

		clearQueueWithUndo()

		expect(audioEngine.clearQueue).toHaveBeenCalledOnce()
		expect(toast).toHaveBeenCalledOnce()

		const options = toast.mock.calls[0]?.[1] as { action: { label: string; onClick: () => void } } | undefined

		expect(toast.mock.calls[0]?.[0]).toBe("Queue cleared")
		expect(options?.action.label).toBe("Undo")
		options?.action.onClick()
		expect(audioEngine.restoreQueue).toHaveBeenCalledExactlyOnceWith(snapshot)
	})

	it("offers no undo for an empty queue", () => {
		audioEngine.queueSnapshot.mockReturnValueOnce(null)

		clearQueueWithUndo()

		expect(audioEngine.clearQueue).toHaveBeenCalledOnce()
		expect(toast).not.toHaveBeenCalled()
	})
})
