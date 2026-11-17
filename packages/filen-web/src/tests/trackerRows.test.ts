import { describe, expect, it } from "vitest"
import { AUDIO_FORMATS, TRACKER_COLLISIONS, mimeForExtension } from "@filen/shared"
import extensions from "@/vendor/libopenmpt/extensions.json"
import { previewCategoryForExtension } from "@/features/drive/lib/preview.logic"

describe("tracker module rows", () => {
	it("are every extension the built libopenmpt reads, in its order, but the collisions", () => {
		const rows = [...AUDIO_FORMATS].filter(([, format]) => format.synth === "module").map(([extension]) => extension)

		expect(rows).toEqual(extensions.filter(extension => !TRACKER_COLLISIONS.has(extension)))
		expect([...TRACKER_COLLISIONS].every(extension => extensions.includes(extension))).toBe(true)
	})

	it("take no extension another row gives a meaning", () => {
		const claimed = extensions.filter(
			extension =>
				!TRACKER_COLLISIONS.has(extension) &&
				(mimeForExtension(extension) !== null || (previewCategoryForExtension(extension) ?? "audio") !== "audio")
		)

		expect(claimed).toEqual([])
	})

	it("cap modules at 32 MiB and MIDI songs at 4 MiB", () => {
		expect(AUDIO_FORMATS.get("xm")).toEqual({ synth: "module", cap: 32n * 1024n * 1024n })
		expect(AUDIO_FORMATS.get("rmi")).toEqual({ synth: "midi", cap: 4n * 1024n * 1024n })
	})
})
