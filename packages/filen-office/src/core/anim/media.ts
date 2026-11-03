import type { G, PartReader } from "../pptx/read/xml"
import { escapeAttribute } from "../xml/entities"
import type { TimeCondition, TimeNode, TimingTree } from "./model"

// A medium's own timing (MS-PPTX §2.3.3.7 CT_Media, the p14:media of a picture's nvPr extension list): the time cut
// from its start and its end (§2.3.3.18 p14:trim), its fade in and out (§2.3.3.15 p14:fade) and its named bookmarks
// (§2.3.3.12 p14:bmkLst), which a timing condition names to start an animation (§2.3.3.13 p14:bmkTgt in a p:cond of
// evt="onMediaBookmark"). Every value is an ST_UniversalTimeOffset (§2.3.4.6): a number with an optional unit, plain
// milliseconds without one. ODF has none of them (a draw:plugin's parameters are its application's); a conversion
// counts each as lost (mediaTimingLosses).

export interface MediaBookmark {
	readonly name: string
	// From the medium's start (not the trimmed start).
	readonly timeMs: number
}

export interface MediaTiming {
	// Durations removed: `startMs` from the medium's start, `endMs` from its end (MS-PPTX: the end is a duration, not a
	// position).
	readonly trim?: { readonly startMs: number; readonly endMs: number }
	readonly fade?: { readonly inMs: number; readonly outMs: number }
	// In time order.
	readonly bookmarks?: readonly MediaBookmark[]
	// The names of the file's bookmarks the reader could not take (no name, a time that does not parse or is past a
	// day, past the 256th): kept in the file as they are, and no new bookmark takes one of their names.
	readonly unread?: readonly string[]
}

// The reader's p14 group, as a value without its module: the show's player imports this one on the page.
const P14: typeof G.P14 = 5
// Whether XML can carry `text` as written: no control characters, unpaired surrogates or U+FFFE/U+FFFF.
function writable(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)

		if (code < 0x20 || code === 0xfffe || code === 0xffff) return false
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1)

			if (!(next >= 0xdc00 && next <= 0xdfff)) return false

			i++
		} else if (code >= 0xdc00 && code <= 0xdfff) return false
	}

	return true
}

export const P14_NAMESPACE = "http://schemas.microsoft.com/office/powerpoint/2010/main"
// The uri of the p:ext holding p14:media in a picture's nvPr.
export const P14_MEDIA_EXT = "{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"

// A day of media: longer values are refused (a hostile file's 1e300 never reaches the player).
export const MEDIA_TIME_MAX_MS = 86_400_000
// PowerPoint's bookmark list has no stated bound; ours keeps the per-frame cursor and the ribbon's menu small.
export const MEDIA_BOOKMARKS_MAX = 256
export const MEDIA_BOOKMARK_NAME_MAX = 255

const UNIT_MS: Readonly<Record<string, number>> = { h: 3_600_000, min: 60_000, s: 1000, ms: 1, µs: 0.001, μs: 0.001, ns: 0.000_001 }
const TIME_OFFSET = /^(\d+(?:\.\d+)?)(h|min|s|ms|µs|μs|ns)?$/u

// An ST_UniversalTimeOffset as milliseconds; undefined when it is not one or (`capped`) is past a day.
export function parseUniversalTime(text: string | undefined, capped = true): number | undefined {
	if (text === undefined) return undefined

	const match = TIME_OFFSET.exec(text.trim())

	if (match === null) return undefined

	const ms = Number(match[1]) * (UNIT_MS[match[2] ?? "ms"] ?? 1)

	return Number.isFinite(ms) && (!capped || ms <= MEDIA_TIME_MAX_MS) ? ms : undefined
}

// Milliseconds as PowerPoint writes them: no unit, at most four decimals.
export function formatUniversalTime(ms: number): string {
	const rounded = Math.round(ms * 10_000) / 10_000

	return String(rounded)
}

function validTime(ms: number): boolean {
	return Number.isFinite(ms) && ms >= 0 && ms <= MEDIA_TIME_MAX_MS
}

export function validTrim(startMs: number, endMs: number): boolean {
	return validTime(startMs) && validTime(endMs) && startMs + endMs <= MEDIA_TIME_MAX_MS
}

// Each cut within a day, as the reader takes a file's (an undo restores those even where they add up past it).
export function writableTrim(startMs: number, endMs: number): boolean {
	return validTime(startMs) && validTime(endMs)
}

export function validFade(inMs: number, outMs: number): boolean {
	return validTime(inMs) && validTime(outMs)
}

// Why a bookmark cannot be added to `bookmarks`, else undefined: names and times are unique in a list (§2.3.3.11).
export function bookmarkProblem(
	bookmarks: readonly MediaBookmark[] | undefined,
	name: string,
	timeMs: number,
	unread?: readonly string[]
): "name" | "time" | "duplicateName" | "duplicateTime" | "full" | undefined {
	if (!writableBookmark(name, timeMs))
		return name.trim() === "" || name.length > MEDIA_BOOKMARK_NAME_MAX || !writable(name) ? "name" : "time"
	if ((bookmarks?.length ?? 0) >= MEDIA_BOOKMARKS_MAX) return "full"
	if (bookmarks?.some(bookmark => bookmark.name === name) === true || unread?.includes(name) === true) return "duplicateName"
	if (bookmarks?.some(bookmark => bookmark.timeMs === timeMs) === true) return "duplicateTime"

	return undefined
}

// Whether a bookmark can be written as is (what an undo restores is held to this, never to the editor's rules on
// uniqueness and the list's size, which a file may break).
export function writableBookmark(name: string, timeMs: number): boolean {
	return name.trim() !== "" && name.length <= MEDIA_BOOKMARK_NAME_MAX && writable(name) && validTime(timeMs)
}

// `bookmarks` with one more, kept in time order.
export function withBookmark(bookmarks: readonly MediaBookmark[] | undefined, bookmark: MediaBookmark): MediaBookmark[] {
	const out = [...(bookmarks ?? [])]
	let at = out.length

	while (at > 0 && (out[at - 1]?.timeMs ?? 0) > bookmark.timeMs) at--

	out.splice(at, 0, { name: bookmark.name, timeMs: bookmark.timeMs })

	return out
}

// A trim or fade that changes playback (not both zero), else undefined.
export function activeTrim(trim: MediaTiming["trim"]): MediaTiming["trim"] {
	return trim !== undefined && (trim.startMs > 0 || trim.endMs > 0) ? trim : undefined
}

export function activeFade(fade: MediaTiming["fade"]): MediaTiming["fade"] {
	return fade !== undefined && (fade.inMs > 0 || fade.outMs > 0) ? fade : undefined
}

// The timing with empty groups dropped (a trim and fade of zero are the defaults, MS-PPTX §2.3.3.15/§2.3.3.18), or
// undefined when nothing is left.
export function normalizedMediaTiming(timing: MediaTiming): MediaTiming | undefined {
	const trim = activeTrim(timing.trim)
	const fade = activeFade(timing.fade)
	const bookmarks = timing.bookmarks !== undefined && timing.bookmarks.length > 0 ? timing.bookmarks : undefined
	const unread = timing.unread !== undefined && timing.unread.length > 0 ? timing.unread : undefined

	if (trim === undefined && fade === undefined && bookmarks === undefined && unread === undefined) return undefined

	return {
		...(trim === undefined ? {} : { trim }),
		...(fade === undefined ? {} : { fade }),
		...(bookmarks === undefined ? {} : { bookmarks }),
		...(unread === undefined ? {} : { unread })
	}
}

// --- PresentationML ---

// The timing a p14:media element holds (undefined when it holds none). A value that does not parse reads as its
// default and the element stays as the source wrote it until an edit of that group.
export function readMediaTiming(r: PartReader, media: number): MediaTiming | undefined {
	if (media < 0) return undefined

	const trimNode = r.child(media, P14, "trim")
	const fadeNode = r.child(media, P14, "fade")
	const list = r.child(media, P14, "bmkLst")
	const timing: {
		trim?: NonNullable<MediaTiming["trim"]>
		fade?: NonNullable<MediaTiming["fade"]>
		bookmarks?: MediaBookmark[]
		unread?: string[]
	} = {}

	if (trimNode >= 0)
		timing.trim = {
			startMs: parseUniversalTime(r.attr(trimNode, "st")) ?? 0,
			endMs: parseUniversalTime(r.attr(trimNode, "end")) ?? 0
		}

	if (fadeNode >= 0)
		timing.fade = { inMs: parseUniversalTime(r.attr(fadeNode, "in")) ?? 0, outMs: parseUniversalTime(r.attr(fadeNode, "out")) ?? 0 }

	if (list >= 0) {
		const bookmarks: MediaBookmark[] = []
		const unread: string[] = []

		for (const node of r.children(list, P14, "bmk")) {
			const bookmark = bookmarks.length >= MEDIA_BOOKMARKS_MAX ? undefined : readBookmark(r, node)

			if (bookmark === undefined) unread.push(r.attr(node, "name") ?? "")
			else bookmarks.push(bookmark)
		}

		bookmarks.sort((a, b) => a.timeMs - b.timeMs)
		timing.bookmarks = bookmarks

		if (unread.length > 0) timing.unread = unread
	}

	return trimNode < 0 && fadeNode < 0 && list < 0 ? undefined : timing
}

// One p14:bmk as the reader takes it: a name and a time within a day; undefined otherwise (kept as the file has it).
export function readBookmark(r: PartReader, node: number): MediaBookmark | undefined {
	const name = r.attr(node, "name")
	const timeMs = parseUniversalTime(r.attr(node, "time"))

	return name === undefined || timeMs === undefined ? undefined : { name, timeMs }
}

// The p14 namespace is declared on p14:media itself where an emit writes it; children carry the prefix.
export function trimXml(trim: NonNullable<MediaTiming["trim"]>): string {
	return `<p14:trim st="${formatUniversalTime(trim.startMs)}" end="${formatUniversalTime(trim.endMs)}"/>`
}

export function fadeXml(fade: NonNullable<MediaTiming["fade"]>): string {
	return `<p14:fade in="${formatUniversalTime(fade.inMs)}" out="${formatUniversalTime(fade.outMs)}"/>`
}

export function bookmarksXml(bookmarks: readonly MediaBookmark[]): string {
	if (bookmarks.length === 0) return ""

	let out = "<p14:bmkLst>"

	for (const bookmark of bookmarks) out += bookmarkXml(bookmark)

	return `${out}</p14:bmkLst>`
}

export function bookmarkXml(bookmark: MediaBookmark): string {
	return `<p14:bmk name="${escapeAttribute(bookmark.name)}" time="${formatUniversalTime(bookmark.timeMs)}"/>`
}

// The children of p14:media in schema order (trim, fade, bmkLst; its extLst is the caller's).
export function mediaTimingXml(timing: MediaTiming | undefined): string {
	const normal = timing === undefined ? undefined : normalizedMediaTiming(timing)

	if (normal === undefined) return ""

	return (
		(normal.trim === undefined ? "" : trimXml(normal.trim)) +
		(normal.fade === undefined ? "" : fadeXml(normal.fade)) +
		(normal.bookmarks === undefined ? "" : bookmarksXml(normal.bookmarks))
	)
}

// A p:tgtEl's p14:bmkTgt (MS-PPTX §2.3.1.1): the medium's shape and the bookmark that starts the condition.
export function readBookmarkTarget(r: PartReader, tgtEl: number): { readonly shape: number; readonly bookmark: string } | undefined {
	if (tgtEl < 0) return undefined

	const node = r.child(tgtEl, P14, "bmkTgt")

	if (node < 0) return undefined

	const shape = Number(r.attr(node, "spid"))
	const bookmark = r.attr(node, "bmkName")

	return Number.isSafeInteger(shape) && shape >= 0 && bookmark !== undefined ? { shape, bookmark } : undefined
}

export function bookmarkTargetXml(shape: number, bookmark: string): string {
	// ">" escaped too: no attribute value of a condition list holds "/>" (the timing emit respaces empty elements).
	const name = escapeAttribute(bookmark).replace(/>/gu, "&gt;")

	return `<p:tgtEl><p14:bmkTgt xmlns:p14="${P14_NAMESPACE}" spid="${String(shape)}" bmkName="${name}"/></p:tgtEl>`
}

// --- Bookmark triggers in the timing tree ---

// The condition a bookmark trigger starts its interactive sequence with (and advances it by).
export function bookmarkCondition(shape: number, bookmark: string): TimeCondition {
	return { evt: "onMediaBookmark", delay: 0, tgtEl: { kind: "shape", shape }, bookmark }
}

export function isBookmarkCondition(condition: TimeCondition): boolean {
	return condition.evt === "onMediaBookmark" && condition.bookmark !== undefined && condition.tgtEl?.kind === "shape"
}

function visit(node: TimeNode, each: (node: TimeNode) => void): void {
	each(node)

	for (const child of node.ctn.children) visit(child, each)
	for (const child of node.ctn.subTnLst ?? []) visit(child, each)
}

// The nodes a bookmark starts in a slide's timing (their begin conditions), by medium shape and bookmark name.
export function bookmarkTriggers(tree: TimingTree | undefined): { readonly shape: number; readonly bookmark: string }[] {
	const out: { shape: number; bookmark: string }[] = []

	if (tree === undefined) return out

	visit(tree.root, node => {
		for (const condition of node.ctn.stCondLst)
			if (isBookmarkCondition(condition) && condition.tgtEl?.kind === "shape" && condition.bookmark !== undefined)
				out.push({ shape: condition.tgtEl.shape, bookmark: condition.bookmark })
	})

	return out
}

// Whether a slide's timing names a media bookmark (p14: it is written in mc:AlternateContent, MS-PPTX §2.2.2).
export function hasBookmarkTriggers(tree: TimingTree | undefined): boolean {
	return bookmarkTriggers(tree).length > 0 || (tree !== undefined && someCondition(tree.root, isBookmarkCondition))
}

function someCondition(node: TimeNode, test: (condition: TimeCondition) => boolean): boolean {
	const lists = [node.ctn.stCondLst, node.ctn.endCondLst, node.ctn.nextCondLst ?? [], node.ctn.prevCondLst ?? []]

	if (lists.some(list => list.some(test))) return true

	return (
		node.ctn.children.some(child => someCondition(child, test)) || (node.ctn.subTnLst ?? []).some(child => someCondition(child, test))
	)
}

// The timing as a reader without p14 is given it (the Fallback of its mc:AlternateContent): each media bookmark
// condition becomes a click on its clip, as PowerPoint writes it. Written from the model alone (no source spans,
// which may hold p14).
export function bookmarkTriggersAsClicks(tree: TimingTree): TimingTree {
	const condition = (c: TimeCondition): TimeCondition =>
		isBookmarkCondition(c) && c.tgtEl?.kind === "shape"
			? { evt: "onClick", delay: c.delay, tgtEl: { kind: "shape", shape: c.tgtEl.shape } }
			: c
	const node = (n: TimeNode): TimeNode => {
		const { src: _src, raw: _raw, ...ctn } = n.ctn

		return {
			...n,
			ctn: {
				...ctn,
				stCondLst: ctn.stCondLst.map(condition),
				endCondLst: ctn.endCondLst.map(condition),
				...(ctn.nextCondLst === undefined ? {} : { nextCondLst: ctn.nextCondLst.map(condition) }),
				...(ctn.prevCondLst === undefined ? {} : { prevCondLst: ctn.prevCondLst.map(condition) }),
				children: ctn.children.map(node),
				...(ctn.subTnLst === undefined ? {} : { subTnLst: ctn.subTnLst.map(node) })
			}
		} as TimeNode
	}

	return {
		root: node(tree.root),
		builds: tree.builds.map(build => {
			const { src: _src, raw: _raw, ...rest } = build

			return rest as typeof build
		})
	}
}

// --- Conversion losses (ODF has no form for any of these) ---

export function mediaTimingLosses(timing: MediaTiming | undefined): string[] {
	const normal = timing === undefined ? undefined : normalizedMediaTiming(timing)
	const out: string[] = []

	if (normal?.trim !== undefined) out.push("media trim")
	if (normal?.fade !== undefined) out.push("media fade")

	for (let k = 0; k < (normal?.bookmarks?.length ?? 0); k++) out.push("media bookmark")

	return out
}

// --- Playback schedule (what the show's player applies) ---

// The part of a medium that plays, in ms of the medium: from the trimmed start to the trimmed end (the medium's
// length, `durationMs`, unknown until its metadata: then only the start is known).
export interface PlayWindow {
	readonly startMs: number
	readonly endMs: number
}

export function playWindow(timing: MediaTiming | undefined, durationMs: number): PlayWindow {
	const trim = timing?.trim
	const length = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY
	const startMs = Math.min(trim?.startMs ?? 0, Number.isFinite(length) ? length : Number.POSITIVE_INFINITY)
	const endMs = Math.max(startMs, length - (trim?.endMs ?? 0))

	return { startMs, endMs }
}

// The gain (0..1) the fade gives at `positionMs` of the medium, inside `window`: rising over `in` from the window's
// start, falling over `out` to its end (linear, as PowerPoint's fade).
export function fadeGain(timing: MediaTiming | undefined, window: PlayWindow, positionMs: number): number {
	const fade = timing?.fade

	if (fade === undefined) return 1

	let gain = 1

	if (fade.inMs > 0) gain = Math.min(gain, Math.max(0, (positionMs - window.startMs) / fade.inMs))
	if (fade.outMs > 0 && Number.isFinite(window.endMs)) gain = Math.min(gain, Math.max(0, (window.endMs - positionMs) / fade.outMs))

	return Math.min(1, Math.max(0, gain))
}

// The bookmarks crossed while the medium played from `fromMs` (exclusive) to `toMs` (inclusive), in order, by index
// into the time-ordered list; a seek backwards crosses none. Walks from `cursor` (the first bookmark after `fromMs`),
// so a frame costs O(bookmarks crossed).
export class BookmarkCursor {
	private readonly times: Float64Array
	private readonly names: readonly string[]
	private next = 0

	constructor(bookmarks: readonly MediaBookmark[] | undefined) {
		const list = bookmarks ?? []

		this.times = Float64Array.from(list, bookmark => bookmark.timeMs)
		this.names = list.map(bookmark => bookmark.name)
	}

	get size(): number {
		return this.times.length
	}

	// Places the cursor after a seek: the next bookmark is the first at or after `ms`.
	seek(ms: number): void {
		let low = 0
		let high = this.times.length

		while (low < high) {
			const mid = (low + high) >>> 1

			if ((this.times[mid] ?? 0) < ms) low = mid + 1
			else high = mid
		}

		this.next = low
	}

	// Calls `fire` with each bookmark at or before `ms` not yet passed.
	advance(ms: number, fire: (name: string) => void): void {
		const times = this.times

		while (this.next < times.length && (times[this.next] ?? 0) <= ms) {
			const name = this.names[this.next] ?? ""

			this.next++
			fire(name)
		}
	}
}

// Whether a source p:pic's markup has p14:media (by its extension uri, in the UTF-8 bytes an inverse holds): what an
// op can give a trim, fade or bookmarks to. A PowerPoint 2007 medium (a:videoFile alone) has nowhere to hold them.
export function holdsP14Media(raw: Uint8Array): boolean {
	const text = P14_MEDIA_EXT
	const first = text.charCodeAt(0)

	outer: for (let i = raw.indexOf(first); i >= 0 && i + text.length <= raw.length; i = raw.indexOf(first, i + 1)) {
		for (let k = 1; k < text.length; k++) if (raw[i + k] !== text.charCodeAt(k)) continue outer

		return true
	}

	return false
}
