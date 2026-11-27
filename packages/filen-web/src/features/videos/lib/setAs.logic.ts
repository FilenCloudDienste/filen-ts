import { fastLocaleCompare } from "@filen/shared"
import {
	activeLibraryOverrides,
	displayTitle,
	extensionDot,
	newSeriesId,
	parseEpisode,
	rawLibraryOverride,
	seriesOverrideKey,
	withLibraryOverride,
	type LibraryConfigDoc,
	type LibraryOverride,
	type Stamp
} from "@filen/shared/videos"
import {
	NEW_SERIES,
	draftFor,
	overrideFromDraft,
	sameOverride,
	targetSubject,
	type ConfigEdit,
	type CorrectionDraft,
	type CorrectionSubject
} from "@/features/videos/lib/corrections.logic"
import type { VideoCorrectionTarget } from "@/workers/videoIndex/view.logic"

// Set as: titles shown as movies, other videos or episodes of one series in one write, each correction saved as the
// corrections dialog would save it (the draft it shows, with the kind and numbers set). A series stays a series, as
// in the dialog: it is left out.

// A title Set as can change: its correction subject and the name of the file it plays first (episode numbers are
// read from it).
export interface SetAsSource {
	id: string
	title: string
	fileName: string
	subject: CorrectionSubject
}

export function setAsSources(targets: readonly VideoCorrectionTarget[]): { sources: SetAsSource[]; skipped: number } {
	const sources: SetAsSource[] = []
	let skipped = 0

	for (const target of targets) {
		if (target.title.kind === "series") {
			skipped++

			continue
		}

		sources.push({
			id: target.title.id,
			title: target.title.title,
			fileName: target.title.primary?.name ?? "",
			subject: targetSubject(target)
		})
	}

	return { sources, skipped }
}

// One subject's correction with its draft changed, against the document as it is when the edit applies.
function withDraft({
	doc,
	stamp,
	subject,
	current,
	change
}: {
	doc: LibraryConfigDoc
	stamp: Stamp
	subject: CorrectionSubject
	current: LibraryOverride | null
	change: (draft: CorrectionDraft) => CorrectionDraft
}): LibraryConfigDoc {
	const raw = rawLibraryOverride(doc, subject.key)
	const next = overrideFromDraft({ subject, draft: change(draftFor(subject, current)), raw })

	return sameOverride(next, raw) ? doc : withLibraryOverride({ doc, key: subject.key, override: next, stamp, at: Date.now() })
}

function uniqueByKey<T>(items: readonly T[], subjectOf: (item: T) => CorrectionSubject): T[] {
	const seen = new Set<string>()

	return items.filter(item => {
		const { key, original } = subjectOf(item)

		if (original.kind === "series" || seen.has(key)) {
			return false
		}

		seen.add(key)

		return true
	})
}

// Shows every subject as a movie or another video.
export function setKindEdit(subjects: readonly CorrectionSubject[], kind: "movie" | "other"): ConfigEdit {
	return (doc, stamp) => {
		const active = activeLibraryOverrides(doc)
		let next = doc

		for (const subject of uniqueByKey(subjects, subject => subject)) {
			next = withDraft({
				doc: next,
				stamp,
				subject,
				current: active[subject.key] ?? null,
				change: draft => ({ ...draft, kind })
			})
		}

		return next
	}
}

export interface EpisodeNumber {
	season: number
	episode: number
	episodeEnd: number
}

export interface PlannedEpisode extends EpisodeNumber {
	source: SetAsSource
	// Read from its file name; false when it got the next free number.
	derived: boolean
}

function stemOf(name: string): string {
	const dot = extensionDot(name)

	return dot === -1 ? name : name.slice(0, dot)
}

// The episode marker in a file name, read as inside a series (loose numbering too); null without one or for a
// date-based episode, which has no number.
function nameMatch(fileName: string): { match: NonNullable<ReturnType<typeof parseEpisode>>; stem: string } | null {
	const stem = stemOf(fileName)
	const match = stem.length === 0 ? null : parseEpisode(stem, true)

	return match === null || match.episode < 1 ? null : { match, stem }
}

// Season and episode numbers for each source, in order: read from its file name where it names them (a marker
// without a season is season 1), else the next free numbers after every episode the series has (`taken`) or is
// given here, in the season most named ones are in (else the series' last one, else 1), by file name.
export function planEpisodes({ sources, taken }: { sources: readonly SetAsSource[]; taken: readonly EpisodeNumber[] }): PlannedEpisode[] {
	const plan: (PlannedEpisode | null)[] = []
	const last = new Map<number, number>()
	const seasonCounts = new Map<number, number>()
	const unnamed: { index: number; source: SetAsSource }[] = []

	function use(number: EpisodeNumber): void {
		last.set(number.season, Math.max(last.get(number.season) ?? 0, number.episode, number.episodeEnd))
	}

	taken.forEach(use)

	sources.forEach((source, index) => {
		const found = nameMatch(source.fileName)

		if (found === null) {
			plan.push(null)
			unnamed.push({ index, source })

			return
		}

		const season = found.match.season >= 0 ? found.match.season : 1
		const entry: PlannedEpisode = {
			source,
			season,
			episode: found.match.episode,
			episodeEnd: Math.max(found.match.episode, found.match.episodeEnd),
			derived: true
		}

		plan.push(entry)
		use(entry)
		seasonCounts.set(season, (seasonCounts.get(season) ?? 0) + 1)
	})

	let season = taken.reduce((highest, number) => Math.max(highest, number.season), 0) || 1
	let most = 0

	for (const [number, count] of seasonCounts) {
		if (count > most || (count === most && number < season)) {
			season = number
			most = count
		}
	}

	unnamed.sort((a, b) => fastLocaleCompare(a.source.fileName, b.source.fileName) || a.index - b.index)

	for (const { index, source } of unnamed) {
		const episode = (last.get(season) ?? 0) + 1

		last.set(season, episode)
		plan[index] = { source, season, episode, episodeEnd: episode, derived: false }
	}

	return plan.filter(entry => entry !== null)
}

// The series name the file names agree on most (the text before their episode markers), else the first title's.
export function guessSeriesName(sources: readonly SetAsSource[]): string {
	const counts = new Map<string, number>()
	let best = ""
	let most = 0

	for (const source of sources) {
		const found = nameMatch(source.fileName)
		const name = found === null ? "" : displayTitle(found.stem.slice(0, found.match.start)).title.trim()

		if (name.length === 0) {
			continue
		}

		const count = (counts.get(name) ?? 0) + 1

		counts.set(name, count)

		if (count > most) {
			best = name
			most = count
		}
	}

	return best.length > 0 ? best : (sources[0]?.title ?? "")
}

// The series the episodes join: an existing one (its `d:` key), or a new one named `name`, started by the first.
export type ShowTarget = { kind: "existing"; key: string } | { kind: "new"; name: string }

function newSeriesKey(anchor: SetAsSource): string {
	return seriesOverrideKey(newSeriesId(anchor.id))
}

// Every planned title as an episode of one series. A new series is the one the first title starts (the classifier
// names it after that title); its name is stored on the new series' own key when it differs.
export function setShowEdit({ plan, target }: { plan: readonly PlannedEpisode[]; target: ShowTarget }): ConfigEdit {
	return (doc, stamp) => {
		const entries = uniqueByKey(plan, entry => entry.source.subject)
		const anchor = entries[0]

		if (anchor === undefined) {
			return doc
		}

		const active = activeLibraryOverrides(doc)
		const seriesKey = target.kind === "existing" ? target.key : newSeriesKey(anchor.source)
		let next = doc

		for (const entry of entries) {
			next = withDraft({
				doc: next,
				stamp,
				subject: entry.source.subject,
				current: active[entry.source.subject.key] ?? null,
				change: draft => ({
					...draft,
					kind: "episode",
					series: target.kind === "new" && entry === anchor ? NEW_SERIES : seriesKey,
					season: String(entry.season),
					episode: String(entry.episode),
					episodeEnd: entry.episodeEnd > entry.episode ? String(entry.episodeEnd) : ""
				})
			})
		}

		if (target.kind === "new") {
			const raw = rawLibraryOverride(next, seriesKey)
			const fields: Record<string, unknown> = { ...raw }
			const name = target.name.trim()

			if (name.length > 0 && name !== anchor.source.subject.original.title) {
				fields["title"] = name
			} else {
				Reflect.deleteProperty(fields, "title")
			}

			const override = Object.keys(fields).length === 0 ? null : fields

			if (!sameOverride(override, raw)) {
				next = withLibraryOverride({ doc: next, key: seriesKey, override, stamp, at: Date.now() })
			}
		}

		return next
	}
}

// The series' id the episodes are shown in after a save.
export function showDestination({ plan, target }: { plan: readonly PlannedEpisode[]; target: ShowTarget }): string | null {
	if (target.kind === "existing") {
		return target.key.slice(2)
	}

	const anchor = uniqueByKey(plan, entry => entry.source.subject)[0]

	return anchor === undefined ? null : newSeriesId(anchor.source.id)
}
