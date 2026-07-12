import { describe, expect, it } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { deriveAudioHandoff, isAudioItem } from "@/features/audio/lib/handoff"

// Pure derivation of the drive → audio-engine handoff: given a listing snapshot and the opened item,
// produce the folder's audio-sibling queue (listing order preserved, positioned at the opened track) or
// null when the open must stay inert (trash / non-audio / undecryptable). Fixtures mirror
// preview.logic.test.ts's own mockFile/fileNamed builders — an undecryptable file carries an
// `{type:"encrypted"}` meta, which narrowItem turns into decryptedMeta=null (no name/mime), so it can
// never classify as audio (that is exactly why such a track is never enqueued).

function testUuid(label: string): UuidStr {
	return `${label}-0000-0000-0000-000000000000` as UuidStr
}

function fileNamed(name: string, options: { mime?: string; undecryptable?: boolean } = {}): DriveItem {
	const { mime = "application/octet-stream", undecryptable = false } = options

	const raw: File = {
		uuid: testUuid(name),
		parent: "22222222-2222-2222-2222-222222222222",
		size: 2_048n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: undecryptable
			? { type: "encrypted", data: "ciphertext" }
			: { type: "decoded", data: { name, mime, modified: 1_700_000_000_000n, size: 2_048n, key: "key", version: 2 } }
	}

	return narrowItem(raw)
}

function uuidsOf(tracks: { uuid: string }[]): string[] {
	return tracks.map(track => track.uuid)
}

describe("isAudioItem", () => {
	it("is true for audio extensions, false for other files and directories", () => {
		expect(isAudioItem(fileNamed("song.mp3", { mime: "audio/mpeg" }))).toBe(true)
		expect(isAudioItem(fileNamed("clip.mp4", { mime: "video/mp4" }))).toBe(false)
		expect(isAudioItem(fileNamed("doc.pdf"))).toBe(false)
	})

	it("is false for an undecryptable file (no name/mime to classify)", () => {
		expect(isAudioItem(fileNamed("secret.mp3", { undecryptable: true }))).toBe(false)
	})
})

describe("deriveAudioHandoff", () => {
	it("queues only the folder's audio siblings, in listing order, positioned at the opened track", () => {
		const items = [
			fileNamed("a.mp3", { mime: "audio/mpeg" }),
			fileNamed("photo.jpg", { mime: "image/jpeg" }),
			fileNamed("b.flac", { mime: "audio/flac" }),
			fileNamed("notes.txt", { mime: "text/plain" }),
			fileNamed("c.wav", { mime: "audio/wav" })
		]

		const handoff = deriveAudioHandoff(items, testUuid("b.flac"), false)

		expect(handoff).not.toBeNull()
		expect(uuidsOf(handoff?.tracks ?? [])).toEqual([testUuid("a.mp3"), testUuid("b.flac"), testUuid("c.wav")])
		// Opened track sits at its own index within the audio-only queue, not its index in the mixed folder.
		expect(handoff?.startIndex).toBe(1)
	})

	it("resolves the streamable content-type onto each queued track", () => {
		const handoff = deriveAudioHandoff([fileNamed("a.mp3", { mime: "audio/mpeg" })], testUuid("a.mp3"), false)

		expect(handoff?.tracks[0]?.contentType).toBe("audio/mpeg")
		expect(handoff?.tracks[0]?.name).toBe("a.mp3")
	})

	it("returns null on a trash listing (a trashed track stays non-playable)", () => {
		const items = [fileNamed("a.mp3", { mime: "audio/mpeg" })]

		expect(deriveAudioHandoff(items, testUuid("a.mp3"), true)).toBeNull()
	})

	it("returns null when the opened item is not audio", () => {
		const items = [fileNamed("doc.pdf"), fileNamed("a.mp3", { mime: "audio/mpeg" })]

		expect(deriveAudioHandoff(items, testUuid("doc.pdf"), false)).toBeNull()
	})

	it("returns null when the opened uuid is absent from the snapshot", () => {
		const items = [fileNamed("a.mp3", { mime: "audio/mpeg" })]

		expect(deriveAudioHandoff(items, testUuid("missing.mp3"), false)).toBeNull()
	})

	it("excludes undecryptable files from the queue and never opens on one", () => {
		const items = [
			fileNamed("a.mp3", { mime: "audio/mpeg" }),
			fileNamed("locked.mp3", { undecryptable: true }),
			fileNamed("b.mp3", { mime: "audio/mpeg" })
		]

		const handoff = deriveAudioHandoff(items, testUuid("a.mp3"), false)

		expect(uuidsOf(handoff?.tracks ?? [])).toEqual([testUuid("a.mp3"), testUuid("b.mp3")])
		expect(deriveAudioHandoff(items, testUuid("locked.mp3"), false)).toBeNull()
	})
})
