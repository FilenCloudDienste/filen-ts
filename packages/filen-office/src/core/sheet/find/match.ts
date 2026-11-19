// Excel's Find and Replace text matching ("Find or replace text and numbers on a worksheet",
// support.microsoft.com): "?" stands for any one character, "*" for any run of characters, and "~" before either
// (or before "~") makes it literal. Without "Match entire cell contents" the text may be found anywhere in the cell.
// Case is ignored unless "Match case" is on. Matching is linear in the cell's text for each pattern position (an NFA
// walk, never backtracking), so no text or pattern makes it slow.

// Pattern token kinds.
const CHAR = 0
const ANY = 1
const STAR = 2

export interface FindOptions {
	readonly matchCase: boolean
	readonly wholeCell: boolean
}

export interface FindMatcher {
	// Whether the text holds a match (is one, for a whole-cell search).
	test(text: string): boolean
	// The text with every match replaced (leftmost first, each as long as it goes), or null when nothing matched.
	replace(text: string, replacement: string): string | null
}

// One UTF-16 unit folded for a case-blind compare: its lower case when that is one unit, else itself.
function foldUnit(unit: string): string {
	const lower = unit.toLowerCase()

	return lower.length === 1 ? lower : unit
}

// The text folded unit by unit, so offsets in it are offsets in the text.
export function foldText(text: string): string {
	const lower = text.toLowerCase()

	if (lower.length === text.length) return lower

	let folded = ""

	for (let i = 0; i < text.length; i++) folded += foldUnit(text.charAt(i))

	return folded
}

interface Pattern {
	readonly kinds: Uint8Array
	readonly chars: string
	readonly length: number
	// No wildcard: a plain substring search does.
	readonly literal: string | null
	// The runs between stars, for a quick yes or no: each run's characters ("?" as any one) and whether it holds a "?".
	readonly segments: readonly { readonly chars: string; readonly any: Uint8Array | null }[]
	readonly leadingStar: boolean
	readonly trailingStar: boolean
	// The walk's two state rows, reused.
	readonly current: Int32Array
	readonly next: Int32Array
}

// `escapeAny`: "~" makes any character after it literal (the functions' criteria), not "*", "?" and "~" alone (Find).
function parse(text: string, matchCase: boolean, escapeAny = false): Pattern {
	const kinds: number[] = []
	let chars = ""
	let wild = false

	for (let i = 0; i < text.length; i++) {
		const char = text.charAt(i)

		if (char === "~" && i + 1 < text.length && (escapeAny || "*?~".includes(text.charAt(i + 1)))) {
			kinds.push(CHAR)
			chars += text.charAt(++i)
		} else if (char === "*") {
			// A run of stars is one.
			if (kinds[kinds.length - 1] !== STAR) {
				kinds.push(STAR)
				chars += " "
			}

			wild = true
		} else if (char === "?") {
			kinds.push(ANY)
			chars += " "
			wild = true
		} else {
			kinds.push(CHAR)
			chars += char
		}
	}

	const folded = matchCase ? chars : foldText(chars)
	const segments: { chars: string; any: Uint8Array | null }[] = []
	let start = 0

	for (let i = 0; i <= kinds.length; i++) {
		if (i < kinds.length && kinds[i] !== STAR) continue

		if (i > start) {
			const any = kinds.slice(start, i).map(kind => (kind === ANY ? 1 : 0))

			segments.push({ chars: folded.slice(start, i), any: any.includes(1) ? Uint8Array.from(any) : null })
		}

		start = i + 1
	}

	return {
		kinds: Uint8Array.from(kinds),
		chars: folded,
		length: kinds.length,
		literal: wild ? null : folded,
		segments,
		leadingStar: kinds[0] === STAR,
		trailingStar: kinds[kinds.length - 1] === STAR,
		current: new Int32Array(kinds.length + 1),
		next: new Int32Array(kinds.length + 1)
	}
}

// Whether a run (with "?" for any one character) matches the text at `at`.
function segmentAt(segment: Pattern["segments"][number], text: string, at: number): boolean {
	const { chars, any } = segment

	if (at + chars.length > text.length) return false
	if (any === null) return text.startsWith(chars, at)

	for (let k = 0; k < chars.length; k++) if (any[k] === 0 && text.charCodeAt(at + k) !== chars.charCodeAt(k)) return false

	return true
}

// The first place at or after `from` a run matches, or -1.
function segmentFrom(segment: Pattern["segments"][number], text: string, from: number): number {
	if (segment.any === null) return text.indexOf(segment.chars, from)

	for (let at = from; at + segment.chars.length <= text.length; at++) if (segmentAt(segment, text, at)) return at

	return -1
}

// Whether the text holds a match (is one, when `whole`): each run between stars at the first place it fits after the
// one before, the first run at the start and the last at the end when no star frees them. Linear for runs without "?".
function holds(pattern: Pattern, text: string, whole: boolean): boolean {
	const { segments } = pattern

	if (segments.length === 0) return true

	let at = 0

	for (let j = 0; j < segments.length; j++) {
		const segment = segments[j] as Pattern["segments"][number]
		const first = j === 0 && whole && !pattern.leadingStar
		const last = j === segments.length - 1 && whole && !pattern.trailingStar

		if (last) {
			const end = text.length - segment.chars.length

			return end >= at && (!first || end === 0) && segmentAt(segment, text, end)
		}

		if (first) {
			if (!segmentAt(segment, text, 0)) return false

			at = segment.chars.length

			continue
		}

		const found = segmentFrom(segment, text, at)

		if (found < 0) return false

		at = found + segment.chars.length
	}

	return true
}

// The leftmost match at or after `from`, as long as it goes: [start, end], or null. An NFA over pattern positions,
// each holding the leftmost start that reaches it.
function leftmost(pattern: Pattern, text: string, from: number): readonly [number, number] | null {
	const { kinds, chars, length } = pattern
	let current = pattern.current.fill(-1)
	let next = pattern.next.fill(-1)
	let bestStart = -1
	let bestEnd = -1

	// A thread at `state` from `start`, through the stars it may skip.
	const add = (states: Int32Array, state: number, start: number): void => {
		let at = state

		for (;;) {
			const held = states[at] ?? -1

			if (held >= 0 && held <= start) return

			states[at] = start

			if (at === length || kinds[at] !== STAR) return

			at++
		}
	}

	for (let i = from; ; i++) {
		if (bestStart < 0) add(current, 0, i)

		const accepted = current[length] ?? -1

		if (accepted >= 0 && (bestStart < 0 || accepted < bestStart || (accepted === bestStart && i > bestEnd))) {
			bestStart = accepted
			bestEnd = i
		}

		if (i === text.length) break

		const unit = text.charAt(i)
		let alive = false

		next.fill(-1)

		for (let state = 0; state < length; state++) {
			const start = current[state] ?? -1

			// Once a match is found, a thread from a later start can no longer win.
			if (start < 0 || (bestStart >= 0 && start > bestStart)) continue

			const kind = kinds[state]

			if (kind === STAR) {
				add(next, state, start)
				alive = true
			} else if (kind === ANY || chars.charAt(state) === unit) {
				add(next, state + 1, start)
				alive = true
			}
		}

		const swap = current

		current = next
		next = swap

		if (!alive && bestStart >= 0) break
	}

	return bestStart < 0 ? null : [bestStart, bestEnd]
}

// A matcher for `text` as Excel's Find what reads it; null for an empty one (nothing to find).
export function findMatcher(text: string, options: FindOptions): FindMatcher | null {
	if (text === "") return null

	const pattern = parse(text, options.matchCase)
	const fold = (value: string): string => (options.matchCase ? value : foldText(value))

	if (options.wholeCell) {
		const whole = (value: string): boolean => (pattern.literal !== null ? value === pattern.literal : holds(pattern, value, true))

		return {
			test: value => whole(fold(value)),
			replace: (value, replacement) => (whole(fold(value)) ? replacement : null)
		}
	}

	return {
		test: value => {
			const folded = fold(value)

			return pattern.literal !== null ? folded.includes(pattern.literal) : holds(pattern, folded, false)
		},
		replace: (value, replacement) => {
			const folded = fold(value)
			let out = ""
			let at = 0
			let any = false

			for (;;) {
				let found: readonly [number, number] | null

				if (pattern.literal !== null) {
					const start = folded.indexOf(pattern.literal, at)

					found = start < 0 ? null : [start, start + pattern.literal.length]
				} else {
					found = at > folded.length ? null : leftmost(pattern, folded, at)
				}

				if (found === null) break

				const [start, end] = found

				any = true
				out += value.slice(at, start) + replacement

				// An empty match ("*" in an empty rest) ends the text; else go on after the match.
				if (end === start) {
					if (start >= value.length) {
						at = value.length

						break
					}

					out += value.charAt(start)
					at = start + 1
				} else {
					at = end
				}

				if (at >= value.length) break
			}

			return any ? out + value.slice(at) : null
		}
	}
}

// A wildcard pattern of the worksheet functions (COUNTIF and the other criteria, MATCH, SEARCH: support.microsoft.com
// "Using wildcard characters in searches") or of a filter's condition, matched by the same walks as Find's: linear,
// never backtracking, whatever the text and the pattern.
export interface WildcardMatcher {
	// Whether the text is a match (`whole`) or holds one.
	test(text: string, whole: boolean): boolean
	// Where the leftmost match at or after `from` starts, or -1.
	search(text: string, from: number): number
}

// `matchCase` false: case is ignored (pattern and text folded as foldText folds them); true: both are compared as they
// stand (normalized by the caller). `escapeAny`: "~" makes any character after it literal, as the functions read it; a
// filter's makes "*", "?" and "~" alone literal.
export function wildcardMatcher(text: string, matchCase: boolean, escapeAny = true): WildcardMatcher {
	const pattern = parse(text, matchCase, escapeAny)
	const fold = (value: string): string => (matchCase ? value : foldText(value))
	const { literal } = pattern

	return {
		test: (value, whole) => {
			const folded = fold(value)

			if (literal !== null) return whole ? folded === literal : folded.includes(literal)

			return holds(pattern, folded, whole)
		},
		search: (value, from) => {
			const folded = fold(value)

			if (literal !== null) return folded.indexOf(literal, from)

			return from > folded.length ? -1 : (leftmost(pattern, folded, from)?.[0] ?? -1)
		}
	}
}
