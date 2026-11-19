import { describe, expect, it } from "vitest"
import { officeChartText } from "@/features/office/lib/chartText"

// The catalog's chart texts as the chart renderer takes them: the series name a "{n}" template it fills in itself.
describe("office chart text", () => {
	it("hands the renderer a series template with its own placeholder and the two titles from the catalog", () => {
		const text = officeChartText()

		expect(text.series).toBe("Series{n}")
		expect(text.series).not.toContain("{{")
		expect(text.chartTitle).toBe("Chart Title")
		expect(text.axisTitle).toBe("Axis Title")
	})
})
