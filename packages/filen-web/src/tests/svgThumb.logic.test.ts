import { describe, expect, it } from "vitest"
import { prepareSvgThumb, type SvgThumbSource } from "@/features/drive/lib/svgThumb.logic"

const MAX = 384

function prepared(text: string): Extract<SvgThumbSource, { type: "ok" }> {
	const result = prepareSvgThumb(text, MAX)

	if (result.type !== "ok") {
		throw new Error(`expected a prepared svg, got ${result.reason}`)
	}

	return result
}

function rootTag(markup: string): string {
	const start = markup.indexOf("<svg")

	return markup.slice(start, markup.indexOf(">", start) + 1)
}

describe("prepareSvgThumb — sizing", () => {
	it("sizes the long side to the thumbnail from the viewBox, keeping its aspect", () => {
		expect(prepared('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"></svg>')).toMatchObject({ width: 384, height: 192 })
		expect(prepared('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0,0,50,100"/>')).toMatchObject({ width: 192, height: 384 })
	})

	it("scales a small icon up: a vector loses nothing", () => {
		expect(prepared('<svg viewBox="0 0 16 16"/>')).toMatchObject({ width: 384, height: 384 })
	})

	it("replaces the declared width and height, keeping every other attribute", () => {
		const tag = rootTag(prepared('<svg class="a" width="16px" height="8" stroke-width="2" viewBox="0 0 16 8"><g/></svg>').markup)

		expect(tag).toContain('class="a"')
		expect(tag).toContain('stroke-width="2"')
		expect(tag).toContain('width="384"')
		expect(tag).toContain('height="192"')
		expect(tag).not.toContain("16px")
	})

	it("derives a viewBox from a declared size, so the drawing scales with the new size", () => {
		const result = prepared('<svg width="40" height="20"><rect/></svg>')

		expect(result).toMatchObject({ width: 384, height: 192 })
		expect(rootTag(result.markup)).toContain('viewBox="0 0 40 20"')
	})

	it("replaces an unusable viewBox with the derived one rather than adding a second", () => {
		const tag = rootTag(prepared('<svg viewBox="0 0 0 0" width="40" height="20"/>').markup)

		expect(tag.match(/viewBox=/g)).toHaveLength(1)
		expect(tag).toContain('viewBox="0 0 40 20"')
	})

	it("falls back to a square when the drawing states no extent", () => {
		expect(prepared('<svg width="100%" height="100%"></svg>')).toMatchObject({ width: 384, height: 384 })
	})

	it("adds the SVG namespace when the root lacks it, and keeps it when present", () => {
		expect(rootTag(prepared("<svg></svg>").markup)).toContain('xmlns="http://www.w3.org/2000/svg"')
		expect(rootTag(prepared('<svg xmlns="http://www.w3.org/2000/svg"></svg>').markup).match(/xmlns=/g)).toHaveLength(1)
	})

	it("reads through a prolog and a quoted '>' inside the root tag, leaving the body untouched", () => {
		const body = "<text>a &gt; b</text></svg>"
		const result = prepared(`\uFEFF<?xml version="1.0"?>\n<!-- made by hand -->\n<svg data-x="1>0" viewBox="0 0 10 10">${body}`)

		expect(result.markup.endsWith(body)).toBe(true)
		expect(rootTag(result.markup)).toContain('data-x="1')
	})

	it("keeps a self-closing root self-closing", () => {
		expect(prepared('<svg viewBox="0 0 1 1"/>').markup.endsWith("/>")).toBe(true)
	})
})

describe("prepareSvgThumb — refusals", () => {
	it("refuses a root that is not <svg>", () => {
		expect(prepareSvgThumb("<html></html>", MAX)).toEqual({ type: "rejected", reason: "unsupported" })
		expect(prepareSvgThumb("<svgx></svgx>", MAX)).toEqual({ type: "rejected", reason: "unsupported" })
		expect(prepareSvgThumb("not markup at all", MAX)).toEqual({ type: "rejected", reason: "unsupported" })
	})

	it("refuses an entity that references another (billion laughs)", () => {
		const bomb = '<!DOCTYPE svg [<!ENTITY a "lol"><!ENTITY b "&a;&a;">]><svg>&b;</svg>'

		expect(prepareSvgThumb(bomb, MAX)).toEqual({ type: "rejected", reason: "unsupported" })
	})

	it("refuses a reference hidden behind a quoted '>' in an entity value", () => {
		const bomb = '<!DOCTYPE svg [<!ENTITY a "lol"><!ENTITY b "x>&a;&a;">]><svg>&b;</svg>'

		expect(prepareSvgThumb(bomb, MAX)).toEqual({ type: "rejected", reason: "unsupported" })
	})

	it("refuses an entity chain hidden behind a quoted ']>' that fakes the subset's end", () => {
		const bomb = '<!DOCTYPE svg [ <!ENTITY a "]><!--"> <!ENTITY l0 "ha"> <!ENTITY l1 "&l0;&l0;"> ]><!-- x --><svg>&l1;</svg>'

		expect(prepareSvgThumb(bomb, MAX)).toEqual({ type: "rejected", reason: "unsupported" })
	})

	it("refuses a fake root quoted inside the subset", () => {
		const bomb = '<!DOCTYPE svg [ <!ENTITY a "]><svg>"> <!ENTITY l0 "ha"> <!ENTITY l1 "&l0;&l0;"> ]><svg>&l1;</svg>'

		expect(prepareSvgThumb(bomb, MAX)).toEqual({ type: "rejected", reason: "unsupported" })
	})

	it("reads past quotes, comments and processing instructions to the subset's real end", () => {
		const safe = `<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "a>b.dtd" [ <!-- don't ]> --> <?pi ]> ?> <!ENTITY ns "x]>y"> ]><svg viewBox="0 0 2 1"/>`

		expect(prepareSvgThumb(safe, MAX)).toMatchObject({ type: "ok", width: 384, height: 192 })
	})

	it("refuses parameter and external entities", () => {
		expect(prepareSvgThumb('<!DOCTYPE svg [<!ENTITY % p "x">]><svg/>', MAX)).toEqual({ type: "rejected", reason: "unsupported" })
		expect(prepareSvgThumb('<!DOCTYPE svg [<!ENTITY e SYSTEM "file:///etc/passwd">]><svg>&e;</svg>', MAX)).toEqual({
			type: "rejected",
			reason: "unsupported"
		})
	})

	it("accepts a plain string entity, as Illustrator exports declare", () => {
		const illustrator =
			'<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [<!ENTITY ns_svg "http://www.w3.org/2000/svg">]><svg viewBox="0 0 2 1"/>'

		expect(prepareSvgThumb(illustrator, MAX)).toMatchObject({ type: "ok", width: 384, height: 192 })
	})

	it("calls a truncated prolog or root tag corrupt", () => {
		expect(prepareSvgThumb("<!-- never closed <svg/>", MAX)).toEqual({ type: "rejected", reason: "corrupt" })
		expect(prepareSvgThumb('<svg viewBox="0 0 1 1', MAX)).toEqual({ type: "rejected", reason: "corrupt" })
		expect(prepareSvgThumb('<!DOCTYPE svg [<!ENTITY a "b">', MAX)).toEqual({ type: "rejected", reason: "corrupt" })
	})
})
