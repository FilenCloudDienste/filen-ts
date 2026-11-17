import { describe, expect, it } from "vitest"
import { isStampPicture } from "@/features/pdf/annotations/stampImage"
import { linkedFileItem } from "@/tests/fixtures/sdk"

describe("isStampPicture", () => {
	it("offers the pictures a browser or a decoder of ours draws, never markup", () => {
		const offered = ["a.png", "b.jpg", "c.heic", "d.qoi", "e.jxl", "f.tif", "g.tiff", "h.svgz", "i.pdf"].map(name =>
			isStampPicture(linkedFileItem(name))
		)

		expect(offered).toEqual([true, true, true, true, true, true, true, false, false])
	})
})
