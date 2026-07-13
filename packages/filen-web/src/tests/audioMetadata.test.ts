import { describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import { resolveTrackTags, EMPTY_TRACK_TAGS, type MetadataExtractors, type TrackTags } from "@/features/audio/lib/metadata"
import type { QueueTrack } from "@/features/audio/store/audioQueue"

function track(uuid: string): QueueTrack {
	return { uuid, name: `${uuid}.mp3`, mime: "audio/mpeg", contentType: "audio/mpeg", file: {} as unknown as AnyFile }
}

const tags: TrackTags = { title: "Title", artist: "Artist", album: "Album", picture: null }

function makeExtractors(overrides: Partial<MetadataExtractors> = {}): MetadataExtractors {
	return {
		extractRanged: vi.fn(() => Promise.resolve(tags)),
		extractBuffered: vi.fn(() => Promise.resolve(tags)),
		...overrides
	}
}

describe("resolveTrackTags — dispatch", () => {
	it("routes a stream source through extractRanged with the source url + size, never touching extractBuffered", async () => {
		const extractors = makeExtractors()

		const result = await resolveTrackTags(track("a"), { kind: "stream", url: "/sw/download/a" }, 12_345, extractors)

		expect(result).toEqual(tags)
		expect(extractors.extractRanged).toHaveBeenCalledWith(track("a"), "/sw/download/a", 12_345)
		expect(extractors.extractBuffered).not.toHaveBeenCalled()
	})

	it("routes a blob source through extractBuffered with the blob url, never touching extractRanged", async () => {
		const extractors = makeExtractors()

		const result = await resolveTrackTags(track("a"), { kind: "blob", url: "blob:a" }, 999, extractors)

		expect(result).toEqual(tags)
		expect(extractors.extractBuffered).toHaveBeenCalledWith(track("a"), "blob:a")
		expect(extractors.extractRanged).not.toHaveBeenCalled()
	})

	it("degrades to EMPTY_TRACK_TAGS (filename-only) when the ranged extractor throws — never rejects", async () => {
		const extractors = makeExtractors({ extractRanged: vi.fn(() => Promise.reject(new Error("boom"))) })

		await expect(resolveTrackTags(track("a"), { kind: "stream", url: "u" }, 1, extractors)).resolves.toEqual(EMPTY_TRACK_TAGS)
	})

	it("degrades to EMPTY_TRACK_TAGS when the buffered extractor throws — never rejects", async () => {
		const extractors = makeExtractors({ extractBuffered: vi.fn(() => Promise.reject(new Error("boom"))) })

		await expect(resolveTrackTags(track("a"), { kind: "blob", url: "u" }, 1, extractors)).resolves.toEqual(EMPTY_TRACK_TAGS)
	})
})
