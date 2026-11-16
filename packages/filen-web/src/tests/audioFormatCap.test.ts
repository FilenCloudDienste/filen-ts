import { describe, expect, it, vi } from "vitest"
import { narrowItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"

const MIB = 1024n * 1024n

// A fixture row as a synthesized format adds it: the open gate honours a format cap below its category's.
vi.mock("@filen/shared", async importOriginal => {
	const actual = await importOriginal<typeof import("@filen/shared")>()

	return { ...actual, AUDIO_FORMATS: new Map([...actual.AUDIO_FORMATS, ["mid", { synth: "midi", cap: 4_194_304n }]]) }
})

const { canPreview, previewCategoryForExtension } = await import("@/features/drive/lib/preview.logic")

function midi(size: bigint) {
	return narrowItem({
		uuid: testUuid(`song.mid:${String(size)}`),
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name: "song.mid", mime: "audio/midi", modified: 1_700_000_000_000n, size, key: "key", version: 2 }
		}
	})
}

describe("an audio format cap", () => {
	it("routes the row to audio and refuses a file above its cap, though audio streams uncapped", () => {
		expect(previewCategoryForExtension("mid")).toBe("audio")
		expect(canPreview(midi(4n * MIB))).toBe(true)
		expect(canPreview(midi(5n * MIB))).toBe(false)
	})
})
