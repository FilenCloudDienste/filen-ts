import { describe, expect, it } from "vitest"
import {
	NO_FILE,
	commonStemPrefix,
	displayTitle,
	dynamicRangeLabel,
	episodeTitleText,
	identityKey,
	isCameraStem,
	isIgnoredFileName,
	mergeKey,
	normalizeSeparators,
	parseEpisode,
	parseExtraName,
	parseResolution,
	parseSeasonDirName,
	parseSeasonPackName,
	parseStackPart,
	parseUnmatchedSubtitleName,
	splitTitleYear,
	stripNameTags,
	versionLabel,
	videoSortName
} from "@filen/shared/videos"
import { classifyPaths } from "./libraryFixture"

describe("season words inside titles", () => {
	it("keeps season-named movies as movies and season directories as seasons of their show", () => {
		const { summary } = classifyPaths([
			{
				name: "Media",
				paths: [
					"Movies/Open Season (2006)/Open Season (2006).mkv",
					"Movies/Open Season 2 (2008)/Open Season 2 (2008).mkv",
					"Movies/Series 7 The Contenders (2001)/Series 7 The Contenders (2001).mkv",
					"TV/Breaking Bad Season 1/Breaking.Bad.S01E01.mkv",
					"TV/Breaking Bad Season 1/Breaking.Bad.S01E02.mkv",
					"TV/Breaking Bad Season 2/Breaking.Bad.S02E01.mkv",
					"TV/The Wire/The.Wire.S01E01.mkv",
					"TV/The Wire/The.Wire.S01E02.mkv"
				]
			}
		])

		expect(summary.movies.map(movie => `${movie.title} (${movie.year})`)).toEqual([
			"Open Season (2006)",
			"Open Season 2 (2008)",
			"Series 7 The Contenders (2001)"
		])
		expect(summary.series).toEqual([
			{
				title: "Breaking Bad",
				year: 0,
				seasons: {
					1: [
						"E1  = Media/TV/Breaking Bad Season 1/Breaking.Bad.S01E01.mkv",
						"E2  = Media/TV/Breaking Bad Season 1/Breaking.Bad.S01E02.mkv"
					],
					2: ["E1  = Media/TV/Breaking Bad Season 2/Breaking.Bad.S02E01.mkv"]
				},
				extras: []
			},
			{
				title: "The Wire",
				year: 0,
				seasons: {
					1: ["E1  = Media/TV/The Wire/The.Wire.S01E01.mkv", "E2  = Media/TV/The Wire/The.Wire.S01E02.mkv"]
				},
				extras: []
			}
		])
	})
})

describe("series found through episode files", () => {
	it("takes only the matching episodes and walks everything else as usual", () => {
		const { library, summary } = classifyPaths([
			{
				name: "Media",
				paths: [
					"Downloads/Show.S01E01.mkv",
					"Downloads/Show.S01E02.mkv",
					"Downloads/Inception (2010).mkv",
					"Downloads/VID_20230101_101010.mp4",
					"Downloads/Heat/Heat (1995).mkv",
					"Downloads/Other Show/Other.Show.S01E01.mkv",
					"Downloads/Other Show/Other.Show.S01E02.mkv"
				]
			}
		])

		expect(summary.series.map(series => [series.title, series.seasons[1]?.length])).toEqual([
			["Show", 2],
			["Other Show", 2]
		])
		expect(summary.movies.map(movie => movie.title)).toEqual(["Inception", "Heat"])
		expect(summary.others).toEqual(["Media/Downloads/VID_20230101_101010.mp4"])
		expect(library.series.map(series => series.id)).toEqual(["Media/Downloads", "Media/Downloads/Other Show"])
	})

	it("gives the series the extras of its directory when nothing else lives there", () => {
		const { summary } = classifyPaths([
			{
				name: "TV",
				paths: ["Fargo/Fargo.S01E01.mkv", "Fargo/Fargo.S01E02.mkv", "Fargo/Featurettes/Making Fargo.mkv"]
			}
		])

		expect(summary.series.map(series => [series.title, series.extras])).toEqual([
			["Fargo", ["featurette: TV/Fargo/Featurettes/Making Fargo.mkv"]]
		])
	})
})

describe("extra suffixes on episode names", () => {
	it("keeps a titled episode an episode and a glued suffix an extra", () => {
		const { summary } = classifyPaths([
			{
				name: "TV",
				paths: [
					"Show/Season 1/Show - S01E04 - Interview.mkv",
					"Show/Season 1/Show - S01E05.mkv",
					"Show/Season 1/Show S01E01-trailer.mkv"
				]
			}
		])

		expect(summary.series).toEqual([
			{
				title: "Show",
				year: 0,
				seasons: {
					1: ["E4 Interview = TV/Show/Season 1/Show - S01E04 - Interview.mkv", "E5  = TV/Show/Season 1/Show - S01E05.mkv"]
				},
				extras: ["trailer: TV/Show/Season 1/Show S01E01-trailer.mkv"]
			}
		])
	})
})

describe("season packs", () => {
	it("joins release-named season directories into one series per show", () => {
		const { library, summary } = classifyPaths([
			{
				name: "TV",
				paths: [
					"Breaking.Bad.S01.1080p.BluRay.x264-GRP/Breaking.Bad.S01E01.1080p.BluRay.x264-GRP.mkv",
					"Breaking.Bad.S01.1080p.BluRay.x264-GRP/Breaking.Bad.S01E02.1080p.BluRay.x264-GRP.mkv",
					"Breaking.Bad.S02.720p.WEB-DL/Breaking.Bad.S02E01.720p.WEB-DL.mkv",
					"Show/Show.S01.1080p.WEB/Show.S01E01.mkv",
					"Show/Show.S02.1080p.WEB/Show.S02E01.mkv",
					"The Office Season 3 Complete/The.Office.S03E01.mkv"
				]
			}
		])

		expect(summary.series.map(series => [series.title, Object.keys(series.seasons)])).toEqual([
			["Breaking Bad", ["1", "2"]],
			["Show", ["1", "2"]],
			["The Office", ["3"]]
		])
		expect(summary.movies).toEqual([])
		expect(library.series[1]?.seasons.map(season => season.dirUuid)).toEqual([
			"TV/Show/Show.S01.1080p.WEB",
			"TV/Show/Show.S02.1080p.WEB"
		])
	})

	it.each<[string, string, number]>([
		["Breaking.Bad.S01.1080p.BluRay.x264-GRP", "Breaking.Bad", 1],
		["Show.S02.1080p.WEB", "Show", 2],
		["Breaking Bad Season 1", "Breaking Bad", 1],
		["The Office (US) - Season 3 [1080p]", "The Office (US)", 3],
		["Show S04", "Show", 4],
		["Show Season 1 Complete", "Show", 1]
	])("%s → %s season %i", (name, series, season) => {
		expect(parseSeasonPackName(name)).toEqual({
			series,
			season
		})
	})

	it.each([
		"Open Season (2006)",
		"Series 7 The Contenders (2001)",
		"Season 1",
		"S01",
		"Show S01 Behind the Scenes",
		"Agents of S.H.I.E.L.D"
	])("%s → no pack name", name => {
		expect(parseSeasonPackName(name)).toBeNull()
	})

	it("still treats Open Season 2 as a movie: its name looks like a pack but it holds no episodes", () => {
		expect(parseSeasonPackName("Open Season 2 (2008)")).toEqual({
			series: "Open",
			season: 2
		})
		expect(parseSeasonDirName("Open Season 2 (2008)", false)).toBe(-1)
	})
})

describe("subtitles named after another title", () => {
	it("reads only trailing language and flag tokens", () => {
		const { library, input } = classifyPaths([
			{
				name: "Movies",
				paths: [
					"It (2017)/It (2017).mkv",
					"It (2017)/It.2017.1080p.BluRay.x264-SPARKS.srt",
					"It (2017)/It.2017.1080p.BluRay.x264-SPARKS.forced.en.srt",
					"It (2017)/English.srt"
				]
			}
		])
		const subtitles = library.videos[0]?.subtitles ?? []

		expect(subtitles.map(subtitle => [input.files[subtitle.file]?.name, subtitle.language, subtitle.forced, subtitle.title])).toEqual([
			["It.2017.1080p.BluRay.x264-SPARKS.srt", null, false, ""],
			["It.2017.1080p.BluRay.x264-SPARKS.forced.en.srt", "en", true, ""],
			["English.srt", "en", false, ""]
		])
	})

	it("reads the tokens of a name whose lowercase form is longer", () => {
		// "İ" lowercases to two code units, so offsets taken from the lowercase stem land one character early.
		const { library, input } = classifyPaths([
			{
				name: "Movies",
				paths: [
					"İstanbul (2020)/İstanbul.2020.mkv",
					"İstanbul (2020)/İstanbul.2020.en.forced.srt",
					"İzmir (2021)/İzmir (2021) - 1080p.mkv",
					"İzmir (2021)/İzmir (2021) - 4K.mkv",
					"İzmir (2021)/İzmir (2021).de.sdh.srt"
				]
			}
		])
		const tracks = library.videos.map(video =>
			video.subtitles.map(subtitle => [input.files[subtitle.file]?.name, subtitle.language, subtitle.forced, subtitle.sdh])
		)

		expect(tracks).toEqual(
			expect.arrayContaining([[["İstanbul.2020.en.forced.srt", "en", true, false]], [["İzmir (2021).de.sdh.srt", "de", false, true]]])
		)
		expect(tracks.filter(subtitles => subtitles[0]?.[0] === "İzmir (2021).de.sdh.srt")).toHaveLength(2)
	})

	it.each<[string, string | null, boolean, boolean]>([
		["It.2017.1080p.BluRay.x264-SPARKS", null, false, false],
		["English", "en", false, false],
		["2_English", "en", false, false],
		["Some.Movie.de.forced", "de", true, false],
		["Some.Movie.en.sdh", "en", false, true],
		["German.Film.Title", null, false, false],
		["French", "fr", false, false]
	])("%s → %s forced=%s sdh=%s", (stem, language, forced, sdh) => {
		expect(parseUnmatchedSubtitleName(stem)).toMatchObject({
			language,
			forced,
			sdh,
			title: ""
		})
	})
})

describe("sidecars shared by versions", () => {
	it("applies subtitles, artwork, nfo and edl named after the title to every version", () => {
		const { library, input } = classifyPaths([
			{
				name: "Movies",
				paths: [
					"Up (2009)/Up (2009) - 1080p.mkv",
					"Up (2009)/Up (2009) - 4K.mkv",
					"Up (2009)/Up (2009).en.srt",
					"Up (2009)/Up (2009)-poster.jpg",
					"Up (2009)/Up (2009).nfo",
					"Up (2009)/Up (2009).edl"
				]
			}
		])
		const name = (file: number): string => (file === NO_FILE ? "-" : (input.files[file]?.name ?? "?"))
		const movie = library.movies[0]
		const versions = movie?.versions.map(version => library.videos[version.parts[0] ?? -1]) ?? []

		expect(versions.map(video => [video?.subtitles.map(subtitle => subtitle.language), name(video?.edl ?? NO_FILE)])).toEqual([
			[["en"], "Up (2009).edl"],
			[["en"], "Up (2009).edl"]
		])
		expect([name(movie?.art.poster ?? NO_FILE), name(movie?.nfo ?? NO_FILE)]).toEqual(["Up (2009)-poster.jpg", "Up (2009).nfo"])
	})
})

describe("episode order", () => {
	it("puts unnumbered episodes after dated ones", () => {
		const { summary } = classifyPaths([
			{
				name: "TV",
				paths: [
					"Daily/tvshow.nfo",
					"Daily/Season 2020/Bonus Chat.mkv",
					"Daily/Season 2020/Daily 2020-01-02.mkv",
					"Daily/Season 2020/Daily 2020-01-01.mkv"
				]
			}
		])

		expect(summary.series[0]?.seasons[2020]).toEqual([
			"D20200101  = TV/Daily/Season 2020/Daily 2020-01-01.mkv",
			"D20200102  = TV/Daily/Season 2020/Daily 2020-01-02.mkv",
			"E0 Bonus Chat = TV/Daily/Season 2020/Bonus Chat.mkv"
		])
	})
})

describe("TypeScript files", () => {
	it("never lists declaration files, whatever their size", () => {
		const { summary } = classifyPaths([
			{
				name: "Code",
				paths: ["node_modules/typescript/lib/lib.dom.d.ts", "src/app.ts", "Recording/Broadcast (2001).ts"],
				sizes: {
					"node_modules/typescript/lib/lib.dom.d.ts": 5 * 1024 * 1024,
					"src/app.ts": 4096
				}
			}
		])

		expect(summary.movies.map(movie => movie.versions)).toEqual([["Code/Recording/Broadcast (2001).ts"]])
		expect(summary.others).toEqual([])
	})
})

describe("hostile names", () => {
	const long = 64 * 1024
	const names = [
		"[".repeat(long / 2) + "a",
		`a${" ".repeat(long)}b`,
		`${"(".repeat(long / 2)}2010`,
		"{".repeat(long),
		`s1${" ".repeat(long)}x`,
		`1x02${" ".repeat(long)}-1x03`,
		`Movie${"-".repeat(long)}trailer`,
		".".repeat(long),
		"a.".repeat(long / 2),
		`Show${" - ".repeat(long / 3)}01`,
		`A ${"1".repeat(long)}`,
		`Season${" ".repeat(long)}1`,
		`x${"_".repeat(long)}cd1`,
		`Movie (2010)${" ".repeat(long)}(`,
		`${"[a".repeat(long / 2)}]`,
		`S01E01${"-e".repeat(long / 2)}`,
		`Title${" .".repeat(long / 2)}2010`,
		"【".repeat(long)
	]

	it("parses 64k-character names in linear time", () => {
		const started = performance.now()

		for (const name of names) {
			displayTitle(name)
			splitTitleYear(name)
			mergeKey(name)
			stripNameTags(name)
			normalizeSeparators(name)
			identityKey(name)
			parseEpisode(name, false)
			parseEpisode(name, true)
			episodeTitleText(name)
			parseSeasonDirName(name, false)
			parseSeasonDirName(name, true)
			parseSeasonPackName(name)
			parseStackPart(name)
			parseExtraName(name)
			versionLabel(name, name)
			commonStemPrefix([name, `${name}x`])
			videoSortName(name)
			isIgnoredFileName(name, name.toLowerCase())
			isCameraStem(name)
			parseResolution(name)
			dynamicRangeLabel(name)
			parseUnmatchedSubtitleName(name)
		}

		const elapsed = performance.now() - started

		console.info(`parsed ${names.length} hostile names in ${elapsed.toFixed(1)} ms`)
		// Linear parsing takes ~100 ms locally and ~550 ms on a loaded CI runner; quadratic behaviour on 64k
		// characters would take tens of seconds, so the budget leaves CI headroom and still catches it.
		expect(elapsed).toBeLessThan(2000)
	})

	it("classifies a library of hostile names quickly", () => {
		const started = performance.now()
		const { library } = classifyPaths([
			{
				name: "Media",
				paths: names.flatMap((name, index) => [`dir${index}/${name}.mkv`, `dir${index}/${name}.en.srt`, `Mixed/${name}.mkv`])
			}
		])

		expect(library.videos.length).toBeGreaterThan(0)
		expect(performance.now() - started).toBeLessThan(1500)
	})
})

describe("cosmetics", () => {
	it.each([
		["千と千尋の神隠し（2001）", "千と千尋の神隠し", 2001],
		["【字幕组】Movie (2010)", "Movie", 2010],
		["Movie［2010］", "Movie", 2010],
		["S.W.A.T.2003", "S.W.A.T.", 2003],
		["S.W.A.T. (2003)", "S.W.A.T.", 2003],
		["Movie(2010)", "Movie", 2010]
	])("displayTitle(%s) → %s (%i)", (name, title, year) => {
		expect(displayTitle(name)).toEqual({
			title,
			year
		})
	})

	it.each([
		[" (BD 1080p)", ""],
		[" Pilot (BD 1080p)", "Pilot"],
		[" Pilot (Part 1)", "Pilot (Part 1)"],
		[" Pilot （2013）", "Pilot"],
		[" Pilot 【1080p】", "Pilot"]
	])("episodeTitleText(%s) → %s", (rest, title) => {
		expect(episodeTitleText(rest)).toBe(title)
	})

	it.each<[string, number, number]>([
		["Show.1x01.1x02", 1, 2],
		["Show 1x01 1x02", 1, 2],
		["Show.1x01.2x02", 1, 1],
		["Show.S01E01.S01E02", 1, 2],
		["Show.S01E01-S02E02", 1, 1]
	])("%s → episodes %i-%i", (stem, episode, episodeEnd) => {
		expect(parseEpisode(stem, false)).toMatchObject({
			episode,
			episodeEnd
		})
	})
})

describe("titles sharing a mixed directory", () => {
	it("groups same title and year into one movie with versions", () => {
		const { summary } = classifyPaths([
			{
				name: "Movies",
				paths: [
					"Mixed/Alien (1979).mkv",
					"Mixed/Alien (1979) - Director's Cut.mkv",
					"Mixed/Alien (1979) - 1080p.mkv",
					"Mixed/Alien (1979)-trailer.mkv",
					"Mixed/Heat (1995).mkv",
					"Mixed/Heat.1995.2160p.mkv"
				]
			}
		])

		expect(summary.movies).toEqual([
			{
				title: "Alien",
				year: 1979,
				versions: [
					"Movies/Mixed/Alien (1979).mkv",
					"1080p: Movies/Mixed/Alien (1979) - 1080p.mkv",
					"Director's Cut: Movies/Mixed/Alien (1979) - Director's Cut.mkv"
				],
				extras: ["trailer: Movies/Mixed/Alien (1979)-trailer.mkv"]
			},
			{
				title: "Heat",
				year: 1995,
				versions: ["2160p: Movies/Mixed/Heat.1995.2160p.mkv", "Movies/Mixed/Heat (1995).mkv"],
				extras: []
			}
		])
	})
})
