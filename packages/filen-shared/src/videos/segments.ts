export type SegmentKind = "intro" | "outro" | "recap" | "preview" | "commercial" | "intermission"

export type SegmentSource = "skipType" | "chapter" | "edl"

export interface SkipSegment {
	kind: SegmentKind
	start: number
	end: number
	source: SegmentSource
	// Always skipped, whatever the user's mode (EDL cuts).
	mustSkip?: boolean
}

export interface ChapterInfo {
	start: number
	end?: number | undefined
	title?: string | null | undefined
	// Matroska ChapterSkipType (0x4588). Absent = unknown (the title is consulted); 0 = never skip.
	skipType?: number | null | undefined
	// ChapterFlagEnabled / ChapterFlagHidden; disabled and hidden chapters never produce segments.
	enabled?: boolean | undefined
	hidden?: boolean | undefined
}

// 0 No Skipping, 1 Opening Credits, 2 End Credits, 3 Recap, 4 Next Preview, 5 Preview, 6 Advertisement, 7 Intermission.
const SKIP_TYPE_KINDS: readonly (SegmentKind | null)[] = [
	null,
	"intro",
	"outro",
	"recap",
	"preview",
	"preview",
	"commercial",
	"intermission"
]

export function segmentKindFromSkipType(skipType: number): SegmentKind | null {
	return SKIP_TYPE_KINDS[skipType] ?? null
}

// Whole-title forms only (after dropping numbering, brackets and a trailing "theme"/"song"), so "Post-Credits Scene",
// "Opening Scene" or "The Ending" never match; this also needs no word boundaries, which scripts without spaces lack.
const TITLE_FORMS: Readonly<Record<SegmentKind, readonly string[]>> = {
	intro: [
		"intro",
		"introduction",
		"opening",
		"opening credits",
		"opening titles",
		"opening sequence",
		"title sequence",
		"main titles",
		"main title",
		"vorspann",
		"titelsequenz",
		"générique",
		"generique",
		"générique de début",
		"generique de debut",
		"créditos iniciais",
		"creditos iniciais",
		"créditos de apertura",
		"abertura",
		"apertura",
		"sigla",
		"sigla iniziale",
		"titoli di testa",
		"op",
		"オープニング",
		"片头",
		"片頭",
		"오프닝",
		"인트로"
	],
	outro: [
		"outro",
		"ending",
		"ending credits",
		"ending sequence",
		"end credits",
		"closing",
		"closing credits",
		"credits",
		"abspann",
		"nachspann",
		"générique de fin",
		"generique de fin",
		"créditos",
		"creditos",
		"créditos finais",
		"créditos finales",
		"creditos finais",
		"sigla finale",
		"titoli di coda",
		"ed",
		"エンディング",
		"片尾",
		"엔딩",
		"아웃트로"
	],
	recap: [
		"recap",
		"previously",
		"previously on",
		"précédemment",
		"precedemment",
		"anteriormente",
		"前回",
		"前情提要",
		"前情回顾",
		"前情回顧",
		"지난 이야기"
	],
	preview: [
		"preview",
		"next time",
		"next episode",
		"coming up",
		"coming soon",
		"prochainement",
		"prochain épisode",
		"vorschau",
		"nächste folge",
		"avance",
		"próximo episodio",
		"próximo capítulo",
		"próximo episódio",
		"anteprima",
		"prossimamente",
		"次回予告",
		"予告",
		"下集预告",
		"下集預告",
		"예고"
	],
	commercial: [],
	intermission: []
}

const TITLE_KINDS: ReadonlyMap<string, SegmentKind> = new Map(
	(Object.entries(TITLE_FORMS) as [SegmentKind, readonly string[]][]).flatMap(([kind, forms]) => forms.map(form => [form, kind] as const))
)

const TITLE_SUFFIXES: readonly string[] = [" theme", " song", " thema", "テーマ", "主题曲", "主題曲", "曲"]

function titleKey(title: string): string {
	let key = title
		.slice(0, 256)
		.toLowerCase()
		.replace(/[()[\]【】「」"'“”‘’]/g, " ")
		.replace(/\s+/g, " ")
		.trim()

	key = key.replace(/^[\d\s.\-_:)]+/, "").replace(/[\d\s.\-_:]+$/, "")

	for (const suffix of TITLE_SUFFIXES) {
		if (key.length > suffix.length && key.endsWith(suffix)) {
			key = key
				.slice(0, key.length - suffix.length)
				.trim()
				.replace(/[\d\s.\-_:]+$/, "")

			break
		}
	}

	return key
}

// Kind implied by a chapter title; null when it names nothing skippable.
export function chapterNameKind(title: string | null | undefined): SegmentKind | null {
	if (title === null || title === undefined) {
		return null
	}

	const key = titleKey(title)

	if (key.length === 0) {
		return null
	}

	const kind = TITLE_KINDS.get(key)

	if (kind !== undefined) {
		return kind
	}

	if (key.startsWith("previously on ")) {
		return "recap"
	}

	return key.startsWith("next time on ") ? "preview" : null
}

// ChapterSkipType wins over the title; chapters end at their own end, the next chapter's start or the duration.
export function segmentsFromChapters(chapters: readonly ChapterInfo[], duration: number): SkipSegment[] {
	const out: SkipSegment[] = []

	for (let i = 0; i < chapters.length; i++) {
		const chapter = chapters[i] as ChapterInfo

		if (chapter.enabled === false || chapter.hidden === true) {
			continue
		}

		const skipType = chapter.skipType
		let kind: SegmentKind | null
		let source: SegmentSource = "skipType"

		if (skipType !== undefined && skipType !== null) {
			kind = segmentKindFromSkipType(skipType)
		} else {
			kind = chapterNameKind(chapter.title)
			source = "chapter"
		}

		if (kind === null) {
			continue
		}

		const next = chapters[i + 1]
		const end = chapter.end ?? next?.start ?? duration

		pushSegment(out, { kind, start: chapter.start, end, source }, duration)
	}

	return out
}

function pushSegment(out: SkipSegment[], segment: SkipSegment, duration: number): void {
	const s = Math.max(0, segment.start)
	const e = Math.min(segment.end, duration > 0 ? duration : segment.end)

	if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
		out.push({
			...segment,
			start: s,
			end: e
		})
	}
}

const MAX_EDL_LINES = 10_000

function parseNonNegative(value: string): number | null {
	if (value.length === 0 || value.length > 24) {
		return null
	}

	const n = Number(value)

	return Number.isFinite(n) && n >= 0 && /^[0-9.]+$/.test(value) ? n : null
}

// Seconds, `MM:SS(.sss)`, `HH:MM:SS(.sss)`, or `#frame` (needs fps).
function parseEdlToken(token: string, fps: number | null): number | null {
	if (token.charCodeAt(0) === 35) {
		if (fps === null || fps <= 0) {
			return null
		}

		const frame = parseNonNegative(token.slice(1))

		return frame === null ? null : frame / fps
	}

	if (token.indexOf(":") === -1) {
		return parseNonNegative(token)
	}

	const parts = token.split(":", 4)

	if (parts.length > 3) {
		return null
	}

	let total = 0

	for (let i = 0; i < parts.length; i++) {
		const part = parseNonNegative(parts[i] as string)

		if (part === null || (i < parts.length - 1 && !Number.isInteger(part))) {
			return null
		}

		total = total * 60 + part
	}

	return total
}

// Kodi EDL: `start end action`, times as seconds, `MM:SS`, `HH:MM:SS(.sss)` or `#frame` (dropped without fps); the 2-field form
// `time action` is zero-length and yields nothing. Action 0 (cut) is always skipped; 3 (commercial break) follows the user's
// mode; mute (1) and scene marker (2) are not skips.
export function parseEdl(text: string, fps?: number | null): SkipSegment[] {
	const out: SkipSegment[] = []
	const rate = fps ?? null
	let pos = 0
	let lines = 0

	while (pos < text.length && lines < MAX_EDL_LINES) {
		let end = text.indexOf("\n", pos)

		if (end === -1) {
			end = text.length
		}

		const line = text.slice(pos, Math.min(end, pos + 256)).trim()

		pos = end + 1
		lines++

		if (line.length === 0 || line.charCodeAt(0) === 47 || (line.charCodeAt(0) === 35 && line.length > 1 && line.charCodeAt(1) === 32)) {
			continue
		}

		const tokens = line.split(/\s+/, 4)

		if (tokens.length !== 2 && tokens.length !== 3) {
			continue
		}

		const startToken = tokens[0] as string
		const start = parseEdlToken(startToken, rate)
		const endToken = tokens.length === 3 ? (tokens[1] as string) : startToken
		const stop = parseEdlToken(endToken, rate)
		const action = Number(tokens[tokens.length - 1])

		if (start === null || stop === null || (action !== 0 && action !== 3)) {
			continue
		}

		if (stop > start) {
			out.push(
				action === 0
					? { kind: "commercial", start, end: stop, source: "edl", mustSkip: true }
					: { kind: "commercial", start, end: stop, source: "edl" }
			)
		}
	}

	return out
}

const SOURCE_PRIORITY: Readonly<Record<SegmentSource, number>> = { skipType: 0, chapter: 1, edl: 2 }

// First index whose end is after `time` in a start-sorted, non-overlapping list (so its ends ascend too).
function firstEndingAfter(list: readonly SkipSegment[], time: number): number {
	let lo = 0
	let hi = list.length

	while (lo < hi) {
		const mid = (lo + hi) >>> 1

		if ((list[mid] as SkipSegment).end <= time) {
			lo = mid + 1
		} else {
			hi = mid
		}
	}

	return lo
}

function mergeByStart(a: readonly SkipSegment[], b: readonly SkipSegment[]): SkipSegment[] {
	const out: SkipSegment[] = []
	let i = 0
	let j = 0

	while (i < a.length || j < b.length) {
		const left = a[i]
		const right = b[j]

		if (right === undefined || (left !== undefined && left.start <= right.start)) {
			out.push(left as SkipSegment)
			i++
		} else {
			out.push(right)
			j++
		}
	}

	return out
}

// Must-skip cuts are kept whole (overlapping ones joined). The rest merge by priority (skipType > chapter > edl): a
// lower-priority segment overlapping a kept one is dropped, cuts aside, so a cut never decides what survives; each kept
// segment is then trimmed around the cuts. Result is clamped to [0, duration] and sorted by start.
export function mergeSegments(sources: readonly (readonly SkipSegment[])[], duration: number): SkipSegment[] {
	const cuts: SkipSegment[] = []
	const all: SkipSegment[] = []

	for (const list of sources) {
		for (const segment of list) {
			pushSegment(segment.mustSkip === true ? cuts : all, segment, duration)
		}
	}

	cuts.sort((a, b) => a.start - b.start)

	const joinedCuts: SkipSegment[] = []

	for (const cut of cuts) {
		const last = joinedCuts[joinedCuts.length - 1]

		if (last !== undefined && cut.start < last.end) {
			if (cut.end > last.end) {
				joinedCuts[joinedCuts.length - 1] = {
					...last,
					end: cut.end
				}
			}

			continue
		}

		joinedCuts.push(cut)
	}

	all.sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] || a.start - b.start)

	// Untrimmed kept segments of the finished priorities, and of the current one: each start-sorted and non-overlapping,
	// so an overlap is one binary search plus a look at the current priority's last.
	let accepted: SkipSegment[] = []
	let group: SkipSegment[] = []
	let groupPriority = -1
	const out: SkipSegment[] = joinedCuts.slice()

	for (const segment of all) {
		const priority = SOURCE_PRIORITY[segment.source]

		if (priority !== groupPriority) {
			accepted = mergeByStart(accepted, group)
			group = []
			groupPriority = priority
		}

		const earlier = accepted[firstEndingAfter(accepted, segment.start)]
		const previous = group[group.length - 1]

		if ((earlier !== undefined && earlier.start < segment.end) || (previous !== undefined && previous.end > segment.start)) {
			continue
		}

		group.push(segment)

		let from = segment.start

		for (let c = firstEndingAfter(joinedCuts, from); c < joinedCuts.length; c++) {
			const cut = joinedCuts[c] as SkipSegment

			if (cut.start >= segment.end) {
				break
			}

			if (cut.start > from) {
				out.push({
					...segment,
					start: from,
					end: cut.start
				})
			}

			from = cut.end
		}

		if (from === segment.start) {
			out.push(segment)
		} else if (from < segment.end) {
			out.push({
				...segment,
				start: from
			})
		}
	}

	return out.sort((a, b) => a.start - b.start)
}

// Segment containing `time` (start <= time < end) in a start-sorted, non-overlapping list.
export function segmentAt(segments: readonly SkipSegment[], time: number): SkipSegment | null {
	let lo = 0
	let hi = segments.length - 1

	while (lo <= hi) {
		const mid = (lo + hi) >>> 1
		const segment = segments[mid] as SkipSegment

		if (time < segment.start) {
			hi = mid - 1
		} else if (time >= segment.end) {
			lo = mid + 1
		} else {
			return segment
		}
	}

	return null
}

export type SkipMode = "ask" | "auto" | "off"

export const SKIP_PROMPT_MIN_SECONDS = 3
export const SKIP_AUTO_MIN_SECONDS = 1
export const SKIP_CLICK_MIN_REMAINING_SECONDS = 1
export const SKIP_BUTTON_HIDE_MS = 8000
// An outro ending within this of the file end counts as reaching it.
export const OUTRO_END_TOLERANCE_SECONDS = 1

// Prompt for intro, outro and advertisements, nothing for the rest.
export function defaultSkipMode(kind: SegmentKind): SkipMode {
	return kind === "intro" || kind === "outro" || kind === "commercial" ? "ask" : "off"
}

export type SkipAction = "none" | "prompt" | "autoskip" | "upNext"

export function segmentAction(segment: SkipSegment, mode: SkipMode, duration: number): SkipAction {
	const length = segment.end - segment.start

	if (segment.mustSkip === true) {
		return length < SKIP_AUTO_MIN_SECONDS ? "none" : "autoskip"
	}

	if (mode === "off") {
		return "none"
	}

	if (segment.kind === "outro" && duration > 0 && segment.end >= duration - OUTRO_END_TOLERANCE_SECONDS) {
		return "upNext"
	}

	if (mode === "ask") {
		return length < SKIP_PROMPT_MIN_SECONDS ? "none" : "prompt"
	}

	return length < SKIP_AUTO_MIN_SECONDS ? "none" : "autoskip"
}

// Where a skip click seeks; null when 1 s or less of the segment remains.
export function skipTarget(segment: SkipSegment, time: number): number | null {
	return segment.end - time > SKIP_CLICK_MIN_REMAINING_SECONDS ? segment.end : null
}
