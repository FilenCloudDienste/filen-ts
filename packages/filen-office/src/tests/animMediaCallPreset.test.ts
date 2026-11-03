import { describe, expect, it } from "vitest"
import { presetFromOdf, presetToOdf } from "../core/anim/odf"

// A media "Play" effect (presetClass mediacall, presetID 1, PowerPoint's media-play preset) keeps its preset across an
// ODP conversion: written under the name LibreOffice 7.5 reads it as ("ppt_mediacall_1", its oracle tree of the
// corpus's sound.ppt), and read back as the same ECMA preset.

describe("a media-play effect's preset", () => {
	it("is written as LibreOffice names it and read back", () => {
		expect(presetToOdf("mediacall", 1, 0)).toEqual({ id: "ppt_mediacall_1" })
		expect(presetFromOdf("ppt_mediacall_1", undefined)).toMatchObject({ presetClass: "mediacall", id: 1 })
	})
})
