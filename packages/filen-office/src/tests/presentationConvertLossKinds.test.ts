import { describe, expect, it } from "vitest"
import { ConversionReport, noteFresh } from "../core/convert/presentation/index"

// What a Save as ODP reports by kind: each thing the ODP writer writes in a nearer form or leaves out is counted under
// the loss the user is told about.

describe("the losses a Save as ODP reports", () => {
	it("counts a paragraph's outline level as an outline level, not as a shape's outline", () => {
		const report = new ConversionReport()

		noteFresh(report, {
			approximated: { "outline level of a paragraph without a bullet": 3, "outline unread": 1 },
			omitted: {}
		})

		expect(report.losses()).toEqual([
			{ kind: "geometry", count: 1 },
			{ kind: "outlineLevel", count: 3 }
		])
	})
})
