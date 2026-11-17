// @vitest-environment jsdom

import { describe, expect, it } from "vitest"
import { sanitizePdfMathML } from "@/features/preview/lib/pdfMathSanitizer"

describe("sanitizePdfMathML", () => {
	it("keeps a formula's MathML and drops ids, links, styles and anything not MathML", () => {
		const fragment = sanitizePdfMathML(
			'<math id="fo-pdf-0-1-s0"><mi href="https://example.com" style="color:red" xlink:href="#x">x</mi><mo>+</mo><script>alert(1)</script><a href="https://example.com">y</a></math>'
		)
		const holder = document.createElement("div")

		holder.append(fragment ?? "")

		expect(holder.querySelector("math mi")?.textContent).toBe("x")
		expect(holder.querySelector("[id]")).toBeNull()
		expect(holder.querySelector("[href]")).toBeNull()
		expect(holder.querySelector("[style]")).toBeNull()
		expect(holder.innerHTML).not.toContain("script")
		expect(holder.innerHTML).not.toContain("example.com")
	})
})
