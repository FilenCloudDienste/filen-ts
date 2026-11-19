import { describe, expect, it, vi } from "vitest"
import {
	commonStemPrefix,
	compareVersionCandidates,
	directoryArtName,
	extraTypeForDirName,
	groupStacks,
	parseExtraName,
	parseStackPart,
	parseSubtitleTokens,
	seasonArtName,
	sidecarDirKind,
	stemArtName,
	subtitleFormat,
	versionLabel,
	versionSuffix,
	videoSortName
} from "@filen/shared/videos"

describe("parseStackPart", () => {
	it.each<[string, string, number]>([
		["Movie cd1", "Movie", 1],
		["Movie CD2", "Movie", 2],
		["Movie-cd1", "Movie", 1],
		["Movie.cd1", "Movie", 1],
		["Movie_cd1", "Movie", 1],
		["Movie (cd1)", "Movie", 1],
		["Movie [cd 1]", "Movie", 1],
		["Movie part1", "Movie", 1],
		["Movie Part 2", "Movie", 2],
		["Movie.Part.3", "Movie", 3],
		["Movie pt1", "Movie", 1],
		["Movie pt.2", "Movie", 2],
		["Movie disc1", "Movie", 1],
		["Movie Disc 2", "Movie", 2],
		["Movie disk3", "Movie", 3],
		["Movie dvd1", "Movie", 1],
		["Movie cda", "Movie", 1],
		["Movie part b", "Movie", 2],
		["Movie-a", "Movie", 1],
		["Movie-d", "Movie", 4],
		["Movie part 10", "Movie", 10],
		["Movie cd1 1080p", "Movie", 1],
		["Film (2010) - Part 2", "Film (2010)", 2],
		["Kärlek cd1", "Kärlek", 1],
		["Harry Potter Part 1 (2010)", "Harry Potter", 1],
		["Movie (2010)cd1", "Movie (2010)", 1],
		["Movie Part.A", "Movie", 1],
		["Movie_c", "Movie", 3],
		["Movie.b", "Movie", 2]
	])("%s → %s part %i", (stem, prefix, part) => {
		expect(parseStackPart(stem)).toMatchObject({
			prefix,
			part
		})
	})

	it.each([
		"cd1",
		"Part 1",
		"Movie",
		"Movie part",
		"Movie part 100",
		"Partners",
		"Abcd1",
		"Movie-e",
		"Movie a",
		"Movie Discard",
		"Movie Disco",
		"-cd1"
	])("%s → not a part", stem => {
		expect(parseStackPart(stem)).toBeNull()
	})
})

describe("groupStacks", () => {
	const members = (stems: string[]): number[][] => groupStacks(stems).map(group => group.members)

	it.each<[string[], number[][]]>([
		[["Movie cd1", "Movie cd2"], [[0, 1]]],
		[["Movie cd2", "Movie cd1"], [[1, 0]]],
		[["Movie cd1", "Movie cd3"], [[0, 1]]],
		[["Movie cd1"], [[0]]],
		[
			["Movie cd1", "Movie part2"],
			[[0], [1]]
		],
		[
			["Movie cd1", "Movie cd1"],
			[[0], [1]]
		],
		[
			["Movie-a", "Movie-b", "Other"],
			[[0, 1], [2]]
		],
		[
			["HP Part 1 (2010)", "HP Part 2 (2011)"],
			[[0], [1]]
		],
		[
			["Movie cd1", "Movie cda"],
			[[0], [1]]
		],
		[
			["A cd1", "B cd1", "A cd2", "B cd2"],
			[
				[0, 2],
				[1, 3]
			]
		],
		[["Movie disc1", "Movie disk2"], [[0, 1]]],
		[["movie CD1", "Movie cd2"], [[0, 1]]],
		[
			["Movie cd1 [1080p]", "Movie cd2 [720p]"],
			[[0], [1]]
		],
		[["Movie pt1", "Movie Part 2"], [[0, 1]]],
		[
			["Movie cd1", "Movie cd2", "Movie cd1"],
			[[0], [1], [2]]
		],
		[
			["Movie-a", "Movie cdb"],
			[[0], [1]]
		],
		[
			["Other", "Movie-b", "Movie-a"],
			[[0], [2, 1]]
		]
	])("%j → %j", (stems, groups) => {
		expect(members(stems)).toEqual(groups)
	})

	it("names the stack by its shared prefix", () => {
		expect(groupStacks(["Movie (2010) cd1", "Movie (2010) cd2"])[0]?.prefix).toBe("Movie (2010)")
		expect(groupStacks(["Movie"])[0]?.prefix).toBeNull()
	})
})

describe("parseExtraName", () => {
	it.each([
		["Movie-trailer", "trailer", "Movie"],
		["Movie (2010)-trailer", "trailer", "Movie (2010)"],
		["Movie - Trailer", "trailer", "Movie"],
		["Movie-trailer2", "trailer", "Movie"],
		["Movie-trailer 2", "trailer", "Movie"],
		["Movie-teaser", "trailer", "Movie"],
		["Movie-featurette", "featurette", "Movie"],
		["Movie-behindthescenes", "behindTheScenes", "Movie"],
		["Movie-deleted", "deletedScene", "Movie"],
		["Movie-deletedscene", "deletedScene", "Movie"],
		["Movie-interview", "interview", "Movie"],
		["Movie-scene", "scene", "Movie"],
		["Movie-short", "short", "Movie"],
		["Movie-clip", "clip", "Movie"],
		["Movie-extra", "unknown", "Movie"],
		["Movie-other", "unknown", "Movie"],
		["Amélie-trailer", "trailer", "Amélie"],
		["trailer", "trailer", ""],
		["Trailer1", "trailer", ""],
		["featurette", "featurette", ""],
		["interview 2", "interview", ""]
	])("%s → %s of %s", (stem, type, owner) => {
		expect(parseExtraName(stem)).toEqual({
			type,
			owner
		})
	})

	it.each([
		"clip",
		"short",
		"The Big Short",
		"The.Big.Short",
		"Short-Circuit",
		"Movie-trailer-1080p",
		"Movie_trailer",
		"Trailer Park Boys",
		"Movie"
	])("%s → not an extra", stem => {
		expect(parseExtraName(stem)).toBeNull()
	})
})

describe("extraTypeForDirName", () => {
	it.each([
		["Trailers", "trailer"],
		["trailer", "trailer"],
		["Featurettes", "featurette"],
		["Behind The Scenes", "behindTheScenes"],
		["behind_the_scenes", "behindTheScenes"],
		["Making Of", "behindTheScenes"],
		["Deleted Scenes", "deletedScene"],
		["Interviews", "interview"],
		["Scenes", "scene"],
		["Shorts", "short"],
		["Clips", "clip"],
		["Extras", "unknown"],
		["Extra", "unknown"],
		["Bonus", "unknown"],
		["Bonus Features", "unknown"],
		["Special Features", "unknown"],
		["Other", "unknown"],
		["Others", "unknown"],
		["Movies", null],
		["Season 1", null],
		["Specials", null]
	])("%s → %s", (name, type) => {
		expect(extraTypeForDirName(name)).toBe(type)
	})
})

describe("versions", () => {
	it.each<[string, string, string | null]>([
		["Movie (2010)", "Movie (2010)", ""],
		["Movie (2010)", "Movie (2010) - 1080p", "- 1080p"],
		["Movie (2010)", "Movie (2010)-4K", "-4K"],
		["Movie (2010)", "Movie (2010) [Director's Cut]", "[Director's Cut]"],
		["Movie (2010)", "Movie (2010) {edition-Extended}", "{edition-Extended}"],
		["Movie (2010)", "movie (2010).hdr", ".hdr"],
		["Movie (2010)", "Movie (2010)_remux", "_remux"],
		["Movie (2010)", "Movie (2010) 1080p", null],
		["Movie (2010)", "Movie (2011)", null],
		["Movie", "Movies", null],
		["M", "M - 1080p", null],
		["Movie (2010)", "Movie", null]
	])("versionSuffix(%s, %s) → %s", (directory, stem, suffix) => {
		expect(versionSuffix(directory, stem)).toBe(suffix)
	})

	it.each([
		["- 1080p", "Movie (2010) - 1080p", "1080p"],
		["[Director's Cut]", "Movie (2010) [Director's Cut]", "Director's Cut"],
		["{edition-Extended}", "Movie (2010) {edition-Extended}", "Extended"],
		["_Theatrical_Cut", "Movie_Theatrical_Cut", "Theatrical Cut"],
		[".hdr", "Movie.hdr", "hdr"],
		["", "Movie (2010) 2160p HDR", "4K HDR"],
		["", "Movie (2010) 1080p", "1080p"],
		["", "Movie (2010)", ""]
	])("versionLabel(%s) → %s", (suffix, stem, label) => {
		expect(versionLabel(suffix, stem)).toBe(label)
	})

	it.each<[string[], number]>([
		[["Show S01E01 1080p", "Show S01E01 720p"], 12],
		[["x 1080p", "x 1440p"], 2],
		[["Movie", "Movie Extended"], 5],
		[["MOVIE 1080p", "movie 720p"], 6],
		[["a"], 0],
		[["Alpha", "Beta"], 0]
	])("commonStemPrefix(%j) → %i", (stems, length) => {
		expect(commonStemPrefix(stems)).toBe(length)
	})

	it("orders labelled resolutions first, highest first, then by name", () => {
		const sorted = [
			{
				name: "Movie b",
				height: 0
			},
			{
				name: "Movie 720p",
				height: 720
			},
			{
				name: "Movie a",
				height: 0
			},
			{
				name: "Movie 2160p",
				height: 2160
			},
			{
				name: "Movie 10",
				height: 0
			},
			{
				name: "Movie 9",
				height: 0
			}
		].sort(compareVersionCandidates)

		expect(sorted.map(entry => entry.name)).toEqual(["Movie 2160p", "Movie 720p", "Movie 9", "Movie 10", "Movie a", "Movie b"])
	})

	it("orders versions the same on every device locale, and names equal but for case by code unit", async () => {
		const names = ["Film (2010) - Director's Cut", "Film (2010) - Chinese dub", "Film (2010) - aa", "Film (2010) - b"]
		const Collator = Intl.Collator

		vi.resetModules()
		vi.stubGlobal("Intl", {
			...Intl,
			Collator: function (locales?: string | string[], options?: Intl.CollatorOptions) {
				return new Collator(locales ?? "cs", options)
			}
		})

		try {
			const { compareVersionCandidates: underCzech } = await import("../../videos/versions")
			const order = (list: string[]): string[] =>
				list
					.map(name => ({ name, height: 0 }))
					.sort(underCzech)
					.map(entry => entry.name)

			expect(order(names)).toEqual([
				"Film (2010) - aa",
				"Film (2010) - b",
				"Film (2010) - Chinese dub",
				"Film (2010) - Director's Cut"
			])
			expect(order(["film b", "Film B"])).toEqual(order(["Film B", "film b"]))
		} finally {
			vi.unstubAllGlobals()
		}
	})
})

describe("videoSortName", () => {
	it.each([
		["The Matrix", "Matrix"],
		["A Beautiful Mind", "Beautiful Mind"],
		["An American Werewolf in London", "American Werewolf in London"],
		["Theater", "Theater"],
		["The", "The"],
		["A.I. Artificial Intelligence", "A I Artificial Intelligence"],
		["Ocean's Eleven", "Oceans Eleven"],
		["Fast & Furious", "Fast Furious"],
		["Spider-Man", "SpiderMan"],
		["Mr. Robot", "Mr Robot"],
		["Romeo + Juliet", "Romeo Juliet"],
		["100% Wolf", "100 Wolf"],
		["Amélie", "Amélie"],
		["the office", "office"],
		["Crouching Tiger, Hidden Dragon", "Crouching Tiger Hidden Dragon"],
		["  The   Matrix  ", "Matrix"],
		["{Braces}", "Braces"],
		["Marvel’s Agents", "Marvels Agents"],
		["Die Hard", "Die Hard"]
	])("%s → %s", (title, sortName) => {
		expect(videoSortName(title)).toBe(sortName)
	})

	it("prefers an NFO sort title", () => {
		expect(videoSortName("Whatever", "Sort Title")).toBe("Sort Title")
		expect(videoSortName("The Matrix", "  ")).toBe("Matrix")
	})
})

describe("subtitle names", () => {
	it.each([
		["srt", false, "srt"],
		["vtt", false, "vtt"],
		["ass", false, "ass"],
		["ssa", false, "ssa"],
		["smi", false, "smi"],
		["sami", false, "smi"],
		["idx", false, "vobsub"],
		["sub", true, null],
		["sub", false, "microdvd"],
		["sup", false, "pgs"],
		["txt", false, null]
	])("subtitleFormat(%s, idx partner %s) → %s", (extension, partner, format) => {
		expect(subtitleFormat(extension, partner)).toBe(format)
	})

	it.each<[string[], string | null, boolean, boolean, boolean, string]>([
		[[], null, false, false, false, ""],
		[["en"], "en", false, false, false, ""],
		[["eng"], "en", false, false, false, ""],
		[["English"], "en", false, false, false, ""],
		[["ger"], "de", false, false, false, ""],
		[["fre", "forced"], "fr", true, false, false, ""],
		[["en", "forced"], "en", true, false, false, ""],
		[["forced", "en"], "en", true, false, false, ""],
		[["en", "sdh"], "en", false, true, false, ""],
		[["en", "cc"], "en", false, true, false, ""],
		[["en", "hi"], "en", false, true, false, ""],
		[["hi", "en"], "en", false, true, false, ""],
		[["hi"], "hi", false, false, false, ""],
		[["default", "en"], "en", false, false, true, ""],
		[["en", "default", "forced"], "en", true, false, true, ""],
		[["foreign", "de"], "de", true, false, false, ""],
		[["Commentary", "en"], "en", false, false, false, "Commentary"],
		[["en", "Director's Commentary"], "en", false, false, false, "Director's Commentary"],
		[["pt-BR"], "pt", false, false, false, ""],
		[["2_English"], "en", false, false, false, ""],
		[["en", "sdh", "forced", "default"], "en", true, true, true, ""],
		[["Signs", "Songs"], null, false, false, false, "Signs Songs"]
	])("%j → %s forced=%s sdh=%s default=%s title=%s", (tokens, language, forced, sdh, isDefault, title) => {
		expect(parseSubtitleTokens(tokens)).toEqual({
			language,
			forced,
			sdh,
			isDefault,
			title
		})
	})

	it("reads two languages as language plus title", () => {
		expect(parseSubtitleTokens(["de", "en"])).toMatchObject({
			language: "en",
			title: "de"
		})
	})
})

describe("artwork names", () => {
	it.each([
		["poster", "poster", 0],
		["folder", "poster", 1],
		["cover", "poster", 2],
		["default", "poster", 3],
		["movie", "poster", 4],
		["show", "poster", 4],
		["fanart", "backdrop", 0],
		["backdrop", "backdrop", 1],
		["background", "backdrop", 2],
		["art", "backdrop", 3],
		["backdrop1", "backdrop", 4],
		["landscape", "backdrop", 5],
		["thumb", "backdrop", 6],
		["logo", "logo", 0],
		["clearlogo", "logo", 1]
	])("directory art %s → %s #%i", (stem, slot, rank) => {
		expect(directoryArtName(stem)).toEqual({
			slot,
			rank
		})
	})

	it.each(["banner", "random", "poster2"])("directory art %s → none", stem => {
		expect(directoryArtName(stem)).toBeNull()
	})

	it.each([
		["movie (2010)-poster", "movie (2010)", "poster", 0],
		["movie-fanart", "movie", "backdrop", 0],
		["movie-landscape", "movie", "backdrop", 4],
		["show s01e01-thumb", "show s01e01", "thumb", 0],
		["movie-logo", "movie", "logo", 0],
		["movie-clearlogo", "movie", "logo", 1],
		["movie-cover", "movie", "poster", 2]
	])("stem art %s → %s %s #%i", (stem, owner, slot, rank) => {
		expect(stemArtName(stem)).toEqual({
			owner,
			art: {
				slot,
				rank
			}
		})
	})

	it.each(["movie-banner", "poster", "-poster", "movie - poster"])("stem art %s → none", stem => {
		expect(stemArtName(stem)).toBeNull()
	})

	it.each<[string, number, string]>([
		["season01-poster", 1, "poster"],
		["season1-poster", 1, "poster"],
		["season 2-poster", 2, "poster"],
		["season-specials-poster", 0, "poster"],
		["season00-poster", 0, "poster"],
		["season02-fanart", 2, "backdrop"],
		["season03-landscape", 3, "backdrop"]
	])("season art %s → season %i %s", (stem, season, slot) => {
		expect(seasonArtName(stem)).toMatchObject({
			season,
			art: {
				slot
			}
		})
	})

	it.each(["season-all-poster", "season01-banner", "season01"])("season art %s → none", stem => {
		expect(seasonArtName(stem)).toBeNull()
	})

	it.each([
		["Subs", "subtitles"],
		["subtitles", "subtitles"],
		["SUB", "subtitles"],
		["Metadata", "metadata"],
		["Extras", null]
	])("sidecar directory %s → %s", (name, kind) => {
		expect(sidecarDirKind(name)).toBe(kind)
	})
})
