import { describe, expect, it, vi } from "vitest"
import { MAX_NFO_CHARS, parseNfo } from "@filen/shared/videos"

const MOVIE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<!-- comment <title>ignored</title> -->
<movie>
  <title>Tom &amp; Jerry: The &#169; Movie</title>
  <originaltitle>Original</originaltitle>
  <sorttitle>Tom Jerry</sorttitle>
  <year>2021</year>
  <premiered>2021-02-26</premiered>
  <runtime>101</runtime>
  <mpaa>PG</mpaa>
  <tagline>It's &quot;on&quot;</tagline>
  <plot><![CDATA[Cat <and> mouse & friends]]></plot>
  <genre>Family</genre>
  <genre>Comedy</genre>
  <genre>Family</genre>
  <tag>cartoon</tag>
  <studio>Warner</studio>
  <set><name>Collection</name><title>Not mine</title></set>
  <actor><name>Someone</name><role>Role</role></actor>
  <fileinfo><streamdetails><video><codec>h264</codec></video></streamdetails></fileinfo>
  <lockdata>true</lockdata>
  <title>Second Title Wins</title>
  <tag/>
</movie>
https://www.themoviedb.org/movie/1234
<movie><title>Appended junk</title></movie>`

describe("parseNfo", () => {
	it("reads movie fields, decodes entities, lets the last scalar win and ignores nested tags", () => {
		const nfo = parseNfo(MOVIE)

		expect(nfo).toEqual({
			kind: "movie",
			title: "Second Title Wins",
			originalTitle: "Original",
			sortTitle: "Tom Jerry",
			year: 2021,
			premiered: "2021-02-26",
			runtimeMinutes: 101,
			mpaa: "PG",
			tagline: "It's \"on\"",
			plot: "Cat <and> mouse & friends",
			genres: ["Family", "Comedy"],
			tags: ["cartoon"],
			studios: ["Warner"],
			cast: ["Someone"],
			lockData: true
		})
	})

	it("reads actors' names as the cast, in order, and nothing else nested", () => {
		const nfo = parseNfo(
			"<movie><actor><name>Ann</name><role>Lead</role></actor><actor><name/></actor><actor><name>Bo &amp; Co</name></actor><set><name>Box</name></set><actor><name>Ann</name></actor></movie>"
		)

		expect(nfo?.cast).toEqual(["Ann", "Bo & Co"])
		expect(nfo?.title).toBeUndefined()
		expect(
			parseNfo(
				"<episodedetails><actor><name>One</name></actor></episodedetails><episodedetails><actor><name>Two</name></actor></episodedetails>"
			)?.cast
		).toEqual(["One"])
	})

	it("leaves entity names that are inherited object keys literal", () => {
		expect(parseNfo("<movie><title>Up &valueOf; &toString; &__proto__;</title></movie>")?.title).toBe(
			"Up &valueOf; &toString; &__proto__;"
		)
	})

	it("decodes numeric entities in titles", () => {
		expect(parseNfo("<movie><title>Tom &amp; Jerry &#169; &#x263A;</title></movie>")?.title).toBe("Tom & Jerry © ☺")
	})

	it("reads episode fields and widens episodeEnd across repeated roots", () => {
		const nfo =
			parseNfo(`<episodedetails><title>One</title><season>1</season><episode>3</episode><aired>2020-01-02</aired><airsbefore_season>2</airsbefore_season><airsafter_season>1</airsafter_season></episodedetails>
<episodedetails><title>Two</title><season>1</season><episode>4</episode></episodedetails>`)

		expect(nfo).toMatchObject({
			kind: "episodedetails",
			title: "One",
			season: 1,
			episode: 3,
			episodeEnd: 4,
			premiered: "2020-01-02",
			airsBeforeSeason: 2,
			airsAfterSeason: 1
		})
	})

	it("prefers an explicit episodenumberend", () => {
		expect(parseNfo("<episodedetails><episode>1</episode><episodenumberend>2</episodenumberend></episodedetails>")).toMatchObject({
			episode: 1,
			episodeEnd: 2
		})
	})

	it("reads tvshow and season roots", () => {
		expect(parseNfo("<tvshow><title>Show</title><year>1999</year><plot>p</plot><studio>HBO</studio></tvshow>")).toMatchObject({
			kind: "tvshow",
			title: "Show",
			year: 1999
		})
		expect(parseNfo("<season><title>Season 2</title><seasonnumber>2</seasonnumber></season>")).toMatchObject({
			kind: "season",
			season: 2,
			title: "Season 2"
		})
	})

	it("prefers premiered, then aired, then releasedate", () => {
		expect(parseNfo("<movie><releasedate>c</releasedate><aired>b</aired></movie>")?.premiered).toBe("b")
		expect(parseNfo("<movie><releasedate>c</releasedate></movie>")?.premiered).toBe("c")
		expect(parseNfo("<movie><aired>b</aired><premiered>a</premiered></movie>")?.premiered).toBe("a")
	})

	it("handles runtime formats and rejects junk numbers", () => {
		expect(parseNfo("<movie><runtime>95 min</runtime></movie>")?.runtimeMinutes).toBe(95)
		expect(parseNfo("<movie><runtime>abc</runtime><year>12</year><season>x</season></movie>")).toEqual({
			kind: "movie",
			genres: [],
			tags: [],
			studios: [],
			cast: []
		})
	})

	it("tolerates BOM, a missing closing tag and mismatched tags", () => {
		expect(parseNfo("﻿<movie><title>A</title>")?.title).toBe("A")
		expect(parseNfo("<movie><title>A<b>bold</title><year>2000</year></movie>")).toMatchObject({ title: "Abold", year: 2000 })
		expect(parseNfo("<MOVIE><TITLE>Upper</TITLE></MOVIE>")?.title).toBe("Upper")
	})

	it("returns null without a known root", () => {
		expect(parseNfo("")).toBeNull()
		expect(parseNfo("https://www.imdb.com/title/tt1234567/")).toBeNull()
		expect(parseNfo("<html><title>x</title></html>")).toBeNull()
	})

	it("does not expand entities from a DOCTYPE", () => {
		const nfo = parseNfo(
			"<?xml version=\"1.0\"?><!DOCTYPE movie [<!ENTITY a \"aaaa\"><!ENTITY b \"&a;&a;&a;&a;\">]><movie><title>&b;</title></movie>"
		)

		expect(nfo?.title).toBe("&b;")
	})

	it("caps the input and list sizes", () => {
		const big = `<movie><plot>${"x".repeat(MAX_NFO_CHARS * 2)}</plot><title>never</title></movie>`
		const nfo = parseNfo(big)

		expect(nfo?.title).toBeUndefined()
		expect((nfo?.plot ?? "").length).toBeLessThanOrEqual(64 * 1024)

		const genres = Array.from({ length: 500 }, (_, i) => `<genre>g${String(i)}</genre>`).join("")

		expect(parseNfo(`<movie>${genres}</movie>`)?.genres).toHaveLength(64)
	})

	it("survives hostile structure", () => {
		const deep = `<movie>${"<a>".repeat(100_000)}<title>x</title></movie>`
		const unterminated = `<movie><title>${"<".repeat(100_000)}`
		const entities = `<movie><title>${"&".repeat(100_000)}</title></movie>`
		const started = performance.now()

		expect(() => parseNfo(deep)).not.toThrow()
		expect(() => parseNfo(unterminated)).not.toThrow()
		expect(parseNfo(entities)?.title?.length).toBeGreaterThan(0)
		expect(performance.now() - started).toBeLessThan(1000)
	})

	it("skips runs of declarations without rescanning the rest of the text", () => {
		const text = `<movie><title>x</title>${"<!a>".repeat(65_000)}</movie>`
		// The characters every search walks (counted, not timed: a busy machine never fails a linear scan). Rescanning the
		// rest of the text for each declaration would walk it about 32 000 times over.
		const indexOf = String.prototype.indexOf
		let walked = 0

		vi.spyOn(String.prototype, "indexOf").mockImplementation(function (this: string, search: string, position?: number) {
			const from = Math.max(0, position ?? 0)
			const at = indexOf.call(this, search, from)

			walked += (at === -1 ? this.length : at) - from

			return at
		})

		expect(parseNfo(text)?.title).toBe("x")
		expect(walked).toBeLessThan(2 * text.length)
		vi.restoreAllMocks()
		expect(parseNfo("<!DOCTYPE movie [<!ENTITY a \"<title>no</title>\">]><movie><title>yes</title></movie>")?.title).toBe("yes")
	})

	it("never throws on random markup soup", () => {
		let state = 7
		const rand = () => {
			state = (Math.imul(state, 1103515245) + 12345) >>> 0

			return state / 4294967296
		}
		const pieces = [
			"<movie>",
			"</movie>",
			"<title>",
			"</title>",
			"<![CDATA[",
			"]]>",
			"<!--",
			"-->",
			"<?",
			"?>",
			"&amp;",
			"&",
			"<",
			">",
			"/",
			"x",
			"<genre>",
			"</genre>",
			"<episodedetails>",
			"</episodedetails>"
		]

		for (let round = 0; round < 500; round++) {
			let input = ""

			for (let i = 0; i < 40; i++) {
				input += pieces[Math.floor(rand() * pieces.length)]
			}

			expect(() => parseNfo(input)).not.toThrow()
		}
	})
})

describe("parseNfo edge cases", () => {
	it("treats a < that cannot start a name as text", () => {
		expect(parseNfo("<movie><title>a < b <3 c</title></movie>")?.title).toBe("a < b <3 c")
		expect(parseNfo("<movie><plot>1 <\n2</plot></movie>")?.plot).toBe("1 <\n2")
	})

	it("treats Kodi unknown sentinels as absent", () => {
		expect(
			parseNfo("<episodedetails><season>-1</season><episode>-1</episode><episodenumberend>-1</episodenumberend></episodedetails>")
		).toEqual({
			kind: "episodedetails",
			genres: [],
			tags: [],
			studios: [],
			cast: []
		})
		expect(parseNfo("<movie><runtime>0</runtime></movie>")?.runtimeMinutes).toBeUndefined()
		expect(parseNfo("<episodedetails><season>0</season><episode>1</episode></episodedetails>")).toMatchObject({ season: 0, episode: 1 })
	})
})
