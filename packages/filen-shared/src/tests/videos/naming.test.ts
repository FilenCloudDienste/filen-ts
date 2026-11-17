import { describe, expect, it } from "vitest"
import {
	VIDEO_CONTAINERS,
	VIDEO_FILE_KINDS_SIGNATURE,
	displayTitle,
	dynamicRangeLabel,
	episodeSeriesKey,
	episodeTitleText,
	isCameraStem,
	isIgnoredDirName,
	isIgnoredFileName,
	mergeKey,
	normalizeSeparators,
	parseEpisode,
	parseResolution,
	parseSeasonDirName,
	resolutionLabel,
	splitTitleYear,
	videoFileKind
} from "@filen/shared/videos"

describe("displayTitle", () => {
	it.each([
		["Alien (1979)", "Alien", 1979],
		["Alien.1979.1080p.BluRay.x264-GROUP", "Alien", 1979],
		["The Matrix 1999", "The Matrix", 1999],
		["1917 (2019)", "1917", 2019],
		["1917", "1917", 0],
		["2001 A Space Odyssey (1968)", "2001 A Space Odyssey", 1968],
		["2001.A.Space.Odyssey.1968.REMASTERED.1080p", "2001 A Space Odyssey", 1968],
		["Blade Runner 2049 (2017)", "Blade Runner 2049", 2017],
		["Blade.Runner.2049.2017.2160p.UHD", "Blade Runner 2049", 2017],
		["Blade Runner 2049", "Blade Runner 2049", 0],
		["Marvel's Agents of S.H.I.E.L.D. (2013)", "Marvel's Agents of S.H.I.E.L.D.", 2013],
		["Marvels.Agents.of.S.H.I.E.L.D.2013.1080p", "Marvels Agents of S.H.I.E.L.D.", 2013],
		["Mr. Robot", "Mr. Robot", 0],
		["Amélie (2001)", "Amélie", 2001],
		["Léon.The.Professional.1994", "Léon The Professional", 1994],
		["千と千尋の神隠し (2001)", "千と千尋の神隠し", 2001],
		["君の名は 2016", "君の名は", 2016],
		["Крёстный отец (1972)", "Крёстный отец", 1972],
		["Movie [2010]", "Movie", 2010],
		["Movie (2010) {edition-Director's Cut}", "Movie", 2010],
		["Movie (2010) [imdbid-tt1234567]", "Movie", 2010],
		["Movie (2010) {tmdb-603}", "Movie", 2010],
		["[YTS] Movie (2010)", "Movie", 2010],
		["[REC] (2007)", "[REC]", 2007],
		["Movie.Name.1080p.WEB-DL", "Movie Name", 0],
		["Movie Name 720p", "Movie Name", 0],
		["Some_Movie_Title", "Some Movie Title", 0],
		["Up (2009)", "Up", 2009],
		["It (2017)", "It", 2017],
		["Se7en (1995)", "Se7en", 1995],
		["Foo Se 7", "Foo Se 7", 0],
		["Charlotte's Web", "Charlotte's Web", 0],
		["The Big Short", "The Big Short", 0],
		["Movie Title - Director's Cut", "Movie Title - Director's Cut", 0],
		["Movie (1080p)", "Movie", 0],
		["Movie.2010", "Movie", 2010],
		["2012 (2009)", "2012", 2009],
		["2012", "2012", 0],
		["Movie 1899", "Movie", 1899],
		["Movie 1850", "Movie 1850", 0],
		["Movie (2010) - 1080p", "Movie", 2010],
		["Ocean's Eleven (2001)", "Ocean's Eleven", 2001],
		["WALL·E (2008)", "WALL·E", 2008],
		["Mission Impossible - Fallout (2018)", "Mission Impossible - Fallout", 2018],
		["Star Wars Episode IV - A New Hope (1977)", "Star Wars Episode IV - A New Hope", 1977],
		["Fast & Furious 6 (2013)", "Fast & Furious 6", 2013],
		["Spider-Man (2002)", "Spider-Man", 2002],
		["Avengers.Endgame.2019.2160p.HDR.x265", "Avengers Endgame", 2019],
		["the.office.us", "the office us", 0],
		["Movie.Title.HEVC", "Movie Title", 0],
		["Movie Title DTS-HD", "Movie Title", 0],
		["Proper", "Proper", 0],
		["Movie Title 4K", "Movie Title", 0],
		["L.A. Confidential (1997)", "L.A. Confidential", 1997],
		["L.A.Confidential.1997", "L.A. Confidential", 1997],
		["U.S. Marshals (1998)", "U.S. Marshals", 1998],
		["E.T. the Extra-Terrestrial (1982)", "E.T. the Extra-Terrestrial", 1982],
		["Movie (2010) (1080p)", "Movie", 2010],
		["Movie 2010 2011", "Movie 2010", 2011],
		["Back to the Future Part II (1989)", "Back to the Future Part II", 1989],
		["Movie_(2010)_[1080p]", "Movie", 2010],
		["映画2016", "映画2016", 0],
		["Die Hard 2 (1990)", "Die Hard 2", 1990],
		["Movie.Title.2160p.DV.HDR10.TrueHD.Atmos", "Movie Title", 0],
		["Movie Title AAC2.0", "Movie Title", 0],
		["Movie.Title.REPACK.1080p", "Movie Title", 0],
		["Movie.Title.BDRip", "Movie Title", 0],
		["Movie.Title.Blu-ray", "Movie Title", 0],
		["Movie.Title.DVDRip.XviD", "Movie Title", 0],
		["Movie.Title.HDTV.x264", "Movie Title", 0],
		["Movie Title 10bit", "Movie Title", 0],
		["Movie Title EAC3", "Movie Title", 0],
		["Movie Title DDP5.1", "Movie Title", 0]
	])("%s → %s (%i)", (name, title, year) => {
		expect(displayTitle(name)).toEqual({
			title,
			year
		})
	})
})

describe("splitTitleYear", () => {
	it("keeps the raw title before the year", () => {
		expect(splitTitleYear("Alien.1979.1080p")).toEqual({
			title: "Alien",
			year: 1979
		})
		expect(splitTitleYear("Foo Se 7")).toEqual({
			title: "Foo Se 7",
			year: 0
		})
	})

	it.each<[string, string, number]>([
		["(2010)", "(2010)", 0],
		["Movie (2010) 2011", "Movie", 2010],
		["Movie [2010] (2011)", "Movie [2010]", 2011],
		["Movie (2010]", "Movie", 2010],
		[`Movie ${new Date().getUTCFullYear() + 3}`, `Movie ${new Date().getUTCFullYear() + 3}`, 0]
	])("%s → %s (%i)", (text, title, year) => {
		expect(splitTitleYear(text)).toEqual({
			title,
			year
		})
	})
})

describe("episodeSeriesKey", () => {
	it.each([
		["[Group] Show (2019) S01E01", "show"],
		["Show.2019.S01E02", "show"],
		["Show 2019 Revival S01E01", "show 2019 revival"],
		["Show.Name.S01E01", "show name"],
		["S01E01", ""]
	])("%s → %s", (stem, key) => {
		const match = parseEpisode(stem, false)

		expect(match).not.toBeNull()

		if (match !== null) {
			expect(episodeSeriesKey(stem, match)).toBe(key)
		}
	})
})

describe("mergeKey", () => {
	it.each([
		["Alien (1979)", "alien|1979"],
		["Alien.1979.1080p", "alien|1979"],
		["ALIEN (1979) {imdb-tt0078748}", "alien|1979"],
		["[Group] Alien (1979)", "alien|1979"],
		["Alien", ""],
		["Amélie (2001)", "amélie|2001"],
		["Ａｌｉｅｎ (1979)", "alien|1979"],
		["Marvel's Agents of S.H.I.E.L.D. (2013)", "marvel s agents of s h i e l d|2013"],
		["Foo Se 7 (2020)", "foo se 7|2020"]
	])("%s → %s", (name, key) => {
		expect(mergeKey(name)).toBe(key)
	})
})

describe("normalizeSeparators", () => {
	it.each([
		["The.Office.US", "The Office US"],
		["S.H.I.E.L.D", "S.H.I.E.L.D"],
		["Mr. Robot", "Mr. Robot"],
		["some_file_name", "some file name"],
		["A.I.Artificial.Intelligence", "A.I. Artificial Intelligence"],
		["Movie...Title", "Movie Title"],
		["Dr.No", "Dr No"],
		["No dots", "No dots"],
		["file.name_with.mix", "file name with mix"],
		["R.I.P.D.", "R.I.P.D."],
		["Ölfeld.Über.Straße", "Ölfeld Über Straße"],
		["U.S.Marshals", "U.S. Marshals"],
		["The.A.Team", "The A Team"],
		["Don't.A.Movie", "Don't A Movie"],
		["Movie.DTS.5.1", "Movie DTS 5.1"],
		["Movie_ _Title", "Movie Title"],
		["Le\u0301on.A.B", "Le\u0301on A.B"]
	])("%s → %s", (input, output) => {
		expect(normalizeSeparators(input)).toBe(output)
	})
})

describe("parseEpisode outside a series", () => {
	it.each<[string, number, number, number]>([
		["Show.S01E02", 1, 2, 2],
		["Show S1E2", 1, 2, 2],
		["show.s01e02.title", 1, 2, 2],
		["Show_S01_E02", 1, 2, 2],
		["Show - S01 - E02", 1, 2, 2],
		["Show.S01.E02", 1, 2, 2],
		["Show.S01E02E03", 1, 2, 3],
		["Show.S01E02-E03", 1, 2, 3],
		["Show.S01E02-03", 1, 2, 3],
		["Show.S01E02 - E03", 1, 2, 3],
		["Show.S01E02E03E04", 1, 2, 4],
		["Show.S01E02-S01E03", 1, 2, 3],
		["Show S01 E02 E03", 1, 2, 3],
		["Show S01E01-02-03", 1, 1, 3],
		["Show.S01E02.1080p", 1, 2, 2],
		["Show.S01E02-1080p", 1, 2, 2],
		["Show.S01E02-720p", 1, 2, 2],
		["Show.S01E02-480i", 1, 2, 2],
		["Show.S01E05-E03", 1, 5, 5],
		["Show.S01E02-2019", 1, 2, 2],
		["Show.S01E02.2019", 1, 2, 2],
		["Show S01E01 - 02", 1, 1, 1],
		["Show S01E02 Eleven", 1, 2, 2],
		["Show.S01E02.E.Coli", 1, 2, 2],
		["Show S01E01v2", 1, 1, 1],
		["Show.S2019E05", 2019, 5, 5],
		["Show.S00E01", 0, 1, 1],
		["Show.S01E00", 1, 0, 0],
		["Show.S10E100", 10, 100, 100],
		["Show.S01EP02", 1, 2, 2],
		["S01E02", 1, 2, 2],
		["s1e1", 1, 1, 1],
		["Show.s01.e01", 1, 1, 1],
		["Bones.S01E01.Pilot.720p", 1, 1, 1],
		["Mr.Robot.S01E01", 1, 1, 1],
		["Шоу S01E02", 1, 2, 2],
		["番組 S02E03", 2, 3, 3],
		["Show 1x02", 1, 2, 2],
		["Show 01x02", 1, 2, 2],
		["Show 1x02-1x03", 1, 2, 3],
		["Show 1x02x03", 1, 2, 3],
		["Show 1x02-03", 1, 2, 3],
		["Show 1x02 720p", 1, 2, 2],
		["Show - 2x05 - Title", 2, 5, 5],
		["Show 0x01", 0, 1, 1],
		["Show Season 1 Episode 2", 1, 2, 2],
		["Show Season 2 Ep 5", 2, 5, 5],
		["Show season.3.episode.4", 3, 4, 4],
		["Show Season 1, Episode 2", 1, 2, 2],
		["Show Season 1 Episode 2-3", 1, 2, 3]
	])("%s → S%iE%i-%i", (stem, season, episode, episodeEnd) => {
		expect(parseEpisode(stem, false)).toMatchObject({
			season,
			episode,
			episodeEnd,
			date: 0
		})
	})

	it.each([
		"Movie (2010)",
		"Movie.2010.1080p",
		"Movie 1920x1080",
		"Movie.x264",
		"Show.S300E01",
		"Show.2020.01.02",
		"ShowS01E02",
		"Show - 01",
		"Show Ep 3",
		"01 - Pilot",
		"Seasons of Love",
		"Season 2",
		"Avengers.Endgame.2019.2160p"
	])("%s → no episode", stem => {
		expect(parseEpisode(stem, false)).toBeNull()
	})

	it("marks only SxxEyy as explicit and reports the marker span", () => {
		const match = parseEpisode("Show.Name.S01E02.Title", false)

		expect(match?.explicit).toBe(true)
		expect(match?.start).toBe(10)
		expect(match?.end).toBe(16)
		expect(parseEpisode("Show 1x02", false)?.explicit).toBe(false)
	})
})

describe("parseEpisode inside a series", () => {
	it.each<[string, number, number, number]>([
		["Show 2020-01-02", -1, 0, 20200102],
		["Show 2020.01.02", -1, 0, 20200102],
		["Show_2020_01_02", -1, 0, 20200102],
		["Show 2020-02-29", -1, 0, 20200229],
		["2019-12-31 Year End", -1, 0, 20191231],
		["[Group] Show - 01 [1080p]", -1, 1, 0],
		["[Group] Show - 01 [ABCD1234]", -1, 1, 0],
		["Show - 12v2", -1, 12, 0],
		["Show Ep 3", -1, 3, 0],
		["Show Ep. 3", -1, 3, 0],
		["Show Episode 12", -1, 12, 0],
		["Show E07", -1, 7, 0],
		["01 - Pilot", -1, 1, 0],
		["01. Pilot", -1, 1, 0],
		["101 Title", -1, 101, 0],
		["Show 12", -1, 12, 0],
		["Show (2019) - 05", -1, 5, 0],
		["One Piece - 1100", -1, 1100, 0],
		["Show S01E05", 1, 5, 0],
		["Show Season 2 Episode 5", 2, 5, 0],
		["Show 3x04", 3, 4, 0]
	])("%s → season %i episode %i date %i", (stem, season, episode, date) => {
		expect(parseEpisode(stem, true)).toMatchObject({
			season,
			episode,
			date
		})
	})

	it.each(["Show - 2019", "Show 1080p", "Pilot", "Show 2020-13-45 Extended"])("%s → no episode", stem => {
		const match = parseEpisode(stem, true)

		expect(match === null || match.date === 0).toBe(true)

		if (stem !== "Show 2020-13-45 Extended") {
			expect(match).toBeNull()
		}
	})
})

describe("episodeTitleText", () => {
	it.each([
		[".Pilot.1080p.WEB-DL", "Pilot"],
		[" - The One Where It Starts", "The One Where It Starts"],
		[" [1080p]", ""],
		["", ""],
		[".Ozymandias.(2013).720p", "Ozymandias"],
		["_Le_Début", "Le Début"]
	])("%s → %s", (rest, title) => {
		expect(episodeTitleText(rest)).toBe(title)
	})
})

describe("parseSeasonDirName", () => {
	it.each<[string, boolean, number]>([
		["Season 1", false, 1],
		["Season 01", false, 1],
		["season 10", false, 10],
		["Season 1 (2019)", false, 1],
		["Season 2 - 1080p", false, 2],
		["Season.3", false, 3],
		["Season_4", false, 4],
		["SEASON 5", false, 5],
		["Staffel 2", false, 2],
		["Saison 3", false, 3],
		["Temporada 4", false, 4],
		["Stagione 2", false, 2],
		["Seizoen 1", false, 1],
		["Sezon 2", false, 2],
		["Series 3", false, 3],
		["Säsong 2", false, 2],
		["Sæson 3", false, 3],
		["Sesong 4", false, 4],
		["Kausi 1", false, 1],
		["Specials", false, 0],
		["Special", false, 0],
		["Season Specials", false, 0],
		["S01", false, 1],
		["S1", false, 1],
		["s02 1080p", false, 2],
		["S01E01", false, -1],
		["Show Season 2", false, -1],
		["Show S02", false, -1],
		["Show S02", true, 2],
		["Show.S03.1080p.BluRay", true, 3],
		["1", false, -1],
		["1", true, 1],
		["Season 2019", false, 2019],
		["Season 300", false, -1],
		["Extras", true, -1],
		["Movies", false, -1],
		["Seasonal", false, -1],
		["Disc 1", true, -1]
	])("%s (in series: %s) → %i", (name, inSeries, season) => {
		expect(parseSeasonDirName(name, inSeries)).toBe(season)
	})
})

describe("ignore rules", () => {
	it.each<[string, boolean]>([
		[".filen", true],
		[".snapshot", true],
		[".@__thumb", true],
		["@eaDir", true],
		["eaDir", true],
		["#recycle", true],
		["@Recycle", true],
		["#snapshot", true],
		["$RECYCLE.BIN", true],
		["System Volume Information", true],
		["lost+found", true],
		["extrafanart", true],
		["extrathumbs", true],
		["Sample", true],
		["samples", true],
		["Movie.trickplay", true],
		["__MACOSX", true],
		["backdrops", true],
		["Movies", false],
		["Samplers", false],
		["Extras", false],
		["Season 1", false],
		["Trickplay Videos", false]
	])("directory %s → %s", (name, ignored) => {
		expect(isIgnoredDirName(name)).toBe(ignored)
	})

	it.each<[string, boolean]>([
		["._Movie.mkv", true],
		[".hidden.mkv", true],
		["sample.mkv", true],
		["movie-sample.mkv", true],
		["movie.sample.mkv", true],
		["Movie_sample2.mkv", true],
		["Movie Sample.mkv", true],
		["sample-movie.mkv", true],
		["Sample of My Life.mkv", false],
		["Example.mkv", false],
		["Samples and Stuff.mkv", false],
		["Movie (2010).mkv", false]
	])("file %s → %s", (name, ignored) => {
		const stem = name.slice(0, name.lastIndexOf(".")).toLowerCase()

		expect(isIgnoredFileName(name, stem)).toBe(ignored)
	})
})

describe("VIDEO_CONTAINERS", () => {
	it("keeps fail-by-name containers out of the drive's video, Photos, thumbnails and the editor", () => {
		for (const extension of ["asf", "wmv", "mpg", "mpeg", "vob", "m2v"]) {
			expect(VIDEO_CONTAINERS.get(extension)).toMatchObject({ drive: false, photo: false, keyframes: false, editorReads: false })
		}

		// Played through the app's own demuxer: a drive and library video, still out of Photos, thumbnails and the editor.
		for (const extension of ["flv", "avi"]) {
			expect(VIDEO_CONTAINERS.get(extension)).toMatchObject({ drive: true, library: "video", photo: false, keyframes: false, editorReads: false })
		}

		expect(VIDEO_CONTAINERS.get("ogv")).toMatchObject({ drive: true, photo: false, keyframes: false, editorReads: false, probe: "ogg" })
	})

	it("gives the mp4 and Matroska families what mp4 and mkv have", () => {
		for (const extension of ["3gp", "3g2", "qt", "mk3d"]) {
			expect(VIDEO_CONTAINERS.get(extension)).toMatchObject({ drive: true, library: "video", photo: true, keyframes: true })
		}

		expect(VIDEO_CONTAINERS.get("mk3d")?.editorReads).toBe(false)
		expect(VIDEO_CONTAINERS.get("qt")?.editorReads).toBe(true)
	})

	it("changes the library's signature, so a stored index re-walks its names once", () => {
		expect(VIDEO_FILE_KINDS_SIGNATURE).toContain("qt=video")
		expect(VIDEO_FILE_KINDS_SIGNATURE).toContain("avi=video")
		expect(VIDEO_FILE_KINDS_SIGNATURE).toContain("flv=video")
		expect(VIDEO_FILE_KINDS_SIGNATURE).not.toContain("divx")
	})
})

describe("videoFileKind", () => {
	const big = 2 * 1024 * 1024 * 1024

	it.each([
		["mp4", big, "video"],
		["mkv", big, "video"],
		["mk3d", big, "video"],
		["webm", big, "video"],
		["m4v", big, "video"],
		["mov", big, "video"],
		["m2ts", big, "video"],
		["mts", big, "video"],
		["ogv", big, "video"],
		["3gp", big, "video"],
		["3g2", big, "video"],
		["qt", big, "video"],
		["ts", big, "video"],
		["ts", 4096, null],
		["avi", big, "video"],
		["flv", big, "video"],
		["divx", big, null],
		["f4v", big, null],
		["asf", big, null],
		["m2v", big, null],
		["wmv", big, "unsupportedVideo"],
		["mpg", big, "unsupportedVideo"],
		["mpeg", big, "unsupportedVideo"],
		["vob", big, "unsupportedVideo"],
		["iso", big, null],
		["img", big, null],
		["ifo", 4096, null],
		["strm", 100, null],
		["disc", 100, null],
		["srt", 100, "subtitle"],
		["sup", 100, "subtitle"],
		["idx", 100, "subtitle"],
		["sub", 100, "subtitle"],
		["ass", 100, "subtitle"],
		["smi", 100, "subtitle"],
		["nfo", 100, "nfo"],
		["edl", 100, "edl"],
		["jpg", 100, "image"],
		["tbn", 100, "image"],
		["webp", 100, "image"],
		["txt", 100, null],
		["mp3", 100, null]
	])("%s (%i bytes) → %s", (extension, size, kind) => {
		expect(videoFileKind(extension, size, "movie")).toBe(kind)
	})

	it.each([
		["lib.dom.d", 4 * 1024 * 1024, null],
		["index.d", big, null],
		["episode.dvb", big, "video"],
		["recording", big, "video"]
	])("ts named %s (%i bytes) → %s", (stem, size, kind) => {
		expect(videoFileKind("ts", size, stem)).toBe(kind)
	})

	it.each(["ts", "mts"])("%s: the same gates for both transport-stream extensions", extension => {
		expect(videoFileKind(extension, 4_000, "module")).toBeNull()
		expect(videoFileKind(extension, big, "module.d")).toBeNull()
		expect(videoFileKind(extension, big, "module", true)).toBeNull()
		expect(videoFileKind(extension, big, "camera")).toBe("video")
	})
})

describe("resolution and dynamic range", () => {
	it.each([
		["Movie 1080p", 1080],
		["Movie.720p.x264", 720],
		["Movie 2160p", 2160],
		["Movie 4K", 2160],
		["Movie UHD", 2160],
		["Movie 8K", 4320],
		["Movie 1080i", 1080],
		["Movie 480p", 480],
		["Movie", 0],
		["Movie x1080p", 0],
		["Movie 100p", 0]
	])("%s → %i", (name, height) => {
		expect(parseResolution(name)).toBe(height)
	})

	it("labels heights", () => {
		expect([resolutionLabel(4320), resolutionLabel(2160), resolutionLabel(1080), resolutionLabel(0)]).toEqual(["8K", "4K", "1080p", ""])
	})

	it.each([
		["Movie HDR10+", "HDR10+"],
		["Movie HDR10Plus", "HDR10+"],
		["Movie HDR10", "HDR10"],
		["Movie HDR", "HDR"],
		["Movie.DV.HDR", "DV"],
		["Movie Dolby Vision", "DV"],
		["Movie DoVi", "DV"],
		["Movie", ""]
	])("%s → %s", (name, label) => {
		expect(dynamicRangeLabel(name)).toBe(label)
	})
})

describe("isCameraStem", () => {
	it.each<[string, boolean]>([
		["IMG_1234", true],
		["VID_20190101_123456", true],
		["PXL_20230101_123456789", true],
		["MVIMG_1234", true],
		["DSC_0001", true],
		["DSCN0001", true],
		["DJI_0001", true],
		["GOPR0001", true],
		["GH010123", true],
		["GX010456", true],
		["MOV_0001", true],
		["MVI_1234", true],
		["C0001", true],
		["20190514_123456", true],
		["Screen Recording 2023-01-02 at 10.00.00", true],
		["WhatsApp Video 2023-01-02 at 10.00.00", true],
		["Movie (2010)", false],
		["Image of the Day", false],
		["Videodrome (1983)", false],
		["Dji Movie", false],
		["Movement 2", false],
		["Imagine", false],
		["C00012 Title", false]
	])("%s → %s", (stem, camera) => {
		expect(isCameraStem(stem)).toBe(camera)
	})
})
