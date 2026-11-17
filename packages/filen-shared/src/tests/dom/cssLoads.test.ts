import { describe, expect, it } from "vitest"
import { cssTokens, declarationChunks, preprocessCss, tokensLoad, topLevelChunks } from "@filen/shared/dom/cssLoads"

function types(css: string): string[] {
	return cssTokens(css).map(token => ("value" in token ? `${token.type}:${token.value}` : token.type))
}

function loads(css: string): boolean {
	return tokensLoad(cssTokens(css), id => id === "part")
}

describe("css tokens", () => {
	it("turns CR, CRLF and FF into one newline", () => {
		expect(preprocessCss("a\r\nb\rc\fd")).toBe("a\nb\nc\nd")
	})

	it("decodes escapes in names and reads url tokens", () => {
		expect(types("b\\61 ckground:u\\72l(x.png)")).toEqual(["ident:background", ":", "url:x.png"])
		expect(types("background:url( x.png )")).toEqual(["ident:background", ":", "url:x.png"])
	})

	it("skips comments outside strings and url tokens only", () => {
		expect(types("a/* x */b")).toEqual(["ident:a", "ident:b"])
		expect(types("\"/*\"")).toEqual(["string:/*"])
		expect(types("url(/*)")).toEqual(["url:/*"])
	})

	it("ends a string at a newline as a bad string", () => {
		expect(types("\"a\nb")[0]).toBe("badString")
	})

	it("reads a url with a space or quote inside as a bad url", () => {
		expect(types("url(a b)")).toEqual(["badUrl"])
		expect(types("url(a'b)")).toEqual(["badUrl"])
	})
})

describe("css loads", () => {
	it.each([
		"a{background:url(https://x.test/a.png)}",
		"a{background:url('https://x.test/a.png')}",
		"a{background:image-set('a.png' 1x)}",
		"@import 'a.css';",
		"@font-face{font-family:x}",
		"a{background:url(a b)}",
		"a{content:\"x\n}",
		"a{background:url(cid:other)}"
	])("judges %j as loading", css => {
		expect(loads(css)).toBe(true)
	})

	it.each(["a{color:red}", "a{background:url(data:image/png;base64,AAAA)}", "a{background:url(cid:part)}", "a{content:\"url(x)\"}"])(
		"judges %j as inert",
		css => {
			expect(loads(css)).toBe(false)
		}
	)

	it("splits rules at the top level and declarations at semicolons outside blocks", () => {
		expect(topLevelChunks(cssTokens("a{b:c}@media x{d{e:f}}g{h:i}"))).toHaveLength(3)
		expect(declarationChunks(cssTokens("color:red;background:url(x);margin:0"))).toHaveLength(3)
	})
})
