import { describe, expect, it, vi } from "vitest"
import type { File } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { isAudioItem } from "@/features/audio/lib/handoff"
import { needsContentSniff } from "@/features/drive/lib/preview.logic"
import { openSniffedAudio, type SniffedOpen } from "@/features/drive/lib/openSniffedAudio"
import { testUuid } from "@/tests/support/uuid"

// A drive `.mod` is a tracker module by its extension alone: opening one reads its head first, so a camcorder's MPEG
// program stream opens in the preview as video rather than failing in the audio player.

function fileNamed(name: string): DriveItem {
	const raw: File = {
		uuid: testUuid(name),
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 24_576n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name, mime: "application/octet-stream", modified: 1_700_000_000_000n, size: 24_576n, key: "key", version: 2 }
		}
	}

	return narrowItem(raw)
}

function opener(read: SniffedOpen["read"]) {
	return {
		read: vi.fn(read),
		record: vi.fn(),
		handOff: vi.fn(),
		openPreview: vi.fn(),
		onReadFailed: vi.fn()
	}
}

describe("opening a drive file that is audio by its extension alone", () => {
	const mod = fileNamed("camcorder.mod")
	const sniff = needsContentSniff(mod)

	it("is such a file, and its head is read", () => {
		expect(isAudioItem(mod)).toBe(true)
		expect(sniff).toBe("mpegPs")
	})

	it("opens a camcorder's program stream in the preview, as video", async () => {
		const open = opener(() => Promise.resolve("mpegPs"))

		await openSniffedAudio(mod, sniff ?? expect.unreachable(), open)

		expect(open.record).toHaveBeenCalledWith("mpegPs")
		expect(open.openPreview).toHaveBeenCalledOnce()
		expect(open.handOff).not.toHaveBeenCalled()
	})

	it("hands a tracker module to the audio player", async () => {
		const open = opener(() => Promise.resolve("notMpegPs"))

		await openSniffedAudio(mod, sniff ?? expect.unreachable(), open)

		expect(open.handOff).toHaveBeenCalledOnce()
		expect(open.openPreview).not.toHaveBeenCalled()
	})

	it("leaves a file whose head could not be read to the preview's own gate, with Retry", async () => {
		const open = opener(() => Promise.reject(new Error("offline")))

		await openSniffedAudio(mod, sniff ?? expect.unreachable(), open)

		expect(open.onReadFailed).toHaveBeenCalledOnce()
		expect(open.openPreview).toHaveBeenCalledOnce()
		expect(open.handOff).not.toHaveBeenCalled()
	})
})
