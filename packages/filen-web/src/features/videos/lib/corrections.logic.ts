import {
	activeLibraryOverrides,
	episodeOverrideKey,
	newSeriesId,
	rawLibraryOverride,
	seriesOverrideKey,
	splitOverrideKey,
	titleOverrideKey,
	withLibraryOverride,
	type CorrectionOriginal,
	type LibraryConfigDoc,
	type LibraryOverride,
	type Stamp
} from "@filen/shared/videos"
import type { VideoCorrectionTarget, VideoEpisodeView, VideoTitleDetail, VideoTitleView } from "@/workers/videoIndex/view.logic"

// Manual corrections (title and year, movie / episode / other, merging and splitting series, hiding), as edits of
// the synced library configuration. A correction is one register per key. An edit starts from the register as
// stored (fields this version doesn't know included) and stores only what differs from what the classifier made of
// the item, so saving again never loses a field; clearing every field removes it.

export type CorrectionKind = "movie" | "episode" | "other"

export function isCorrectionKind(value: string): value is CorrectionKind {
	return value === "movie" || value === "episode" || value === "other"
}

// An item to correct: its key, what the classifier made of it, and for a series what Split may take apart.
export interface CorrectionSubject {
	key: string
	original: CorrectionOriginal
	// Series: its id, merge key and how many roots the classifier itself merged it from.
	seriesId: string
	mergeKey: string
	autoMergedRoots: number
}

function plainOriginal(fields: Partial<CorrectionOriginal> & Pick<CorrectionOriginal, "kind" | "title">): CorrectionOriginal {
	return { year: 0, season: 0, episode: 0, episodeEnd: 0, seriesKey: "", ...fields }
}

export function titleSubject(detail: VideoTitleDetail): CorrectionSubject {
	const { title } = detail
	const stableUuids =
		detail.kind === "movie"
			? detail.versions.flatMap(version => version.parts.map(part => part.file.stableUuid))
			: detail.kind === "other" && detail.part !== null
				? [detail.part.file.stableUuid]
				: []
	const key =
		detail.overrideKey ?? (detail.kind === "series" ? seriesOverrideKey(title.id) : titleOverrideKey({ id: title.id, stableUuids }))

	return subjectOf({
		title,
		key,
		original: detail.original,
		autoMergedRoots: detail.kind === "series" ? (detail.autoMergedRoots ?? 1) : 1
	})
}

// A title's subject from the worker's correction context (Set as and Hide on several titles).
export function targetSubject(target: VideoCorrectionTarget): CorrectionSubject {
	return subjectOf({
		title: target.title,
		key: target.overrideKey,
		original: target.original,
		autoMergedRoots: target.autoMergedRoots
	})
}

function subjectOf({
	title,
	key,
	original,
	autoMergedRoots
}: {
	title: VideoTitleView
	key: string
	original: CorrectionOriginal | undefined
	autoMergedRoots: number
}): CorrectionSubject {
	const series = title.kind === "series"

	return {
		key,
		original: original ?? plainOriginal({ kind: title.kind, title: title.title, year: title.year }),
		seriesId: series ? title.id : "",
		mergeKey: series ? title.mergeKey : "",
		autoMergedRoots: series ? autoMergedRoots : 1
	}
}

export function episodeSubject(seriesId: string, episode: VideoEpisodeView): CorrectionSubject | null {
	const first = episode.versions[0]?.parts[0]?.file.stableUuid

	return first === undefined
		? null
		: {
				key: episode.overrideKey ?? episodeOverrideKey(first),
				original:
					episode.original ??
					plainOriginal({
						kind: "episode",
						title: episode.title,
						season: episode.season,
						episode: episode.episode,
						episodeEnd: episode.episodeEnd,
						seriesKey: seriesOverrideKey(seriesId)
					}),
				seriesId: "",
				mergeKey: "",
				autoMergedRoots: 1
			}
}

// The dialog's fields as typed.
export interface CorrectionDraft {
	title: string
	year: string
	kind: CorrectionKind
	// The series an episode belongs to (a `d:` key), or "new" for a series of its own.
	series: string
	season: string
	episode: string
	// Last episode of a multi-episode file; may stay empty (just `episode`).
	episodeEnd: string
	hidden: boolean
}

export const NEW_SERIES = "new"

function countText(value: number | undefined, fallback: number, min: number): string {
	const n = value ?? fallback

	return n >= min ? String(n) : ""
}

// The fields as they show now: the stored correction's values, else the classifier's.
export function draftFor(subject: CorrectionSubject, current: LibraryOverride | null): CorrectionDraft {
	const { original } = subject
	const episodic = original.kind === "episode"
	const kind: CorrectionKind =
		current?.kind === "movie" || current?.kind === "other" || current?.kind === "episode"
			? current.kind
			: original.kind === "series"
				? "movie"
				: original.kind
	const episode = countText(current?.episode, episodic ? original.episode : 0, 1)
	const end = current?.episodeEnd ?? (episodic && current?.episode === undefined ? original.episodeEnd : undefined)

	return {
		title: current?.title ?? original.title,
		year: countText(current?.year, original.year, 1800),
		kind,
		series: current?.mergeInto ?? (episodic ? original.seriesKey : NEW_SERIES),
		season: episodic || current?.season !== undefined ? String(current?.season ?? original.season) : "",
		episode,
		episodeEnd: end !== undefined && String(end) !== episode ? String(end) : "",
		hidden: current?.hidden === true
	}
}

export type DraftError = "year" | "season" | "episode" | "title"

function parseCount(value: string, min: number): number | null {
	const trimmed = value.trim()

	if (!/^\d{1,5}$/.test(trimmed)) {
		return null
	}

	const n = Number(trimmed)

	return n >= min ? n : null
}

// Whether the dialog shows the year, and a save stores it: a series' and a movie's.
export function showsYear(subject: CorrectionSubject, draft: Pick<CorrectionDraft, "kind">): boolean {
	return subject.original.kind === "series" || draft.kind === "movie"
}

// Fields that block saving: an empty title, a shown year outside 1800-2200, and an episode without its season and
// number (an end before its first episode too).
export function draftErrors(subject: CorrectionSubject, draft: CorrectionDraft): DraftError[] {
	const errors: DraftError[] = []

	if (draft.title.trim().length === 0) {
		errors.push("title")
	}

	if (showsYear(subject, draft) && draft.year.trim().length > 0) {
		const year = parseCount(draft.year, 1800)

		if (year === null || year > 2200) {
			errors.push("year")
		}
	}

	if (draft.kind === "episode") {
		const episode = parseCount(draft.episode, 1)
		const end = draft.episodeEnd.trim().length === 0 ? episode : parseCount(draft.episodeEnd, 1)

		if (parseCount(draft.season, 0) === null) {
			errors.push("season")
		}

		if (episode === null || end === null || end < episode) {
			errors.push("episode")
		}
	}

	return errors
}

// Where the page goes after a save: the title the subject is shown as now (null to stay).
export function destinationOf(subject: CorrectionSubject, draft: CorrectionDraft): string | null {
	if (subject.original.kind === "series") {
		return null
	}

	if (draft.kind === "episode") {
		return draft.series === NEW_SERIES ? newSeriesId(subject.key.slice(2)) : draft.series.slice(2)
	}

	// A movie's or other video's id is its key's.
	return subject.key.slice(2)
}

type Fields = Record<string, unknown>

// Sets `field` when `value` differs from the classifier's, removes it otherwise.
function setDiff(out: Fields, field: string, value: unknown, original: unknown): void {
	if (value === undefined || value === original) {
		Reflect.deleteProperty(out, field)
	} else {
		out[field] = value
	}
}

// The correction a valid draft stands for: the stored register (`raw`, unknown fields included) with every field the
// dialog shows set to what differs from the classifier, removed where it doesn't. Merge and split fields of a series
// are kept. null when nothing remains (saving removes the correction).
export function overrideFromDraft({
	subject,
	draft,
	raw
}: {
	subject: CorrectionSubject
	draft: CorrectionDraft
	raw: Readonly<Fields> | null
}): Fields | null {
	const { original } = subject
	const out: Fields = { ...raw }
	const title = draft.title.trim()

	setDiff(out, "title", title.length > 0 ? title : undefined, original.title)

	if (showsYear(subject, draft)) {
		setDiff(out, "year", parseCount(draft.year, 1800) ?? undefined, original.year)
	}

	if (original.kind !== "series") {
		const episodic = original.kind === "episode"

		setDiff(out, "kind", draft.kind, original.kind)

		if (draft.kind === "episode") {
			const episode = parseCount(draft.episode, 1)
			const end = draft.episodeEnd.trim().length === 0 ? undefined : (parseCount(draft.episodeEnd, 1) ?? undefined)
			const series = draft.series === NEW_SERIES ? undefined : draft.series

			setDiff(out, "season", parseCount(draft.season, 0) ?? undefined, episodic ? original.season : undefined)
			setDiff(out, "episode", episode ?? undefined, episodic ? original.episode : undefined)
			setDiff(
				out,
				"episodeEnd",
				end === episode ? undefined : end,
				episodic && original.episodeEnd !== original.episode ? original.episodeEnd : undefined
			)
			setDiff(out, "mergeInto", series, episodic ? original.seriesKey : undefined)

			// An episode whose numbers moved is stored as one, so the classifier's numbers can't take over again.
			if (episodic && (out["season"] !== undefined || out["episode"] !== undefined || out["episodeEnd"] !== undefined)) {
				out["kind"] = "episode"
				out["season"] = parseCount(draft.season, 0)
				out["episode"] = episode
			}
		} else {
			for (const field of ["season", "episode", "episodeEnd", "mergeInto"]) {
				Reflect.deleteProperty(out, field)
			}
		}
	}

	if (original.kind !== "episode") {
		setDiff(out, "hidden", draft.hidden ? true : undefined, undefined)
	}

	return Object.keys(out).length === 0 ? null : out
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(canonical)
	}

	if (typeof value !== "object" || value === null) {
		return value
	}

	return Object.fromEntries(
		Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, entry]) => [key, canonical(entry)])
	)
}

// Whether two corrections hold the same fields (a save that changes nothing writes nothing).
export function sameOverride(a: Readonly<Fields> | null, b: Readonly<Fields> | null): boolean {
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

export type ConfigEdit = (doc: LibraryConfigDoc, stamp: Stamp) => LibraryConfigDoc

// Sets (or, with null, removes) the correction under `key`.
export function correctionEdit(key: string, override: Readonly<Fields> | null): ConfigEdit {
	return (doc, stamp) => withLibraryOverride({ doc, key, override, stamp, at: Date.now() })
}

function changeOverride(doc: LibraryConfigDoc, key: string, change: (current: Fields) => Fields): Fields | null {
	const next = change({ ...rawLibraryOverride(doc, key) })

	return Object.keys(next).length === 0 ? null : next
}

// One correction field changed in place, the rest kept exactly as stored (read from the document the edit applies
// to, fields this version doesn't know included).
export function patchEdit(key: string, change: (current: Fields) => Fields): ConfigEdit {
	return (doc, stamp) => withLibraryOverride({ doc, key, override: changeOverride(doc, key, change), stamp, at: Date.now() })
}

function without(fields: Fields, field: string): Fields {
	const out = { ...fields }

	Reflect.deleteProperty(out, field)

	return out
}

function hiddenAs(current: Fields, hidden: boolean): Fields {
	return hidden ? { ...current, hidden: true } : without(current, "hidden")
}

export function hideEdit(key: string, hidden: boolean): ConfigEdit {
	return patchEdit(key, current => hiddenAs(current, hidden))
}

// Hides (or shows) every title under `keys` in one write.
export function hideManyEdit(keys: readonly string[], hidden: boolean): ConfigEdit {
	return (doc, stamp) => {
		let next = doc

		for (const key of new Set(keys)) {
			const override = changeOverride(next, key, current => hiddenAs(current, hidden))

			if (!sameOverride(override, rawLibraryOverride(next, key))) {
				next = withLibraryOverride({ doc: next, key, override, stamp, at: Date.now() })
			}
		}

		return next
	}
}

// Shows a hidden title again, whichever of its keys (`s:` or `d:` + its id) holds the hiding.
export function unhideEdit(titleId: string): ConfigEdit {
	return (doc, stamp) => {
		let next = doc

		for (const key of [episodeOverrideKey(titleId), seriesOverrideKey(titleId)]) {
			if (activeLibraryOverrides(next)[key]?.hidden === true) {
				next = withLibraryOverride({
					doc: next,
					key,
					override: changeOverride(next, key, current => without(current, "hidden")),
					stamp,
					at: Date.now()
				})
			}
		}

		return next
	}
}

// Shows `seriesId` as part of `intoId`.
export function mergeEdit(seriesId: string, intoId: string): ConfigEdit {
	return patchEdit(seriesOverrideKey(seriesId), current => ({ ...current, mergeInto: seriesOverrideKey(intoId) }))
}

// Series merged into `seriesId` by hand, by key.
export function mergedInto(doc: LibraryConfigDoc, seriesId: string): string[] {
	const target = seriesOverrideKey(seriesId)
	const overrides = activeLibraryOverrides(doc)

	return Object.keys(overrides).filter(key => key.startsWith("d:") && overrides[key]?.mergeInto === target)
}

// Takes a series apart: what was merged into it by hand goes back to being its own series, and when the classifier
// itself merged it from same-titled series of several roots, those are kept apart (stored by merge key, so it holds
// whichever root comes first).
export function splitEdit(subject: Pick<CorrectionSubject, "seriesId" | "mergeKey" | "autoMergedRoots">): ConfigEdit {
	return (doc, stamp) => {
		let next = doc

		for (const key of mergedInto(doc, subject.seriesId)) {
			next = withLibraryOverride({
				doc: next,
				key,
				override: changeOverride(next, key, current => without(current, "mergeInto")),
				stamp,
				at: Date.now()
			})
		}

		if (subject.autoMergedRoots > 1 && subject.mergeKey.length > 0) {
			const key = splitOverrideKey(subject.mergeKey)

			next = withLibraryOverride({
				doc: next,
				key,
				override: changeOverride(next, key, current => ({ ...current, split: true })),
				stamp,
				at: Date.now()
			})
		}

		return next
	}
}

// Whether Split has anything to take apart: an automatic merge across roots, or series merged in by hand.
export function canSplit({ doc, subject }: { doc: LibraryConfigDoc | undefined; subject: CorrectionSubject }): boolean {
	return (
		(subject.autoMergedRoots > 1 && subject.mergeKey.length > 0) || (doc !== undefined && mergedInto(doc, subject.seriesId).length > 0)
	)
}

// Reset: the item's correction goes, and for a series a split stored for its title too.
export function resetEdit(subject: CorrectionSubject): ConfigEdit {
	return (doc, stamp) => {
		let next = withLibraryOverride({ doc, key: subject.key, override: null, stamp, at: Date.now() })

		if (subject.mergeKey.length > 0 && rawLibraryOverride(next, splitOverrideKey(subject.mergeKey)) !== null) {
			next = withLibraryOverride({ doc: next, key: splitOverrideKey(subject.mergeKey), override: null, stamp, at: Date.now() })
		}

		return next
	}
}

// Whether the item has anything Reset could remove.
export function hasCorrection(doc: LibraryConfigDoc | undefined, subject: CorrectionSubject): boolean {
	return (
		doc !== undefined &&
		(rawLibraryOverride(doc, subject.key) !== null ||
			(subject.mergeKey.length > 0 && rawLibraryOverride(doc, splitOverrideKey(subject.mergeKey)) !== null))
	)
}
