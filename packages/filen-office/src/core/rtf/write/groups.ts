import type { Checkpoint } from "../checkpoint"
import { isDestinationWord } from "../reader"
import { RtfTokenizer, Token } from "../tokenizer"

// Where a source paragraph sits in the RTF groups around it: what RTF written in its place closes, opens and carries.

// The groups open at given source positions (outermost first), each as whether it is a destination (or the
// document's own group): what a paragraph's content may close and open again around RTF written in its place.
// `from`: a checkpoint of the source's reading at or before every position, read on from there.
export function openGroups(bytes: Uint8Array, positions: readonly number[], from?: Checkpoint): Map<number, readonly boolean[]> {
	const steps = openGroupsSteps(bytes, positions, from, undefined)
	let step = steps.next()

	while (step.done !== true) step = steps.next()

	return step.value
}

// openGroups() stepping at `due` (looked at every few hundred tokens).
export function* openGroupsSteps(
	bytes: Uint8Array,
	positions: readonly number[],
	from: Checkpoint | undefined,
	due: (() => boolean) | undefined
): Generator<void, Map<number, readonly boolean[]>> {
	const sorted = [...new Set(positions)].sort((x, y) => x - y)
	const out = new Map<number, readonly boolean[]>()
	const tokens = new RtfTokenizer(bytes, from?.offset ?? 0)
	const open: boolean[] = from === undefined ? [] : from.frames.slice(1).map(frame => frame.opener)
	let pending = false
	let starred = false
	let next = 0
	let looks = 0

	for (;;) {
		if (due !== undefined && (++looks & 511) === 0 && due()) yield

		const kind = tokens.next()

		while (next < sorted.length && (sorted[next] ?? 0) <= tokens.start) {
			const snapshot = open.slice()

			if (pending) snapshot.push(starred)

			out.set(sorted[next] ?? 0, snapshot)
			next++
		}

		if (kind === Token.End || next === sorted.length) break

		if (pending) {
			if (kind === Token.Symbol && tokens.symbol === 0x2a) {
				starred = true

				continue
			}

			open.push(open.length === 0 || starred || (kind === Token.Word && isDestinationWord(tokens.name)))
			pending = false
			starred = false
		}

		if (kind === Token.GroupStart) pending = true
		else if (kind === Token.GroupEnd) open.pop()
	}

	return out
}

// How the content [start, end) of a paragraph sits in the groups around it: it may close formatting groups open
// at its start (Word ends a paragraph's last run and its \\par in one group and closes it in the next paragraph)
// and leave groups it opened open; RTF written in its place closes and opens as many. A destination (a field, a
// note) or the document's group closed or left open refuses: what follows would land in it.
// Words that put content in the story (text, breaks, notes, fields' marks), not state: never carried.
const CONTENT_WORDS = new Set([
	"par",
	"sect",
	"cell",
	"row",
	"nestcell",
	"nestrow",
	"tab",
	"line",
	"page",
	"column",
	"lbr",
	"chftn",
	"chatn",
	"chpgn",
	"chdate",
	"chtime",
	"sectnum",
	"u",
	"emdash",
	"endash",
	"emspace",
	"enspace",
	"qmspace",
	"bullet",
	"lquote",
	"rquote",
	"ldblquote",
	"rdblquote",
	"zwj",
	"zwnj",
	"zwbo",
	"zwnbo",
	"ltrmark",
	"rtlmark",
	"bin"
])

// The state words of a paragraph's source [start, end) that are still in force where it ends, by group level: the
// level it ends in or below (after the last group it closed there), then each group it opened and left open. Written
// after RTF put in its place, each in its group, so what follows starts in the state it did (a writer may leave a
// word for the next paragraph in the one before).
export function carriedWords(bytes: Uint8Array, start: number, end: number): Uint8Array[][] {
	const tokens = new RtfTokenizer(bytes.subarray(0, end), start)
	const levels: Uint8Array[][] = [[]]
	let pendingDestination = false

	for (let kind = tokens.next(); kind !== Token.End; kind = tokens.next()) {
		if (kind === Token.GroupStart) {
			levels.push([])
			pendingDestination = true

			continue
		}

		if (kind === Token.GroupEnd) {
			levels.pop()

			// Closing a group opened before the content: what this level held before is not the content's.
			if (levels.length === 0) levels.push([])

			pendingDestination = false

			continue
		}

		const first = pendingDestination

		pendingDestination = false

		// A destination's group: none of it is the story's state.
		if (first && ((kind === Token.Symbol && tokens.symbol === 0x2a) || (kind === Token.Word && isDestinationWord(tokens.name)))) {
			tokens.skipGroup()
			levels.pop()

			continue
		}

		if (kind === Token.Word && !CONTENT_WORDS.has(tokens.name)) levels.at(-1)?.push(bytes.subarray(tokens.start, tokens.end))
	}

	return levels
}

export function replaceable(
	bytes: Uint8Array,
	start: number,
	end: number,
	around: readonly boolean[]
): { readonly closes: number; readonly opens: number } | string {
	const tokens = new RtfTokenizer(bytes.subarray(0, end), start)
	const open: boolean[] = []
	let pending = false
	let starred = false
	let closes = 0

	for (;;) {
		const kind = tokens.next()

		if (kind === Token.End) break

		if (pending) {
			if (kind === Token.Symbol && tokens.symbol === 0x2a) {
				starred = true

				continue
			}

			open.push(starred || (kind === Token.Word && isDestinationWord(tokens.name)))
			pending = false
			starred = false
		}

		if (kind === Token.GroupStart) {
			pending = true
		} else if (kind === Token.GroupEnd) {
			if (open.length > 0) {
				open.pop()

				continue
			}

			const closed = around[around.length - 1 - closes]

			if (closed === undefined || closed) return "the paragraph closes a destination or the document"

			closes++
		}
	}

	if (pending) open.push(starred)
	if (open.some(destination => destination)) return "the paragraph ends inside a destination"

	return { closes, opens: open.length }
}
