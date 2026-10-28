import { describe, expect, it } from "vitest"
import { CLASSIFIER_VERSION, NO_FILE, classifyVideoLibrary, classifyVideoLibrarySteps } from "@filen/shared/videos"
import { classifyPaths, fixtureInput } from "./libraryFixture"

describe("movies", () => {
	it("reads movie directories, loose titles, stacks and camera clips", () => {
		const { summary } = classifyPaths([
			{
				name: "Media",
				paths: [
					"Alien (1979)/Alien (1979).mkv",
					"Amélie (2001)/Amélie.2001.1080p.BluRay.x264.mkv",
					"Inception/Inception.mkv",
					"千と千尋の神隠し (2001)/千と千尋の神隠し (2001).mp4",
					"Collection/Heat.1995.1080p.mkv",
					"Collection/Ronin (1998).mkv",
					"Collection/Kill Bill cd1.mkv",
					"Collection/Kill Bill cd2.mkv",
					"Collection/Kill Bill cd3.mkv",
					"Collection/holiday.mp4",
					"Collection/IMG_2041.MOV",
					"Collection/20190514_123456.mp4",
					"Phone/VID_20230101_101010.mp4",
					"Old/Nosferatu (1922).avi",
					"Loose Root Movie (1999).mkv",
					"homevideo.mp4"
				]
			}
		])

		expect(summary.movies).toEqual([
			{
				title: "Loose Root Movie",
				year: 1999,
				versions: ["Media/Loose Root Movie (1999).mkv"],
				extras: []
			},
			{
				title: "Alien",
				year: 1979,
				versions: ["Media/Alien (1979)/Alien (1979).mkv"],
				extras: []
			},
			{
				title: "Amélie",
				year: 2001,
				versions: ["Media/Amélie (2001)/Amélie.2001.1080p.BluRay.x264.mkv"],
				extras: []
			},
			{
				title: "Inception",
				year: 0,
				versions: ["Media/Inception/Inception.mkv"],
				extras: []
			},
			{
				title: "千と千尋の神隠し",
				year: 2001,
				versions: ["Media/千と千尋の神隠し (2001)/千と千尋の神隠し (2001).mp4"],
				extras: []
			},
			{
				title: "Heat",
				year: 1995,
				versions: ["Media/Collection/Heat.1995.1080p.mkv"],
				extras: []
			},
			{
				title: "Ronin",
				year: 1998,
				versions: ["Media/Collection/Ronin (1998).mkv"],
				extras: []
			},
			{
				title: "Kill Bill",
				year: 0,
				versions: ["Media/Collection/Kill Bill cd1.mkv + Media/Collection/Kill Bill cd2.mkv + Media/Collection/Kill Bill cd3.mkv"],
				extras: []
			},
			{
				title: "Nosferatu",
				year: 1922,
				versions: ["Media/Old/Nosferatu (1922).avi"],
				extras: []
			}
		])
		expect(summary.others).toEqual([
			"Media/homevideo.mp4",
			"Media/Collection/holiday.mp4",
			"Media/Collection/IMG_2041.MOV",
			"Media/Collection/20190514_123456.mp4",
			"Media/Phone/VID_20230101_101010.mp4"
		])
		expect(summary.series).toEqual([])
	})

	it("groups versions in a movie directory, resolution-labelled first", () => {
		const { summary } = classifyPaths([
			{
				name: "Movies",
				paths: [
					"Blade Runner (1982)/Blade Runner (1982) - 1080p.mkv",
					"Blade Runner (1982)/Blade Runner (1982) - 2160p.mkv",
					"Blade Runner (1982)/Blade Runner (1982) [Final Cut].mkv",
					"Blade Runner (1982)/Blade Runner (1982) {edition-Theatrical}.mkv",
					"Heat (1995)/Heat (1995).mkv",
					"Heat (1995)/Heat (1995) - 720p.mkv",
					"Dune (2021)/Dune.2021.2160p.HDR.mkv",
					"Dune (2021)/Dune.2021.1080p.mkv",
					"Two Films/Alpha (2018).mkv",
					"Two Films/Beta (2019).mkv",
					"Long Movie (1990)/Long Movie (1990) - cd1.mkv",
					"Long Movie (1990)/Long Movie (1990) - cd2.mkv",
					"Long Movie (1990)/Long Movie (1990) - 1080p.mkv"
				]
			}
		])

		expect(summary.movies).toEqual([
			{
				title: "Blade Runner",
				year: 1982,
				versions: [
					"2160p: Movies/Blade Runner (1982)/Blade Runner (1982) - 2160p.mkv",
					"1080p: Movies/Blade Runner (1982)/Blade Runner (1982) - 1080p.mkv",
					"Final Cut: Movies/Blade Runner (1982)/Blade Runner (1982) [Final Cut].mkv",
					"Theatrical: Movies/Blade Runner (1982)/Blade Runner (1982) {edition-Theatrical}.mkv"
				],
				extras: []
			},
			{
				title: "Heat",
				year: 1995,
				versions: ["Movies/Heat (1995)/Heat (1995).mkv", "720p: Movies/Heat (1995)/Heat (1995) - 720p.mkv"],
				extras: []
			},
			{
				title: "Dune",
				year: 2021,
				versions: ["2160p HDR: Movies/Dune (2021)/Dune.2021.2160p.HDR.mkv", "1080p: Movies/Dune (2021)/Dune.2021.1080p.mkv"],
				extras: []
			},
			{
				title: "Alpha",
				year: 2018,
				versions: ["Movies/Two Films/Alpha (2018).mkv"],
				extras: []
			},
			{
				title: "Beta",
				year: 2019,
				versions: ["Movies/Two Films/Beta (2019).mkv"],
				extras: []
			},
			{
				title: "Long Movie",
				year: 1990,
				versions: [
					"Movies/Long Movie (1990)/Long Movie (1990) - cd1.mkv + Movies/Long Movie (1990)/Long Movie (1990) - cd2.mkv",
					"1080p: Movies/Long Movie (1990)/Long Movie (1990) - 1080p.mkv"
				],
				extras: []
			}
		])
	})

	it("attaches extras by directory and by suffix and drops orphans", () => {
		const { summary } = classifyPaths([
			{
				name: "Movies",
				paths: [
					"Alien (1979)/Alien (1979).mkv",
					"Alien (1979)/Alien (1979)-trailer.mkv",
					"Alien (1979)/trailer.mp4",
					"Alien (1979)/Alien (1979) - Interview.mkv",
					"Alien (1979)/Featurettes/Making of Alien.mkv",
					"Alien (1979)/Behind The Scenes/Set Tour.mkv",
					"Alien (1979)/Deleted Scenes/Scene 1.mkv",
					"Alien (1979)/Extras/Nested/Deep Extra.mkv",
					"Alien (1979)/Bonus Disc/Shorts/Short Film.mkv",
					"Mixed/Heat (1995).mkv",
					"Mixed/Heat (1995)-trailer.mkv",
					"Mixed/Ronin (1998).mkv",
					"Mixed/Unknown Film-trailer.mkv",
					"Mixed/trailer.mkv",
					"Mixed/Trailers/Some Trailer.mkv",
					"Trailers/Root Level Trailer (2020).mkv",
					"Nowhere/Extras/Lonely Extra.mkv"
				]
			}
		])

		expect(summary.movies).toEqual([
			{
				title: "Alien",
				year: 1979,
				versions: ["Movies/Alien (1979)/Alien (1979).mkv"],
				extras: [
					"trailer: Movies/Alien (1979)/Alien (1979)-trailer.mkv",
					"trailer: Movies/Alien (1979)/trailer.mp4",
					"featurette: Movies/Alien (1979)/Featurettes/Making of Alien.mkv",
					"behindTheScenes: Movies/Alien (1979)/Behind The Scenes/Set Tour.mkv",
					"deletedScene: Movies/Alien (1979)/Deleted Scenes/Scene 1.mkv",
					"interview: Movies/Alien (1979)/Alien (1979) - Interview.mkv",
					"short: Movies/Alien (1979)/Bonus Disc/Shorts/Short Film.mkv",
					"unknown: Movies/Alien (1979)/Extras/Nested/Deep Extra.mkv"
				]
			},
			{
				title: "Heat",
				year: 1995,
				versions: ["Movies/Mixed/Heat (1995).mkv"],
				extras: ["trailer: Movies/Mixed/Heat (1995)-trailer.mkv"]
			},
			{
				title: "Ronin",
				year: 1998,
				versions: ["Movies/Mixed/Ronin (1998).mkv"],
				extras: []
			},
			{
				title: "Root Level Trailer",
				year: 2020,
				versions: ["Movies/Trailers/Root Level Trailer (2020).mkv"],
				extras: []
			}
		])
		expect(summary.others).toEqual([])
	})

	it("treats DVD and Blu-ray folder structures as one unplayable movie", () => {
		const { library, summary } = classifyPaths([
			{
				name: "Movies",
				paths: [
					"Old Disc (1999)/VIDEO_TS/VTS_01_1.VOB",
					"Old Disc (1999)/VIDEO_TS/VIDEO_TS.IFO",
					"Blu (2010)/BDMV/STREAM/00001.m2ts",
					"Blu (2010)/Blu (2010)-trailer.mkv"
				]
			}
		])

		expect(summary.movies.map(movie => [movie.title, movie.year, movie.versions.length, movie.extras.length])).toEqual([
			["Old Disc", 1999, 0, 0],
			["Blu", 2010, 0, 1]
		])
		expect(library.movies.every(movie => movie.disc)).toBe(true)
		expect(summary.others).toEqual([])
	})

	it("keeps acronyms, unicode and edge-case titles intact", () => {
		const { summary } = classifyPaths([
			{
				name: "Movies",
				paths: [
					"L.A. Confidential (1997)/L.A. Confidential (1997).mkv",
					"R.I.P.D. (2013)/R.I.P.D. (2013).mkv",
					"Léon (1994)/Léon (1994).mkv",
					"Крёстный отец (1972)/Крёстный отец (1972).mkv",
					"1917 (2019)/1917 (2019).mkv",
					"2001 A Space Odyssey (1968)/2001.A.Space.Odyssey.1968.mkv",
					"Se7en (1995)/Se7en (1995).mkv",
					"[REC] (2007)/[REC] (2007).mkv",
					"The Big Short (2015)/The Big Short (2015).mkv",
					"Short Term 12 (2013)/Short Term 12 (2013).mkv"
				]
			}
		])

		expect(summary.movies.map(movie => `${movie.title} (${movie.year}) ${movie.versions.length}`)).toEqual([
			"L.A. Confidential (1997) 1",
			"R.I.P.D. (2013) 1",
			"Léon (1994) 1",
			"Крёстный отец (1972) 1",
			"1917 (2019) 1",
			"2001 A Space Odyssey (1968) 1",
			"Se7en (1995) 1",
			"[REC] (2007) 1",
			"The Big Short (2015) 1",
			"Short Term 12 (2013) 1"
		])
	})

	it("sort names drop only a leading article", () => {
		const { library } = classifyPaths([
			{
				name: "Movies",
				paths: ["The Matrix (1999)/The Matrix (1999).mkv", "A.I. (2001)/A.I. (2001).mkv", "Theory (2010)/Theory (2010).mkv"]
			}
		])

		expect(library.movies.map(movie => movie.sortName)).toEqual(["Matrix", "A I", "Theory"])
	})
})

describe("series", () => {
	it("reads a standard show layout", () => {
		const { summary } = classifyPaths([
			{
				name: "TV",
				paths: [
					"Breaking Bad (2008)/tvshow.nfo",
					"Breaking Bad (2008)/Season 1/Breaking.Bad.S01E01.Pilot.1080p.mkv",
					"Breaking Bad (2008)/Season 1/Breaking.Bad.S01E02.Cats.in.the.Bag.1080p.mkv",
					"Breaking Bad (2008)/Season 1/Breaking.Bad.S01E03-E04.mkv",
					"Breaking Bad (2008)/Season 2/Breaking Bad - 2x01 - Seven Thirty-Seven.mkv",
					"Breaking Bad (2008)/Season 2/Breaking Bad - S02E02 - Grilled.mkv",
					"Breaking Bad (2008)/Specials/Breaking Bad S00E01 Good Cop Bad Cop.mkv",
					"Breaking Bad (2008)/Season 5 (2012)/Breaking.Bad.S05E14.Ozymandias.mkv",
					"Breaking Bad (2008)/Season 5 (2012)/Breaking.Bad.S05E16.Felina.mkv"
				]
			}
		])

		expect(summary.series).toEqual([
			{
				title: "Breaking Bad",
				year: 2008,
				seasons: {
					0: ["E1 Good Cop Bad Cop = TV/Breaking Bad (2008)/Specials/Breaking Bad S00E01 Good Cop Bad Cop.mkv"],
					1: [
						"E1 Pilot = TV/Breaking Bad (2008)/Season 1/Breaking.Bad.S01E01.Pilot.1080p.mkv",
						"E2 Cats in the Bag = TV/Breaking Bad (2008)/Season 1/Breaking.Bad.S01E02.Cats.in.the.Bag.1080p.mkv",
						"E3-4  = TV/Breaking Bad (2008)/Season 1/Breaking.Bad.S01E03-E04.mkv"
					],
					2: [
						"E1 Seven Thirty-Seven = TV/Breaking Bad (2008)/Season 2/Breaking Bad - 2x01 - Seven Thirty-Seven.mkv",
						"E2 Grilled = TV/Breaking Bad (2008)/Season 2/Breaking Bad - S02E02 - Grilled.mkv"
					],
					5: [
						"E14 Ozymandias = TV/Breaking Bad (2008)/Season 5 (2012)/Breaking.Bad.S05E14.Ozymandias.mkv",
						"E16 Felina = TV/Breaking Bad (2008)/Season 5 (2012)/Breaking.Bad.S05E16.Felina.mkv"
					]
				},
				extras: []
			}
		])
		expect(summary.movies).toEqual([])
	})

	it("recognises shows without season directories and the file's own season", () => {
		const { summary } = classifyPaths([
			{
				name: "TV",
				paths: [
					"Fargo/Fargo.S01E01.mkv",
					"Fargo/Fargo.S01E02.mkv",
					"Fargo/Fargo.S02E01.mkv",
					"Sherlock (2010)/Sherlock (2010) S01E01.mkv",
					"Mixed Season/Season 1/Show S02E05.mkv",
					"Mixed Season/Season 1/Show S01E01.mkv",
					"Numbered/1/Numbered 1x01.mkv",
					"Numbered/2/Numbered 2x01.mkv",
					"Numbered/Season 1/Numbered 1x02.mkv"
				]
			}
		])

		expect(summary.series).toEqual([
			{
				title: "Fargo",
				year: 0,
				seasons: {
					1: ["E1  = TV/Fargo/Fargo.S01E01.mkv", "E2  = TV/Fargo/Fargo.S01E02.mkv"],
					2: ["E1  = TV/Fargo/Fargo.S02E01.mkv"]
				},
				extras: []
			},
			{
				title: "Sherlock",
				year: 2010,
				seasons: {
					1: ["E1  = TV/Sherlock (2010)/Sherlock (2010) S01E01.mkv"]
				},
				extras: []
			},
			{
				title: "Mixed Season",
				year: 0,
				seasons: {
					1: ["E1  = TV/Mixed Season/Season 1/Show S01E01.mkv"],
					2: ["E5  = TV/Mixed Season/Season 1/Show S02E05.mkv"]
				},
				extras: []
			},
			{
				title: "Numbered",
				year: 0,
				seasons: {
					1: ["E1  = TV/Numbered/1/Numbered 1x01.mkv", "E2  = TV/Numbered/Season 1/Numbered 1x02.mkv"],
					2: ["E1  = TV/Numbered/2/Numbered 2x01.mkv"]
				},
				extras: []
			}
		])
	})

	it("uses loose and date numbering only inside a known series", () => {
		const { summary } = classifyPaths([
			{
				name: "TV",
				paths: [
					"Anime/Season 1/[Subs] Anime - 01 [1080p][ABCD1234].mkv",
					"Anime/Season 1/[Subs] Anime - 02v2 [1080p].mkv",
					"Anime/Season 1/[Subs] Anime - 03 (1080p).mkv",
					"Anime/Season 2/Anime Ep 01.mkv",
					"Anime/Season 2/02 - Second.mkv",
					"Daily Show/tvshow.nfo",
					"Daily Show/Daily Show 2020-01-02.mkv",
					"Daily Show/Daily Show 2020-01-03 Guest Name.mkv",
					"Daily Show/Daily Show 2021-03-04.mkv",
					"Not A Show/Not A Show - 01.mkv",
					"Not A Show/Not A Show - 02.mkv"
				]
			}
		])

		expect(summary.series).toEqual([
			{
				title: "Anime",
				year: 0,
				seasons: {
					1: [
						"E1  = TV/Anime/Season 1/[Subs] Anime - 01 [1080p][ABCD1234].mkv",
						"E2  = TV/Anime/Season 1/[Subs] Anime - 02v2 [1080p].mkv",
						"E3  = TV/Anime/Season 1/[Subs] Anime - 03 (1080p).mkv"
					],
					2: ["E1  = TV/Anime/Season 2/Anime Ep 01.mkv", "E2 Second = TV/Anime/Season 2/02 - Second.mkv"]
				},
				extras: []
			},
			{
				title: "Daily Show",
				year: 0,
				seasons: {
					2020: [
						"D20200102  = TV/Daily Show/Daily Show 2020-01-02.mkv",
						"D20200103 Guest Name = TV/Daily Show/Daily Show 2020-01-03 Guest Name.mkv"
					],
					2021: ["D20210304  = TV/Daily Show/Daily Show 2021-03-04.mkv"]
				},
				extras: []
			}
		])
		// Outside a series "- 01" is no episode number: the files read as versions of one title.
		expect(summary.movies).toEqual([
			{
				title: "Not A Show",
				year: 0,
				versions: ["01: TV/Not A Show/Not A Show - 01.mkv", "02: TV/Not A Show/Not A Show - 02.mkv"],
				extras: []
			}
		])
	})

	it("lets the root itself be a series", () => {
		const { library, summary } = classifyPaths([
			{
				name: "The Wire",
				paths: ["Season 1/The.Wire.S01E01.mkv", "Season 1/The.Wire.S01E02.mkv", "Season 2/The.Wire.S02E01.mkv"]
			},
			{
				name: "Loose Episodes",
				paths: ["Mythbusters S01E01.mkv", "Mythbusters S01E02.mkv", "Mythbusters S01E03.mkv"]
			}
		])

		expect(summary.series.map(series => [series.title, Object.keys(series.seasons).length])).toEqual([
			["The Wire", 2],
			["Mythbusters", 1]
		])
		expect(library.series.map(series => series.id)).toEqual(["The Wire", "Loose Episodes"])
	})

	it("collects multi-episode files, episode versions, unnumbered files and series extras", () => {
		const { summary } = classifyPaths([
			{
				name: "TV",
				paths: [
					"Show (2015)/Season 1/Show S01E01 1080p.mkv",
					"Show (2015)/Season 1/Show S01E01 720p.mkv",
					"Show (2015)/Season 1/Show S01E02E03.mkv",
					"Show (2015)/Season 1/Show S01E04-05.mkv",
					"Show (2015)/Season 1/Behind the camera.mkv",
					"Show (2015)/Season 1/Show S01E01-trailer.mkv",
					"Show (2015)/Featurettes/Cast Interview.mkv",
					"Show (2015)/Extras/Blooper Reel.mkv",
					"Show (2015)/trailer.mkv",
					"Other Show (2001)/Season 1/Other Show S01E01.mkv",
					"Other Show (2001)/Extras/Other Show S00E01 Special.mkv",
					"Other Show (2001)/Extras/Other Show S00E02 Special Two.mkv"
				]
			}
		])

		expect(summary.series).toEqual([
			{
				title: "Show",
				year: 2015,
				seasons: {
					1: [
						"E1  = 1080p: TV/Show (2015)/Season 1/Show S01E01 1080p.mkv | 720p: TV/Show (2015)/Season 1/Show S01E01 720p.mkv",
						"E2-3  = TV/Show (2015)/Season 1/Show S01E02E03.mkv",
						"E4-5  = TV/Show (2015)/Season 1/Show S01E04-05.mkv",
						"E0 Behind the camera = TV/Show (2015)/Season 1/Behind the camera.mkv"
					]
				},
				extras: [
					"trailer: TV/Show (2015)/Season 1/Show S01E01-trailer.mkv",
					"trailer: TV/Show (2015)/trailer.mkv",
					"featurette: TV/Show (2015)/Featurettes/Cast Interview.mkv",
					"unknown: TV/Show (2015)/Extras/Blooper Reel.mkv"
				]
			},
			{
				title: "Other Show",
				year: 2001,
				seasons: {
					0: [
						"E1 Special = TV/Other Show (2001)/Extras/Other Show S00E01 Special.mkv",
						"E2 Special Two = TV/Other Show (2001)/Extras/Other Show S00E02 Special Two.mkv"
					],
					1: ["E1  = TV/Other Show (2001)/Season 1/Other Show S01E01.mkv"]
				},
				extras: []
			}
		])
	})

	it("does not take movies with an episode-like name for a series", () => {
		const { summary } = classifyPaths([
			{
				name: "Media",
				paths: [
					"Downloads/Alpha (2010).mkv",
					"Downloads/Beta (2011).mkv",
					"Downloads/Gamma (2012).mkv",
					"Downloads/Show S01E01.mkv",
					"Downloads/Other S01E01.mkv",
					"Seasons of Life (2005)/Seasons of Life (2005).mkv"
				]
			}
		])

		expect(summary.series).toEqual([])
		expect(summary.movies.map(movie => movie.title)).toEqual(["Alpha", "Beta", "Gamma", "Seasons of Life"])
		expect(summary.others).toEqual(["Media/Downloads/Show S01E01.mkv", "Media/Downloads/Other S01E01.mkv"])
	})

	it("names a series after its files when they sit in a general directory", () => {
		const { summary } = classifyPaths([
			{
				name: "Media",
				paths: ["Downloads/The.Expanse.S01E01.mkv", "Downloads/The.Expanse.S01E02.mkv"]
			}
		])

		expect(summary.series.map(series => series.title)).toEqual(["The Expanse"])
	})

	it("keeps acronym series names", () => {
		const { summary } = classifyPaths([
			{
				name: "TV",
				paths: [
					"Marvel's Agents of S.H.I.E.L.D. (2013)/Season 1/Marvels.Agents.of.S.H.I.E.L.D.S01E01.mkv",
					"Marvel's Agents of S.H.I.E.L.D. (2013)/Season 1/Marvels.Agents.of.S.H.I.E.L.D.S01E02.mkv"
				]
			}
		])

		expect(summary.series.map(series => `${series.title} (${series.year})`)).toEqual(["Marvel's Agents of S.H.I.E.L.D. (2013)"])
	})
})

describe("root types", () => {
	it("a movies root never yields series or other videos", () => {
		const { summary } = classifyPaths([
			{
				name: "Films",
				type: "movies",
				paths: ["Show S01E01.mkv", "Show S01E02.mkv", "IMG_0001.mp4", "Season 1/Thing.mkv", "Holiday/clip.mp4"]
			}
		])

		expect(summary.series).toEqual([])
		expect(summary.others).toEqual([])
		expect(summary.movies.map(movie => movie.title)).toEqual(["Show S01E01", "Show S01E02", "IMG 0001", "Season 1", "Holiday"])
	})

	it("a shows root makes every top-level directory a series", () => {
		const { summary } = classifyPaths([
			{
				name: "Shows",
				type: "shows",
				paths: ["Nature Docs/Part One.mkv", "Nature Docs/Part Two.mkv", "Cartoon/Season 2/Cartoon - 05.mkv", "loose.mkv"]
			}
		])

		expect(summary.series).toEqual([
			{
				title: "Nature Docs",
				year: 0,
				seasons: {
					1: ["E0 Part One = Shows/Nature Docs/Part One.mkv", "E0 Part Two = Shows/Nature Docs/Part Two.mkv"]
				},
				extras: []
			},
			{
				title: "Cartoon",
				year: 0,
				seasons: {
					2: ["E5  = Shows/Cartoon/Season 2/Cartoon - 05.mkv"]
				},
				extras: []
			}
		])
		expect(summary.movies).toEqual([])
		expect(summary.others).toEqual(["Shows/loose.mkv"])
	})

	it("an other root lists every video as is", () => {
		const { summary } = classifyPaths([
			{
				name: "Clips",
				type: "other",
				paths: [
					"Alien (1979)/Alien (1979).mkv",
					"Alien (1979)/Alien (1979)-trailer.mkv",
					"Show/Show S01E01.mkv",
					"Show/Show S01E02.mkv",
					"a cd1.mkv",
					"a cd2.mkv"
				]
			}
		])

		expect(summary.movies).toEqual([])
		expect(summary.series).toEqual([])
		expect(summary.others).toEqual([
			"Clips/a cd1.mkv",
			"Clips/a cd2.mkv",
			"Clips/Alien (1979)/Alien (1979).mkv",
			"Clips/Alien (1979)/Alien (1979)-trailer.mkv",
			"Clips/Show/Show S01E01.mkv",
			"Clips/Show/Show S01E02.mkv"
		])
	})
})

describe("multiple roots", () => {
	it("merges titles with a year across roots, never without one", () => {
		const { library, summary } = classifyPaths([
			{
				name: "Disk A",
				paths: [
					"Alien (1979)/Alien (1979) - 1080p.mkv",
					"Untitled/Untitled.mkv",
					"Breaking Bad (2008)/Season 1/Breaking Bad S01E01.mkv",
					"Breaking Bad (2008)/Season 1/Breaking Bad S01E02.mkv"
				]
			},
			{
				name: "Disk B",
				paths: [
					"Alien.1979.2160p.mkv",
					"Untitled/Untitled.mkv",
					"Breaking Bad (2008)/Season 1/Breaking Bad S01E02.mkv",
					"Breaking Bad (2008)/Season 2/Breaking Bad S02E01.mkv"
				]
			}
		])

		expect(summary.movies).toEqual([
			{
				title: "Alien",
				year: 1979,
				versions: ["Disk A/Alien (1979)/Alien (1979) - 1080p.mkv", "Disk B/Alien.1979.2160p.mkv"],
				extras: []
			},
			{
				title: "Untitled",
				year: 0,
				versions: ["Disk A/Untitled/Untitled.mkv"],
				extras: []
			},
			{
				title: "Untitled",
				year: 0,
				versions: ["Disk B/Untitled/Untitled.mkv"],
				extras: []
			}
		])
		expect(library.movies[0]?.roots).toEqual([0, 1])
		expect(summary.series).toEqual([
			{
				title: "Breaking Bad",
				year: 2008,
				seasons: {
					1: [
						"E1  = Disk A/Breaking Bad (2008)/Season 1/Breaking Bad S01E01.mkv",
						"E2  = Disk A/Breaking Bad (2008)/Season 1/Breaking Bad S01E02.mkv | Disk B/Breaking Bad (2008)/Season 1/Breaking Bad S01E02.mkv"
					],
					2: ["E1  = Disk B/Breaking Bad (2008)/Season 2/Breaking Bad S02E01.mkv"]
				},
				extras: []
			}
		])
		expect(library.series[0]?.roots).toEqual([0, 1])
	})

	it("keeps same-titled movies of one root apart", () => {
		const { summary } = classifyPaths([
			{
				name: "Movies",
				paths: ["A/Alien (1979)/Alien (1979).mkv", "B/Alien (1979)/Alien (1979).mkv"]
			}
		])

		expect(summary.movies).toHaveLength(2)
	})

	it("hands a nested root's subtree to that root only", () => {
		const input = fixtureInput([
			{
				name: "Outer",
				paths: ["Inner/Alien (1979)/Alien (1979).mkv", "Heat (1995)/Heat (1995).mkv"]
			}
		])

		input.roots.push({
			uuid: "Outer/Inner",
			name: "Inner",
			type: "movies"
		})

		const library = classifyVideoLibrary(input)

		expect(library.movies.map(movie => [movie.title, movie.roots])).toEqual([
			["Heat", [0]],
			["Alien", [1]]
		])
	})
})

describe("transport-stream verdicts", () => {
	it("leaves out a .ts or .mts a content read found to be no transport stream", () => {
		const input = fixtureInput([{ name: "Media", type: "movies", paths: ["Heat (1995).ts", "Alien (1979).mts", "Big (1988).ts"] }])
		const library = classifyVideoLibrary({ ...input, notTransportStream: new Set(["Media/Big (1988).ts", "Media/Alien (1979).mts"]) })

		expect(library.movies.map(movie => movie.title)).toEqual(["Heat"])
	})
})

describe("ignore rules", () => {
	it("skips junk directories, samples, hidden files and .ignore subtrees", () => {
		const { summary } = classifyPaths([
			{
				name: "Media",
				paths: [
					".filen/videos/cache.mp4",
					"@eaDir/Alien (1979).mkv@SynoEAStream.mp4",
					"#recycle/Deleted (2001).mkv",
					"$RECYCLE.BIN/Gone (2002).mkv",
					"System Volume Information/x (2003).mkv",
					"lost+found/y (2004).mkv",
					"Alien (1979)/Alien (1979).mkv",
					"Alien (1979)/Alien (1979)-sample.mkv",
					"Alien (1979)/Sample/sample.mkv",
					"Alien (1979)/extrafanart/fanart1.jpg",
					"Alien (1979)/Alien (1979).trickplay/320 - 10x10/0.jpg",
					"Alien (1979)/._Alien (1979).mkv",
					"Private/.ignore",
					"Private/Secret (2020).mkv",
					"Private/Deeper/Hidden (2021).mkv",
					"Snaps/.snapshot/Old (1990).mkv",
					"Disk/Movie (2010).iso",
					"Disk/Stream (2011).strm",
					"Code/index.ts",
					"Code/notes.txt"
				],
				sizes: {
					"Code/index.ts": 2048
				}
			}
		])

		expect(summary.movies.map(movie => movie.title)).toEqual(["Alien"])
		expect(summary.movies[0]?.versions).toEqual(["Media/Alien (1979)/Alien (1979).mkv"])
		expect(summary.others).toEqual([])
		expect(summary.series).toEqual([])
	})

	it("returns nothing for a root without videos outside ignored places", () => {
		const library = classifyVideoLibrary(
			fixtureInput([
				{
					name: "Junk",
					paths: ["@eaDir/Movie (2000).mkv", ".filen/Movie (2001).mkv", "sample.mkv"]
				},
				{
					name: "Empty",
					paths: ["readme.txt"]
				}
			])
		)

		expect(library).toEqual({
			classifierVersion: CLASSIFIER_VERSION,
			videos: [],
			movies: [],
			series: [],
			others: []
		})
	})
})

describe("sidecars", () => {
	it("attaches subtitles, nfo, edl and artwork to movies", () => {
		const { library, input } = classifyPaths([
			{
				name: "Movies",
				paths: [
					"Alien (1979)/Alien (1979).mkv",
					"Alien (1979)/Alien (1979).en.srt",
					"Alien (1979)/Alien (1979).eng.forced.srt",
					"Alien (1979)/Alien (1979).de.sdh.ass",
					"Alien (1979)/Alien (1979).English.Commentary.vtt",
					"Alien (1979)/Alien (1979).srt",
					"Alien (1979)/Alien (1979).fr.default.ssa",
					"Alien (1979)/Alien (1979).ja.smi",
					"Alien (1979)/Alien (1979).es.idx",
					"Alien (1979)/Alien (1979).es.sub",
					"Alien (1979)/Alien (1979).pt.sub",
					"Alien (1979)/Alien (1979).it.sup",
					"Alien (1979)/Subs/Alien (1979).nl.srt",
					"Alien (1979)/Subs/Swedish.srt",
					"Alien (1979)/Alien (1979).edl",
					"Alien (1979)/movie.nfo",
					"Alien (1979)/poster.jpg",
					"Alien (1979)/folder.jpg",
					"Alien (1979)/Alien (1979)-fanart.jpg",
					"Alien (1979)/fanart.jpg",
					"Alien (1979)/clearlogo.png",
					"Alien (1979)/Other.en.srt",
					"Mixed/Heat (1995).mkv",
					"Mixed/Heat (1995).nfo",
					"Mixed/Heat (1995)-poster.jpg",
					"Mixed/poster.jpg",
					"Mixed/Ronin (1998).mkv",
					"Mixed/Ronin (1998).jpg",
					"Mixed/Ronin (1998).en.srt",
					"Subbed/Movie Name/Movie Name.mkv",
					"Subbed/Movie Name/Subs/Movie Name/2_English.srt",
					"Subbed/Movie Name/Subs/Movie Name/3_French.srt"
				]
			}
		])
		const fileAt = (file: number): string => (file === NO_FILE ? "-" : (input.files[file]?.name ?? "?"))
		const [alien, heat, ronin, named] = library.movies

		expect(alien === undefined || heat === undefined || ronin === undefined || named === undefined).toBe(false)

		if (alien === undefined || heat === undefined || ronin === undefined || named === undefined) {
			return
		}

		const alienVideo = library.videos[alien.versions[0]?.parts[0] ?? -1]

		expect(
			alienVideo?.subtitles.map(subtitle => [
				fileAt(subtitle.file),
				subtitle.format,
				subtitle.language,
				subtitle.forced,
				subtitle.sdh,
				subtitle.isDefault,
				subtitle.title
			])
		).toEqual([
			["Alien (1979).en.srt", "srt", "en", false, false, false, ""],
			["Alien (1979).eng.forced.srt", "srt", "en", true, false, false, ""],
			["Alien (1979).de.sdh.ass", "ass", "de", false, true, false, ""],
			["Alien (1979).English.Commentary.vtt", "vtt", "en", false, false, false, "Commentary"],
			["Alien (1979).srt", "srt", null, false, false, false, ""],
			["Alien (1979).fr.default.ssa", "ssa", "fr", false, false, true, ""],
			["Alien (1979).ja.smi", "smi", "ja", false, false, false, ""],
			["Alien (1979).es.idx", "vobsub", "es", false, false, false, ""],
			["Alien (1979).pt.sub", "microdvd", "pt", false, false, false, ""],
			["Alien (1979).it.sup", "pgs", "it", false, false, false, ""],
			["Other.en.srt", "srt", "en", false, false, false, ""],
			["Alien (1979).nl.srt", "srt", "nl", false, false, false, ""],
			["Swedish.srt", "srt", "sv", false, false, false, ""]
		])
		expect(fileAt(alienVideo?.edl ?? NO_FILE)).toBe("Alien (1979).edl")
		expect(fileAt(alien.nfo)).toBe("movie.nfo")
		expect([fileAt(alien.art.poster), fileAt(alien.art.backdrop), fileAt(alien.art.logo)]).toEqual([
			"poster.jpg",
			"Alien (1979)-fanart.jpg",
			"clearlogo.png"
		])

		expect(fileAt(heat.nfo)).toBe("Heat (1995).nfo")
		expect(fileAt(heat.art.poster)).toBe("Heat (1995)-poster.jpg")
		expect(fileAt(ronin.art.poster)).toBe("Ronin (1998).jpg")
		expect(library.videos[ronin.versions[0]?.parts[0] ?? -1]?.subtitles.map(subtitle => subtitle.language)).toEqual(["en"])

		expect(
			library.videos[named.versions[0]?.parts[0] ?? -1]?.subtitles.map(subtitle => [fileAt(subtitle.file), subtitle.language])
		).toEqual([
			["2_English.srt", "en"],
			["3_French.srt", "fr"]
		])
	})

	it("treats a poster or nfo beside a loose file as a movie marker", () => {
		const { summary } = classifyPaths([
			{
				name: "Media",
				paths: [
					"Stuff/Obscure Film.mkv",
					"Stuff/Obscure Film.nfo",
					"Stuff/Another Film.mkv",
					"Stuff/Another Film-poster.png",
					"Stuff/Just A Clip.mkv"
				]
			}
		])

		expect(summary.movies.map(movie => movie.title)).toEqual(["Obscure Film", "Another Film"])
		expect(summary.others).toEqual(["Media/Stuff/Just A Clip.mkv"])
	})

	it("attaches series, season and episode artwork and nfo files", () => {
		const { library, input } = classifyPaths([
			{
				name: "TV",
				paths: [
					"Show (2015)/tvshow.nfo",
					"Show (2015)/poster.jpg",
					"Show (2015)/fanart.jpg",
					"Show (2015)/logo.png",
					"Show (2015)/season02-poster.jpg",
					"Show (2015)/season-specials-poster.jpg",
					"Show (2015)/Season 1/season.nfo",
					"Show (2015)/Season 1/folder.jpg",
					"Show (2015)/Season 1/Show S01E01.mkv",
					"Show (2015)/Season 1/Show S01E01.nfo",
					"Show (2015)/Season 1/Show S01E01-thumb.jpg",
					"Show (2015)/Season 1/Show S01E01.en.srt",
					"Show (2015)/Season 1/Show S01E02.mkv",
					"Show (2015)/Season 1/metadata/Show S01E02.jpg",
					"Show (2015)/Season 1/Show S01E03.mkv",
					"Show (2015)/Season 1/Show S01E03.jpg",
					"Show (2015)/Season 2/Show S02E01.mkv",
					"Show (2015)/Specials/Show S00E01.mkv"
				]
			}
		])
		const fileAt = (file: number): string => (file === NO_FILE ? "-" : (input.files[file]?.name ?? "?"))
		const series = library.series[0]

		expect(series === undefined).toBe(false)

		if (series === undefined) {
			return
		}

		expect([fileAt(series.nfo), fileAt(series.art.poster), fileAt(series.art.backdrop), fileAt(series.art.logo)]).toEqual([
			"tvshow.nfo",
			"poster.jpg",
			"fanart.jpg",
			"logo.png"
		])
		expect(series.seasons.map(season => [season.number, season.dirUuid, fileAt(season.nfo), fileAt(season.art.poster)])).toEqual([
			[0, "TV/Show (2015)/Specials", "-", "season-specials-poster.jpg"],
			[1, "TV/Show (2015)/Season 1", "season.nfo", "folder.jpg"],
			[2, "TV/Show (2015)/Season 2", "-", "season02-poster.jpg"]
		])

		const episodes = series.seasons[1]?.episodes ?? []
		const videoOf = (index: number) => library.videos[episodes[index]?.versions[0]?.parts[0] ?? -1]

		expect([fileAt(videoOf(0)?.nfo ?? NO_FILE), fileAt(videoOf(0)?.thumb ?? NO_FILE), videoOf(0)?.subtitles.length]).toEqual([
			"Show S01E01.nfo",
			"Show S01E01-thumb.jpg",
			1
		])
		expect(fileAt(videoOf(1)?.thumb ?? NO_FILE)).toBe("Show S01E02.jpg")
		expect(fileAt(videoOf(2)?.thumb ?? NO_FILE)).toBe("Show S01E03.jpg")
	})
})

describe("output shape", () => {
	it("is flat, index-based and carries ids, dates and container flags", () => {
		const input = fixtureInput([
			{
				name: "Movies",
				paths: ["Alien (1979)/Alien (1979).mkv", "Alien (1979)/Alien (1979) - 720p.avi", "Loose (2000).mp4"]
			}
		])

		input.files[0] = {
			...(input.files[0] ?? {
				uuid: "",
				parent: "",
				name: "",
				size: 0,
				timestamp: 0
			}),
			stableUuid: "stable-alien",
			dateAdded: 500
		}

		const library = classifyVideoLibrary(input)
		const [loose, alien] = library.movies

		expect(alien?.id).toBe("Movies/Alien (1979)")
		expect(alien?.mergeKey).toBe("alien|1979")
		expect(alien?.dateAdded).toBe(2)
		expect(loose?.id).toBe("Movies/Loose (2000).mp4")
		expect(library.videos.map(video => [video.container, video.unsupported, video.height])).toEqual([
			["mp4", false, 0],
			["mkv", false, 0],
			["avi", true, 720]
		])
		expect(structuredClone(library)).toEqual(library)
	})

	it("uses the stable uuid of the primary file for loose movies and other videos", () => {
		const input = fixtureInput([
			{
				name: "Media",
				paths: ["Loose (2000).mp4", "clip.mp4"]
			}
		])

		input.files[0] = {
			...(input.files[0] ?? {
				uuid: "",
				parent: "",
				name: "",
				size: 0,
				timestamp: 0
			}),
			stableUuid: "stable-loose"
		}
		input.files[1] = {
			...(input.files[1] ?? {
				uuid: "",
				parent: "",
				name: "",
				size: 0,
				timestamp: 0
			}),
			stableUuid: "stable-clip"
		}

		const library = classifyVideoLibrary(input)

		expect(library.movies.map(movie => movie.id)).toEqual(["stable-loose"])
		expect(library.others.map(other => other.id)).toEqual(["stable-clip"])
	})
})

describe("classifyVideoLibrarySteps", () => {
	it("yields between directories and ends with what classifyVideoLibrary returns", () => {
		const input = {
			roots: [{ uuid: "root", name: "Library", type: "auto" as const }],
			dirs: Array.from({ length: 20 }, (_, index) => ({
				uuid: `d${String(index)}`,
				parent: "root",
				name: `Movie ${String(index)} (2001)`
			})),
			files: Array.from({ length: 20 }, (_, index) => ({
				uuid: `f${String(index)}`,
				parent: `d${String(index)}`,
				name: `Movie ${String(index)} (2001).mkv`,
				size: 1_000_000_000,
				timestamp: index
			}))
		}
		const steps = classifyVideoLibrarySteps(input)
		let yields = 0
		let step = steps.next()

		while (step.done !== true) {
			yields++
			step = steps.next()
		}

		expect(yields).toBeGreaterThan(20)
		expect(step.value).toEqual(classifyVideoLibrary(input))
	})

	it("yields while indexing, passing thousands of empty directories and assembling, with the same result", () => {
		const input = {
			roots: [{ uuid: "root", name: "Library", type: "auto" as const }],
			dirs: [
				{ uuid: "big", parent: "root", name: "Archive" },
				...Array.from({ length: 6000 }, (_, index) => ({
					uuid: `e${String(index)}`,
					parent: "big",
					name: `Empty ${String(index)}`
				}))
			],
			files: [
				...Array.from({ length: 6000 }, (_, index) => ({
					uuid: `n${String(index)}`,
					parent: `e${String(index)}`,
					name: `notes ${String(index)}.txt`,
					size: 100,
					timestamp: index
				})),
				{ uuid: "v", parent: "big", name: "Holiday (2001).mkv", size: 1_000_000_000, timestamp: 1 }
			]
		}
		const steps = classifyVideoLibrarySteps(input)
		let yields = 0
		let step = steps.next()

		while (step.done !== true) {
			yields++
			step = steps.next()
		}

		// 6000 directories and 6000 files indexed, then 6000 children passed, a few hundred per step.
		expect(yields).toBeGreaterThan(30)
		expect(step.value).toEqual(classifyVideoLibrary(input))
		expect(step.value.movies.map(movie => movie.title)).toEqual(["Holiday"])
	})
})
