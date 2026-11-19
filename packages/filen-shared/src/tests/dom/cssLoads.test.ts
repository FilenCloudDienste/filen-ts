import { describe, expect, it } from "vitest"
import { tokenize, TokenType } from "@csstools/css-tokenizer"
import { cssTokens, cssValueLoads, keptCss, preprocessCss } from "@filen/shared/dom/cssLoads"

function types(css: string): string[] {
	return cssTokens(css).map(token => ("value" in token ? `${token.type}:${token.value}` : token.type))
}

const resolve = (id: string): string | null => (id === "part" ? "blob:part" : null)

function loads(css: string): boolean {
	return cssValueLoads(css, resolve)
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
		expect(types('"/*"')).toEqual(["string:/*"])
		expect(types("url(/*)")).toEqual(["url:/*"])
	})

	it("reads numbers as §4.3.12 does: a dot or an exponent only before a digit", () => {
		expect(types("1.url(/*)")).toEqual(["number:1", "delim:.", "url:/*"])
		expect(types(".5.url(x)")).toEqual(["number:.5", "delim:.", "url:x"])
		expect(types("1.\\75 rl(x)")).toEqual(["number:1", "delim:.", "url:x"])
		expect(types("1e3px 1e+3 1e-x 1.5em 2.%")).toEqual([
			"number:1e3px",
			"ws",
			"number:1e+3",
			"ws",
			"number:1e-x",
			"ws",
			"number:1.5em",
			"ws",
			"number:2",
			"delim:.",
			"delim:%"
		])
		expect(types("..5")).toEqual(["delim:.", "number:.5"])
	})

	it("reads <!-- and --> as tokens of their own", () => {
		expect(types("<!--image-set(-->")).toEqual(["cdo", "function:image-set", "cdc"])
		expect(types("--x -1")).toEqual(["ident:--x", "ws", "number:-1"])
	})

	it("ends a string at a newline as a bad string", () => {
		expect(types('"a\nb')[0]).toBe("badString")
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
		'a{content:"x\n}',
		"a{background:url(cid:other)}",
		"p{x:1.url(/*)}q{background-image:url(https://e.vil/c)}r{y:*/}",
		"p{x:.5.url(/*)}q{background-image:url(https://e.vil/c)}r{y:*/}"
	])("judges %j as loading", css => {
		expect(loads(css)).toBe(true)
	})

	it.each(["a{color:red}", "a{background:url(data:image/png;base64,AAAA)}", "a{background:url(cid:part)}", 'a{content:"url(x)"}'])(
		"judges %j as inert",
		css => {
			expect(loads(css)).toBe(false)
		}
	)

	it("splits rules at the top level and declarations at semicolons outside blocks", () => {
		expect(keptCss("a{b:c}@media x{d{e:url(https://e.vil/x)}}g{h:i}", "sheet", resolve)).toEqual({ css: "a{b:c}g{h:i}", dropped: 1 })
		expect(keptCss("color:red;background:url(x);margin:0", "declarations", resolve)).toEqual({ css: "color:red;margin:0", dropped: 1 })
		expect(keptCss("a:b;;c:d;", "declarations", resolve)).toEqual({ css: "a:b;;c:d;", dropped: 0 })
	})

	// A comment between two rules belongs to neither and is not kept.
	it("replaces a part's url by its local URL, keeping everything else as written", () => {
		expect(keptCss("a{background:url(cid:part)}/* x */b{c:url( 'cid:part' ) /* y */ d}", "sheet", resolve)).toEqual({
			css: "a{background:url('blob:part')}b{c:url('blob:part') /* y */ d}",
			dropped: 0
		})
		expect(keptCss("a{background:url(cid:other)}", "sheet", resolve)).toEqual({ css: "", dropped: 1 })
	})
})

// The judge against an independent CSS Syntax tokenizer: random CSS-hostile strings, the reference's tokens judged by
// the same rules. Every load the reference sees must be seen here (a stricter verdict is allowed).
describe("css loads against a reference tokenizer", () => {
	const PIECES = [
		"url(",
		"u",
		"r",
		"l",
		"(",
		")",
		"/*",
		"*/",
		"\\",
		"\\75 ",
		"\\2f",
		"\\\n",
		'"',
		"'",
		":",
		";",
		"{",
		"}",
		".",
		"..",
		"5",
		"1",
		"e",
		"E",
		"+",
		"-",
		"@import",
		"@\\69mport",
		"@font-face",
		"image(",
		"image-set(",
		"https://e.vil/x",
		"data:image/png,a",
		"cid:part",
		" ",
		"\n",
		"\r\n",
		"\f",
		"\t",
		"x",
		"%",
		"#",
		",",
		"<!--",
		"-->"
	]
	const LOADING = new Set([
		"url",
		"src",
		"image",
		"image-set",
		"-webkit-image-set",
		"cross-fade",
		"-webkit-cross-fade",
		"element",
		"-moz-element"
	])
	const CLEAN_DATA_IMAGE = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[a-z0-9.+-]+)*(?:;base64)?,[a-z0-9+/=%._~!$&*,;:@-]*$/i
	const local = (value: string): boolean => CLEAN_DATA_IMAGE.test(value) || /^\s*cid:\s*<?part>?\s*$/i.test(value)

	function referenceLoads(css: string): boolean {
		const tokens = tokenize({ css }).filter(token => token[0] !== TokenType.Comment)

		for (let index = 0; index < tokens.length; index++) {
			const token = tokens[index]

			if (token === undefined) continue

			switch (token[0]) {
				case TokenType.BadString:
				case TokenType.BadURL:
					return true
				case TokenType.URL:
					if (!local(token[4].value)) return true

					break
				case TokenType.AtKeyword:
					if (token[4].value.toLowerCase() === "import" || token[4].value.toLowerCase() === "font-face") return true

					break
				case TokenType.Function: {
					const name = token[4].value.toLowerCase()

					if (!LOADING.has(name)) break

					let at = index + 1

					while (tokens[at]?.[0] === TokenType.Whitespace) at++

					const string = tokens[at]

					at++

					while (tokens[at]?.[0] === TokenType.Whitespace) at++

					if (name !== "url" || string?.[0] !== TokenType.String || tokens[at]?.[0] !== TokenType.CloseParen) return true

					if (!local(string[4].value)) return true

					break
				}
				default:
					break
			}
		}

		return false
	}

	// mulberry32: a fixed seed, so a failure reproduces.
	function random(seed: number): () => number {
		let state = seed

		return () => {
			state = (state + 0x6d2b79f5) | 0

			let t = Math.imul(state ^ (state >>> 15), 1 | state)

			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

			return ((t ^ (t >>> 14)) >>> 0) / 4294967296
		}
	}

	it("sees every load the reference sees", () => {
		const next = random(0x5eed)
		const missed: string[] = []

		for (let sample = 0; sample < 100_000 && missed.length < 5; sample++) {
			let css = ""
			const pieces = 1 + Math.floor(next() * 24)

			for (let piece = 0; piece < pieces; piece++) css += PIECES[Math.floor(next() * PIECES.length)] ?? ""

			if (referenceLoads(preprocessCss(css)) && !loads(preprocessCss(css))) missed.push(css)
		}

		expect(missed).toEqual([])
	})
})
