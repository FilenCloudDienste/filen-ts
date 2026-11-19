import { describe, expect, it } from "vitest"
import { svgRootStart } from "@filen/shared/svgProlog"

describe("svgRootStart", () => {
	it("finds the root past the declaration, comments, processing instructions and a byte order mark", () => {
		const text = '﻿<?xml version="1.0"?>\n<!-- made by hand --><?pi x?> <svg width="1"/>'

		expect(svgRootStart(text)).toBe(text.indexOf("<svg"))
	})

	it("refuses a DOCTYPE whose subset could expand, judged over the whole subset", () => {
		expect(svgRootStart('<!DOCTYPE svg [<!ENTITY a "x"><!ENTITY b "&a;&a;">]><svg/>')).toBe("unsafe")
		expect(svgRootStart('<!DOCTYPE svg [<!ENTITY a "]>"><!ENTITY % p "x">]><svg/>')).toBe("unsafe")
		expect(svgRootStart('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>')).toBe("unsafe")
		expect(svgRootStart('<!DOCTYPE svg [<!-- ]> --><!ENTITY b "&#38;">]><svg/>')).toBe("unsafe")
	})

	it("takes plain string entities and a DOCTYPE without a subset", () => {
		const illustrator = '<!DOCTYPE svg [<!ENTITY ns_svg "http://www.w3.org/2000/svg">]><svg/>'
		const plain = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg/>'

		expect(svgRootStart(illustrator)).toBe(illustrator.indexOf("<svg"))
		expect(svgRootStart(plain)).toBe(plain.indexOf("<svg"))
	})

	it("calls a prolog that never ends corrupt", () => {
		expect(svgRootStart('<!DOCTYPE svg [<!ENTITY a "<svg">')).toBe("corrupt")
		expect(svgRootStart("<?xml version")).toBe("corrupt")
		expect(svgRootStart("<!-- open")).toBe("corrupt")
	})
})
