import { describe, expect, it } from "vitest"
import { isStampPicture, STAMP_FILE_ACCEPT } from "@/features/pdf/annotations/stampImage"
import { linkedFileItem } from "@/tests/fixtures/sdk"

describe("isStampPicture", () => {
	it("offers the pictures a browser or a decoder of ours draws, never markup", () => {
		const offered = ["a.png", "b.jpg", "c.heic", "d.qoi", "e.jxl", "f.tif", "g.tiff", "h.svgz", "i.pdf", "j.psd", "k.psb"].map(name =>
			isStampPicture(linkedFileItem(name))
		)

		expect(offered).toEqual([true, true, true, true, true, true, true, false, false, true, false])
	})

	it("lets the device picker offer every format the stamp decodes, never a gzipped SVG", () => {
		const accepted = STAMP_FILE_ACCEPT.split(",")

		expect(accepted).toEqual(expect.arrayContaining(["image/*", ".heic", ".hif", ".qoi", ".jxl", ".tif", ".tiff", ".psd"]))
		expect(accepted).not.toContain(".svgz")
		expect(accepted).not.toContain(".psb")
	})
})
