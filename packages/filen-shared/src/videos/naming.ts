// Name-only parsing for the video library scan: extensions, ignore rules, titles and years, episode and season
// numbers. Everything runs over up to tens of thousands of names per scan, so patterns compile once here and the
// hot paths avoid allocation where they can.
//
// JS `\b` only knows ASCII word characters even under /u, so token edges are lookarounds on \p{L}\p{N}. Underscores
// count as separators: file names use them in place of spaces.

import { MIN_TRANSPORT_STREAM_BYTES } from "./transportStream"
import type { ProbeContainer } from "./probeTypes"

export type VideoFileKind = "video" | "unsupportedVideo" | "subtitle" | "image" | "nfo" | "edl"

export interface VideoContainer {
	// The drive previews it as a video.
	drive: boolean
	// What the Videos library lists it as; absent: not listed.
	library?: "video" | "unsupportedVideo"
	// `.ts`/`.mts`: a video only once a read of its content found a transport stream.
	transportStream: boolean
	// The video editor's export reads it.
	editorReads: boolean
	// Photos shows it beside images.
	photo: boolean
	// The container probe walks it as this.
	probe?: ProbeContainer
	// probeKeyframes finds its keyframes, so a thumbnail can be cut from it without a full read.
	keyframes: boolean
}

function container(probe: ProbeContainer, fields: Partial<VideoContainer> = {}): VideoContainer {
	return { drive: true, library: "video", transportStream: false, editorReads: true, photo: true, probe, keyframes: true, ...fields }
}

// A container only the app's own demuxers read: no photo, no keyframe thumbnails, not in the editor; a drive video
// (`drive`) once its demuxer plays it.
function demuxed(probe: ProbeContainer, library: VideoContainer["library"], drive: boolean): VideoContainer {
	return {
		drive,
		...(library === undefined ? {} : { library }),
		transportStream: false,
		editorReads: false,
		photo: false,
		probe,
		keyframes: false
	}
}

// Every video container extension the apps know, one row each: the drive's video category, the Videos library, the
// editor, Photos and thumbnails all derive from it.
export const VIDEO_CONTAINERS: ReadonlyMap<string, VideoContainer> = new Map<string, VideoContainer>([
	["mp4", container("mp4")],
	["m4v", container("mp4")],
	["3gp", container("mp4")],
	["3g2", container("mp4")],
	["mov", container("mov")],
	["qt", container("mov")],
	["mkv", container("mkv")],
	["mk3d", container("mkv", { editorReads: false })],
	["webm", container("webm")],
	["ts", container("ts", { transportStream: true })],
	["mts", container("ts", { transportStream: true })],
	["m2ts", container("ts")],
	// Plays only where the browser plays Ogg from a plain src; nothing remuxes it.
	["ogv", container("ogg", { editorReads: false, photo: false, keyframes: false })],
	["avi", demuxed("avi", "video", true)],
	["divx", demuxed("avi", undefined, true)],
	["flv", demuxed("flv", "video", true)],
	// Adobe's MP4: mediabunny and the MP4 walker read it; outside Photos (R26) and the editor.
	["f4v", { drive: true, transportStream: false, editorReads: false, photo: false, probe: "mp4", keyframes: true }],
	["asf", demuxed("asf", undefined, true)],
	["wmv", demuxed("asf", "unsupportedVideo", true)],
	["mpg", demuxed("ps", "unsupportedVideo", true)],
	["mpeg", demuxed("ps", "unsupportedVideo", true)],
	["vob", demuxed("ps", "unsupportedVideo", true)],
	["m2v", demuxed("ps", undefined, true)]
])

const FILE_KINDS = new Map<string, VideoFileKind>([
	...[...VIDEO_CONTAINERS].flatMap(([extension, row]): [string, VideoFileKind][] =>
		row.library === undefined ? [] : [[extension, row.library]]
	),
	["srt", "subtitle"],
	["vtt", "subtitle"],
	["ass", "subtitle"],
	["ssa", "subtitle"],
	["sub", "subtitle"],
	["idx", "subtitle"],
	["sup", "subtitle"],
	["smi", "subtitle"],
	["sami", "subtitle"],
	["jpg", "image"],
	["jpeg", "image"],
	["png", "image"],
	["webp", "image"],
	["tbn", "image"],
	["gif", "image"],
	["nfo", "nfo"],
	["edl", "edl"]
])

// `.ts` and `.mts` are also TypeScript source: a transport stream that small, a declaration file (`lib.dom.d.ts`),
// or a file a read of its content found to be no transport stream (`notTransportStream`) is not a watchable video.
const TRANSPORT_STREAM_EXTENSIONS: ReadonlySet<string> = new Set(["ts", "mts"])

// Kind of a file by its lowercase extension, or null for anything the library ignores (disc images, playlists,
// `.strm`, unrelated files). `lowerStem` is the lowercase name without extension.
export function videoFileKind(extension: string, size: number, lowerStem: string, notTransportStream = false): VideoFileKind | null {
	const kind = FILE_KINDS.get(extension)

	if (kind === undefined) {
		return null
	}

	if (
		TRANSPORT_STREAM_EXTENSIONS.has(extension) &&
		(size < MIN_TRANSPORT_STREAM_BYTES || lowerStem.endsWith(".d") || notTransportStream)
	) {
		return null
	}

	return kind
}

// Every rule videoFileKind applies, as one string: a store that keeps only the files it recognises can tell from a
// change of this that what it kept may no longer be what it would keep.
export const VIDEO_FILE_KINDS_SIGNATURE = [
	...[...FILE_KINDS].map(([extension, kind]) => `${extension}=${kind}`),
	`ts,mts>=${String(MIN_TRANSPORT_STREAM_BYTES)}`
].join(",")

// Index of the extension dot, or -1. A leading dot is a hidden name, not an extension.
export function extensionDot(name: string): number {
	const dot = name.lastIndexOf(".")

	return dot > 0 && dot < name.length - 1 ? dot : -1
}

const IGNORED_DIR_NAMES = new Set([
	"@eadir",
	"eadir",
	"#recycle",
	"@recycle",
	"#snapshot",
	"$recycle.bin",
	"system volume information",
	"lost+found",
	"__macosx",
	"extrafanart",
	"extrathumbs",
	"sample",
	"samples",
	// Theme videos are not part of the library.
	"backdrops"
])

// Dot directories (which covers `.filen`, `.snapshot`, `.@__thumb`), NAS and OS housekeeping, artwork galleries,
// trickplay tile directories and sample directories.
export function isIgnoredDirName(name: string): boolean {
	if (name.startsWith(".")) {
		return true
	}

	const lower = name.toLowerCase()

	return IGNORED_DIR_NAMES.has(lower) || lower.endsWith(".trickplay")
}

const SAMPLE_STEM = /(?:^|[ ._-])sample\d*$|^sample[._-]/

// Hidden files, AppleDouble `._` files and release samples. `lowerStem` is the lowercase name without extension.
export function isIgnoredFileName(name: string, lowerStem: string): boolean {
	return name.startsWith(".") || (lowerStem.includes("sample") && SAMPLE_STEM.test(lowerStem))
}

const NON_WORD_RUN = /[^\p{L}\p{N}]+/gu

// Lowercase, NFKC-folded, punctuation-free form used for comparing names. Never shown to anyone.
export function identityKey(text: string): string {
	return text.normalize("NFKC").toLowerCase().replace(NON_WORD_RUN, " ").trim()
}

const MAX_YEAR = new Date().getUTCFullYear() + 2
const MIN_YEAR = 1880

// Every pattern and loop below stays linear in the name length: names come from user drives, so a hostile or
// broken one must not stall a scan. Hence hand-written trims and bracket scans instead of `[…]+$` patterns and
// `\[[^\]]*\]` searches, which backtrack quadratically on long separator runs or unclosed brackets.

// Separators trimmed off the end of a title (whitespace, word separators, opening brackets) and off its start.
const TRAILING_SEPARATORS = " \t\n\r 　._-–—,:;([{（［【"
const LEADING_SEPARATORS = " \t\n\r 　._-–—,:;)]}）］】"
const WORD_SEPARATORS = " ._-"

// Trailing separators off, except the closing dot of an acronym ("S.H.I.E.L.D.").
export function trimTrailingSeparators(text: string): string {
	let end = text.length

	while (end > 0 && TRAILING_SEPARATORS.includes(text.charAt(end - 1))) {
		end--
	}

	if (end < text.length && text.charAt(end) === "." && end >= 2 && text.charAt(end - 2) === ".") {
		return text.slice(0, end + 1)
	}

	return end === text.length ? text : text.slice(0, end)
}

function trimStart(text: string): string {
	let start = 0

	while (start < text.length && LEADING_SEPARATORS.includes(text.charAt(start))) {
		start++
	}

	return start === 0 ? text : text.slice(start)
}

function trimSeparators(text: string): string {
	return trimTrailingSeparators(trimStart(text))
}

const BRACKET_PAIRS = new Map([
	["[", "]"],
	["(", ")"],
	["{", "}"],
	["（", "）"],
	["［", "］"],
	["【", "】"]
])
const HAS_OPENER = /[[({（［【]/u

// Calls `visit` for each bracketed group, groups not nesting: one ends at the first matching closer. Each closer
// kind is searched forward from a position at most once, so the scan is linear even with many unclosed openers.
function forEachBracketGroup(text: string, visit: (open: number, close: number, opener: string) => void): void {
	const nextCloser = new Map<string, number>()

	for (let i = 0; i < text.length; i++) {
		const opener = text.charAt(i)
		const closer = BRACKET_PAIRS.get(opener)

		if (closer === undefined) {
			continue
		}

		let close = nextCloser.get(closer)

		if (close === undefined || (close !== -1 && close <= i)) {
			close = text.indexOf(closer, i + 1)
			nextCloser.set(closer, close)
		}

		if (close === -1) {
			continue
		}

		visit(i, close, opener)
		i = close
	}
}

// A four-digit year standing on its own, not part of a longer word or number ("映画2016", "x2010").
const YEAR = /(?<![\p{L}\p{N}])(?:18|19|20)\d\d(?![\p{L}\p{N}])/gu

export interface TitleYear {
	// Raw text before the year (or the whole input when there is none), separators trimmed off its end.
	title: string
	year: number
}

// Splits a release-style name into title and year. A year counts only within the plausible range and with some title
// text in front of it, so "1917" alone stays a title. A year wrapped in a matching bracket pair ("(2010)", "[2010]",
// "（2010）") beats a bare one; between candidates of the same kind the last one counts ("Movie 2010 2011" → 2011).
export function splitTitleYear(text: string): TitleYear {
	let titleStart = 0

	while (titleStart < text.length && TRAILING_SEPARATORS.includes(text.charAt(titleStart))) {
		titleStart++
	}

	let bracketed = -1
	let bare = -1

	for (const match of text.matchAll(YEAR)) {
		const year = Number(match[0])

		if (match.index <= titleStart || year < MIN_YEAR || year > MAX_YEAR) {
			continue
		}

		const closer = BRACKET_PAIRS.get(text.charAt(match.index - 1))

		if (closer !== undefined && text.charAt(match.index + match[0].length) === closer) {
			bracketed = match.index
		} else {
			bare = match.index
		}
	}

	const start = bracketed >= 0 ? bracketed : bare

	if (start < 0) {
		return {
			title: trimTrailingSeparators(text),
			year: 0
		}
	}

	return {
		title: trimTrailingSeparators(text.slice(0, start)),
		year: Number(text.slice(start, start + 4))
	}
}

const HAS_LETTER = /\p{L}/u
const HAS_WORD = /[\p{L}\p{N}]/u
const ID_TAG = /^(?:tmdb|imdb|tvdb)(?:id)?[-=]/iu
const WHITESPACE_RUN = /\s{2,}/gu

function isBlank(text: string, from: number, to: number): boolean {
	for (let i = from; i < to; i++) {
		if (!WORD_SEPARATORS.includes(text.charAt(i))) {
			return false
		}
	}

	return true
}

// Drops leading `[release group]`s and `{edition-…}` / `{tmdb-…}` / `[imdbid-…]` tags. Keeps the leading group when
// no words would remain ("[REC] (2007)").
export function stripNameTags(text: string): string {
	if (!HAS_OPENER.test(text)) {
		return text
	}

	const removed: number[] = []
	let leadingEnd = 0
	let atStart = true

	forEachBracketGroup(text, (open, close, opener) => {
		if (atStart && (opener === "[" || opener === "【" || opener === "［") && isBlank(text, leadingEnd, open)) {
			leadingEnd = close + 1

			return
		}

		atStart = false

		if (opener === "{" || (opener === "[" && ID_TAG.test(text.slice(open + 1, open + 8)))) {
			removed.push(open, close + 1)
		}
	})

	if (leadingEnd === 0 && removed.length === 0) {
		return text
	}

	const assemble = (from: number): string => {
		let out = ""
		let at = from

		for (let r = 0; r < removed.length; r += 2) {
			const start = removed[r] ?? 0

			if (start >= at) {
				out += text.slice(at, start)
			}

			at = Math.max(at, removed[r + 1] ?? 0)
		}

		return out + text.slice(at)
	}
	let start = leadingEnd

	while (start < text.length && WORD_SEPARATORS.includes(text.charAt(start))) {
		start++
	}

	let out = assemble(start)

	if (leadingEnd > 0 && !HAS_LETTER.test(out)) {
		out = assemble(0)
	}

	out = out.replace(WHITESPACE_RUN, " ").trim()

	return out.length > 0 ? out : text
}

// Key for grouping one title across roots: identity of the raw title before the year, plus the year. Empty when
// the name carries no year; such titles never merge.
export function mergeKey(name: string): string {
	const { title, year } = splitTitleYear(stripNameTags(name))

	return year === 0 ? "" : `${identityKey(title)}|${year}`
}

const WORD_RUN = /[\p{L}\p{M}\p{N}]+/gu
const SINGLE_LETTER = /^\p{L}\p{M}*$/u
const SPACE_RUN = / {2,}/gu
const DOTS_AND_UNDERSCORES = /^[._]+$/u
// What may stand right before the first letter of a dotted acronym; an apostrophe ("Don't.A.Movie") may not.
const ACRONYM_LEAD = /[\s._\-([{（［【]/u

function underscoresToSpaces(gap: string): string {
	return gap.includes("_") ? gap.replaceAll("_", " ").replace(SPACE_RUN, " ") : gap
}

function leadingDigits(word: string): number {
	let count = 0

	while (count < word.length && word.charCodeAt(count) >= 48 && word.charCodeAt(count) <= 57) {
		count++
	}

	return count
}

function trailingDigits(word: string): number {
	let count = 0

	while (count < word.length && word.charCodeAt(word.length - 1 - count) >= 48 && word.charCodeAt(word.length - 1 - count) <= 57) {
		count++
	}

	return count
}

// A short decimal such as "5.1" or "AAC2.0", which reads wrong with a space.
function isDecimal(left: string, right: string): boolean {
	const before = trailingDigits(left)
	const after = leadingDigits(right)

	return before >= 1 && before <= 2 && after >= 1 && after <= 2
}

// Release-style separators to spaces for display: "The.Office_US" → "The Office US". A dot directly between words
// becomes a space, a run of dots or underscores one space. Dotted acronyms (two or more single letters joined by single
// dots) keep their dots, plus a space where a word follows ("A.I.Artificial" → "A.I. Artificial"); short decimals stay.
// Dots next to a space ("Mr. Robot") or at either end are left alone.
export function normalizeSeparators(text: string): string {
	if (!text.includes(".") && !text.includes("_")) {
		return text
	}

	const words: string[] = []
	const gaps: string[] = []
	let at = 0

	for (const match of text.matchAll(WORD_RUN)) {
		gaps.push(text.slice(at, match.index))
		words.push(match[0])
		at = match.index + match[0].length
	}

	gaps.push(text.slice(at))

	if (words.length === 0) {
		return underscoresToSpaces(text)
	}

	// gaps[k] precedes words[k]; the last gap trails the last word.
	const acronymLetter = words.map((word, k) => {
		if (!SINGLE_LETTER.test(word)) {
			return false
		}

		const before = gaps[k] ?? ""

		return before.length === 0 || ACRONYM_LEAD.test(before.charAt(before.length - 1))
	})
	const joined = (k: number): boolean => acronymLetter[k] === true && acronymLetter[k + 1] === true && gaps[k + 1] === "."
	let out = underscoresToSpaces(gaps[0] ?? "")

	for (let k = 0; k < words.length; k++) {
		const word = words[k] ?? ""
		const gap = gaps[k + 1] ?? ""

		out += word

		if (k === words.length - 1) {
			out += underscoresToSpaces(gap)
		} else if (!DOTS_AND_UNDERSCORES.test(gap)) {
			out += underscoresToSpaces(gap)
		} else if (joined(k)) {
			out += "."
		} else if (k > 0 && joined(k - 1) && gap.startsWith(".")) {
			out += ". "
		} else if (gap === "." && isDecimal(word, words[k + 1] ?? "")) {
			out += "."
		} else {
			out += " "
		}
	}

	return out
}

// Technical tokens that end the human part of a year-less release name. Only unambiguous ones: a bare "web" or
// "internal" would cut real titles.
const QUALITY_TOKEN =
	/(?<![\p{L}\p{N}])(?:\d{3,4}[pi]|[48]k|uhd|blu-?ray|bd(?:rip|remux)?|br-?rip|web-?(?:dl|rip)|hdtv|hdrip|dvd(?:rip|scr|r)?|remux|[xh]\.?26[45]|hevc|avc|xvid|divx|av1|vp9|10-?bit|hdr(?:10(?:\+|plus)?)?|dovi|dolby[ .]?vision|aac(?:2[ .]0)?|e?-?ac-?3|ddp?[257][ .][01]|dts(?:-?hd)?|truehd|atmos|proper|repack)(?![\p{L}\p{N}])/iu

// `allowEmpty` false keeps names that are nothing but a token ("Proper").
function cutAtQualityToken(text: string, allowEmpty: boolean): string {
	const match = QUALITY_TOKEN.exec(text)

	if (match === null) {
		return text
	}

	const head = trimTrailingSeparators(text.slice(0, match.index))

	return head.length > 0 || allowEmpty ? head : text
}

export interface DisplayTitle {
	title: string
	year: number
}

// Human title and year from a folder name or file stem. For display only: it truncates, so it must never become an
// identity or grouping key.
export function displayTitle(name: string): DisplayTitle {
	const normalized = normalizeSeparators(stripNameTags(name))
	const { title, year } = splitTitleYear(normalized)
	const cleaned = trimSeparators(year > 0 ? title : cutAtQualityToken(title, false))

	return {
		title: cleaned.length > 0 ? cleaned : name,
		year
	}
}

const YEAR_ONLY = /^\s*(?:18|19|20)\d\d\s*$/u

// Removes release tags from text after an episode marker: square, curly and lenticular brackets always, round ones
// when they hold a year or technical tokens ("(BD 1080p)"), keeping "(Part 1)".
function removeEpisodeTags(text: string): string {
	if (!HAS_OPENER.test(text)) {
		return text
	}

	let out = ""
	let at = 0

	forEachBracketGroup(text, (open, close, opener) => {
		if (opener === "(" || opener === "（") {
			const content = text.slice(open + 1, close)

			if (!YEAR_ONLY.test(content) && !QUALITY_TOKEN.test(content)) {
				return
			}
		}

		out += `${text.slice(at, open)} `
		at = close + 1
	})

	return out + text.slice(at)
}

// Title text that trails an episode marker ("S01E02.The.Title.1080p" → "The Title"); empty when there is none.
// Tags and a bracketed year go; a bare number stays, since episode titles can be years ("1984").
export function episodeTitleText(rest: string): string {
	return trimSeparators(cutAtQualityToken(trimSeparators(normalizeSeparators(removeEpisodeTags(rest))), true))
}

const RESOLUTION = /(?<![\p{L}\p{N}])(?:(\d{3,4})[pi]|([48])k|uhd)(?![\p{L}\p{N}])/iu

// Picture height a name advertises ("1080p", "4K", "UHD"), or 0.
export function parseResolution(text: string): number {
	const match = RESOLUTION.exec(text)

	if (match === null) {
		return 0
	}

	if (match[1] !== undefined) {
		const height = Number(match[1])

		return height >= 240 && height <= 4320 ? height : 0
	}

	return match[2] === "8" ? 4320 : 2160
}

export function resolutionLabel(height: number): string {
	if (height === 0) {
		return ""
	}

	if (height >= 4320) {
		return "8K"
	}

	if (height >= 2160) {
		return "4K"
	}

	return `${height}p`
}

const DYNAMIC_RANGE = /(?<![\p{L}\p{N}])(hdr10(?:\+|plus)|hdr10|hdr|dv|dovi|dolby[ ._-]?vision)(?![\p{L}\p{N}])/iu

// "HDR10+", "HDR10", "HDR", "DV" or "".
export function dynamicRangeLabel(text: string): string {
	const token = DYNAMIC_RANGE.exec(text)?.[1]?.toLowerCase()

	if (token === undefined) {
		return ""
	}

	if (token.startsWith("hdr10")) {
		return token.length > 5 ? "HDR10+" : "HDR10"
	}

	return token === "hdr" ? "HDR" : "DV"
}

const CAMERA_STEM =
	/^(?:(?:img|vid|pxl|mvimg|dsc[fn]?|dji|gopr|g[hx]\d\d|mov|mvi|mah)[_ -]?\d|c\d{4}$|\d{8}[_ -]\d{6}|(?:screen ?recording|whatsapp video|video|signal)[ _-]\d{4}-\d\d-\d\d)/iu

// Stems phones, cameras and screen recorders give their clips.
export function isCameraStem(stem: string): boolean {
	return CAMERA_STEM.test(stem)
}

// ── Episodes ─────────────────────────────────────────────────────────────────

export interface EpisodeMatch {
	// -1 when the marker carries no season (absolute or bare numbering).
	season: number
	// 0 for date-based episodes.
	episode: number
	// Last episode of a multi-episode file; equals `episode` otherwise.
	episodeEnd: number
	// yyyymmdd for date-based episodes, else 0.
	date: number
	// Marker span in the stem: text before it names the series, text after it titles the episode.
	start: number
	end: number
	// True only for the SxxEyy form, the strongest evidence a stem is an episode.
	explicit: boolean
}

const SEASON_EPISODE = /(?<![\p{L}\p{N}])s(\d{1,4})[ ._-]*e(?:p[ ._-]*)?(\d{1,4})(?!\d)/iu
// Range continuations: group 1 is a repeated season, which must match; groups 2 and 3 the episode.
const SEASON_EPISODE_NEXT = /[ ._]*(?:-[ ._]*)?(?:s(\d{1,4})[ ._-]*)?e(?:p[ ._-]*)?(\d{1,4})|-(\d{1,4})/iuy
const CROSS = /(?<![\p{L}\p{N}])(\d{1,2})x(\d{1,3})(?!\d)/iu
const CROSS_NEXT = /(?:[ ._]*-[ ._]*|[ ._]+)(\d{1,2})x(\d{1,3})|[-x](\d{1,3})/iuy
const WORDS = /(?<![\p{L}\p{N}])season[ ._-]*(\d{1,4})[ ._,-]*(?:episode|ep)[ ._-]*(\d{1,4})(?!\d)/iu
const WORDS_NEXT = /(?:[ ._]*-[ ._]*season[ ._-]*(\d{1,4})[ ._,-]*(?:episode|ep)[ ._-]*|-)(\d{1,4})/iuy
const DATE = /(?<![\p{L}\p{N}])((?:19|20)\d\d)([-._ ])(\d\d?)\2(\d\d?)(?![\p{L}\p{N}])/u

// Numbering used only inside a directory already known to be a series.
const LOOSE_EPISODE_WORD = /(?<![\p{L}\p{N}])(?:episode|ep|e)[ ._-]*(\d{1,4})(?:v\d)?(?![\p{L}\p{N}])/iu
const LOOSE_DASH_NUMBER = /[ ._]-[ ._]*(\d{1,4})(?:v\d)?(?![\p{L}\p{N}])/u
const LOOSE_LEADING_NUMBER = /^[ ._-]*(\d{1,3})(?:v\d)?(?:$|[ ._-])/u
const LOOSE_TRAILING_NUMBER = /(?<![\p{L}\p{N}])(\d{1,3})(?:v\d)?[ ._-]*$/u

function plausibleSeason(season: number): boolean {
	return season < 200 || (season >= 1928 && season <= 2500)
}

// A range end only counts when it cannot be the start of a resolution or a longer number, and it moves forward by
// a plausible amount ("S01E02-2019" is an episode and a year, not 2018 episodes).
function rangeEndAllowed(stem: string, at: number, end: number, previous: number): boolean {
	const next = stem.charCodeAt(at)

	// 0-9, I, P, i, p
	if ((next >= 48 && next <= 57) || next === 73 || next === 80 || next === 105 || next === 112) {
		return false
	}

	return end >= previous && end - previous < 100
}

function extendRange(stem: string, next: RegExp, from: number, start: number, season: number): { end: number; episodeEnd: number } {
	let at = from
	let episodeEnd = start

	for (;;) {
		next.lastIndex = at

		const match = next.exec(stem)

		if (match === null) {
			break
		}

		const value = Number(match[2] ?? match[3])

		if ((match[1] !== undefined && Number(match[1]) !== season) || !rangeEndAllowed(stem, next.lastIndex, value, episodeEnd)) {
			break
		}

		episodeEnd = value
		at = next.lastIndex
	}

	return {
		end: at,
		episodeEnd
	}
}

function validDate(year: number, month: number, day: number): boolean {
	if (month < 1 || month > 12 || day < 1) {
		return false
	}

	const days =
		month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31

	return day <= days
}

function strictEpisode(stem: string, withDates: boolean): EpisodeMatch | null {
	const seasonEpisode = SEASON_EPISODE.exec(stem)

	if (seasonEpisode !== null) {
		const season = Number(seasonEpisode[1])

		if (plausibleSeason(season)) {
			const episode = Number(seasonEpisode[2])
			const range = extendRange(stem, SEASON_EPISODE_NEXT, seasonEpisode.index + seasonEpisode[0].length, episode, season)

			return {
				season,
				episode,
				episodeEnd: range.episodeEnd,
				date: 0,
				start: seasonEpisode.index,
				end: range.end,
				explicit: true
			}
		}
	}

	const cross = CROSS.exec(stem)

	if (cross !== null) {
		const season = Number(cross[1])
		const episode = Number(cross[2])
		const range = extendRange(stem, CROSS_NEXT, cross.index + cross[0].length, episode, season)

		return {
			season,
			episode,
			episodeEnd: range.episodeEnd,
			date: 0,
			start: cross.index,
			end: range.end,
			explicit: false
		}
	}

	const words = WORDS.exec(stem)

	if (words !== null) {
		const season = Number(words[1])

		if (plausibleSeason(season)) {
			const episode = Number(words[2])
			const range = extendRange(stem, WORDS_NEXT, words.index + words[0].length, episode, season)

			return {
				season,
				episode,
				episodeEnd: range.episodeEnd,
				date: 0,
				start: words.index,
				end: range.end,
				explicit: false
			}
		}
	}

	if (withDates) {
		const date = DATE.exec(stem)

		if (date !== null) {
			const year = Number(date[1])
			const month = Number(date[3])
			const day = Number(date[4])

			if (validDate(year, month, day)) {
				return {
					season: -1,
					episode: 0,
					episodeEnd: 0,
					date: year * 10000 + month * 100 + day,
					start: date.index,
					end: date.index + date[0].length,
					explicit: false
				}
			}
		}
	}

	return null
}

function looseMatch(stem: string, pattern: RegExp): EpisodeMatch | null {
	const match = pattern.exec(stem)

	if (match === null) {
		return null
	}

	const episode = Number(match[1])

	return {
		season: -1,
		episode,
		episodeEnd: episode,
		date: 0,
		start: match.index,
		end: match.index + match[0].length,
		explicit: false
	}
}

function looseEpisode(stem: string): EpisodeMatch | null {
	// Bracketed groups hold release tags, hashes and resolutions; blank them so offsets stay valid.
	let masked = stem

	if (HAS_OPENER.test(stem)) {
		let at = 0

		masked = ""
		forEachBracketGroup(stem, (open, close) => {
			masked += stem.slice(at, open) + " ".repeat(close + 1 - open)
			at = close + 1
		})
		masked += stem.slice(at)
	}

	const word = looseMatch(masked, LOOSE_EPISODE_WORD)

	if (word !== null) {
		return word
	}

	const dash = looseMatch(masked, LOOSE_DASH_NUMBER)

	// A year-like number after a dash is far more likely a year than an episode.
	if (dash !== null && (dash.episode < 1900 || dash.episode > MAX_YEAR)) {
		return dash
	}

	return looseMatch(masked, LOOSE_LEADING_NUMBER) ?? looseMatch(masked, LOOSE_TRAILING_NUMBER)
}

// Episode marker in a stem. `inSeries` also allows date-based names and loose numbering ("Show - 12", "Ep 3",
// "01 - Pilot"), which outside a known series would misread movies and personal clips.
export function parseEpisode(stem: string, inSeries: boolean): EpisodeMatch | null {
	return strictEpisode(stem, inSeries) ?? (inSeries ? looseEpisode(stem) : null)
}

// Grouping key for the series name in front of an episode marker: case, punctuation and a trailing year ignored.
export function episodeSeriesKey(stem: string, match: EpisodeMatch): string {
	const name = stripNameTags(stem.slice(0, match.start))
	const { title, year } = splitTitleYear(name)
	const key = identityKey(name)

	return year > 0 && key.endsWith(` ${year}`) ? identityKey(title) : key
}

const SEASON_WORD =
	/(?<![\p{L}\p{N}])(?:season|saison|staffel|temporada|stagione|seizoen|sezon|series|säsong|sæson|sesong|kausi)[ ._-]*(\d{1,4})(?!\p{N})/iu
const SEASON_WORD_WHOLE = /^(?:season|saison|staffel|temporada|stagione|seizoen|sezon|series|säsong|sæson|sesong|kausi)[ ._-]*(\d{1,4})$/iu
const SEASON_SHORT = /(?<![\p{L}\p{N}])s(\d{1,4})(?![\p{L}\p{N}])/iu
const SEASON_SHORT_WHOLE = /^s(\d{1,4})$/iu
const SEASON_SPECIALS = /^(?:season[ ._-]*)?specials?$/iu
const SEASON_NUMBER_ONLY = /^\d{1,4}$/u

function wholeSeasonName(name: string): number {
	if (SEASON_SPECIALS.test(name)) {
		return 0
	}

	const match = SEASON_WORD_WHOLE.exec(name) ?? SEASON_SHORT_WHOLE.exec(name)

	return match === null ? -1 : Number(match[1])
}

// Season a directory name stands for, or -1. "Specials" is season 0. Outside a series only a name that is nothing
// but a season ("Season 2", "S02", "Season 1 (2019)", "S03 1080p") counts, so titles like "Open Season 2" or
// "Series 7: The Contenders" stay titles. Inside a series a season token anywhere ("Show S02", "Show Season 3")
// and a bare number ("1/", "2/") count too.
export function parseSeasonDirName(name: string, inSeries: boolean): number {
	const trimmed = name.trim()
	let season = wholeSeasonName(trimmed)

	if (season < 0 && inSeries) {
		const match = SEASON_WORD.exec(trimmed) ?? SEASON_SHORT.exec(trimmed) ?? SEASON_NUMBER_ONLY.exec(trimmed)

		season = match === null ? -1 : Number(match[1] ?? match[0])
	} else if (season < 0) {
		// Tags around a season name: year, resolution, source.
		const core = displayTitle(trimmed).title

		season = core === trimmed ? -1 : wholeSeasonName(core)
	}

	return season >= 0 && plausibleSeason(season) ? season : -1
}

export interface SeasonPackName {
	// Raw series name before the season marker.
	series: string
	season: number
}

const PACK_TAIL_WORD = /^complete(?![\p{L}\p{N}])/iu

// A directory holding one season of a show, named "<show> Season 2" or "<show>.S02.1080p.WEB-GROUP": a season
// marker after the show name, followed by nothing but tags. Says nothing about the contents; callers check those.
export function parseSeasonPackName(name: string): SeasonPackName | null {
	const match = SEASON_WORD.exec(name) ?? SEASON_SHORT.exec(name)

	if (match === null) {
		return null
	}

	const season = Number(match[1])
	const series = trimTrailingSeparators(name.slice(0, match.index))

	if (!plausibleSeason(season) || !HAS_WORD.test(series)) {
		return null
	}

	const tail = trimStart(name.slice(match.index + match[0].length))

	if (tail.length > 0 && !BRACKET_PAIRS.has(tail.charAt(0)) && QUALITY_TOKEN.exec(tail)?.index !== 0 && !PACK_TAIL_WORD.test(tail)) {
		return null
	}

	return {
		series,
		season
	}
}
