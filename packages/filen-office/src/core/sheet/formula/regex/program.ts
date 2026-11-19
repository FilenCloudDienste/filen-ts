import { CharClass, fold, isWord } from "./charset"
import { nullable, RegexUnsupportedError, type AssertKind, type Node, type Parsed } from "./syntax"

// The pattern compiled to instructions and run by a Pike VM: every alternative is followed at once, one step per
// character, so a match takes time linear in program × text and memory linear in the program. Threads keep the
// priority a backtracking matcher would try them in, so the match and its captures are PCRE2's leftmost-first ones.

const CHAR = 0
const CHAR_CASELESS = 1
const CLASS = 2
const ANY = 3
const ANY_BUT_NEWLINE = 4
const SPLIT = 5
const JUMP = 6
const SAVE = 7
const ASSERT = 8
const MATCH = 9

const ASSERT_CODES: Readonly<Record<AssertKind, number>> = {
	bol: 0,
	bolMulti: 1,
	eol: 2,
	eolMulti: 3,
	start: 4,
	end: 5,
	searchStart: 6,
	wordBoundary: 7,
	notWordBoundary: 8
}

// The most instructions a program may have: a match costs at most this many thread steps per character. The most
// thread steps times capture slots, when captures are kept (each capture copies its thread's slots).
const MAX_INSTRUCTIONS = 10_000
const MAX_CAPTURE_WORK = 2_000_000

// The most thread steps one budget may take (resetBudget): finding every match of a pattern over a text rescans what
// a match's higher-priority threads read past it, which this bounds.
export const STEP_BUDGET = 2_000_000

// The work a budget of thread steps comes with: one per instruction a thread is followed through (jumps, splits, saves
// and assertions take no step), and per capture copied one per eight of its slots. An ordinary search follows each
// thread through a few instructions per step (some four with captures: (.*a){20}), so WORK_PER_STEP plus a capture's
// copy per step leaves it twice that; a pattern matching nothing at every position (a thousand empty groups, thousands
// of empty alternatives) takes few steps and far more work. At most WORK_BUDGET.
const WORK_PER_STEP = 8
const WORK_BUDGET = 32_000_000

// The characters a node's matches start with (`codes`; a caseless letter by its fold, in `folded`), and whether it may
// match nothing (`empty`); null when not known.
interface Firsts {
	readonly codes: Set<number>
	readonly folded: Set<number>
	empty: boolean
}

function firstCodes(node: Node): Firsts | null {
	switch (node.type) {
		case "empty":
			return { codes: new Set(), folded: new Set(), empty: true }
		case "char":
			return node.caseless
				? { codes: new Set([node.code]), folded: new Set([fold(node.code)]), empty: false }
				: { codes: new Set([node.code]), folded: new Set(), empty: false }
		case "group":
			return firstCodes(node.body)
		case "repeat": {
			const body = firstCodes(node.body)

			return body === null ? null : { ...body, empty: body.empty || node.min === 0 }
		}
		case "alternate":
		case "concat": {
			const firsts: Firsts = { codes: new Set(), folded: new Set(), empty: node.type === "concat" }

			for (const item of node.type === "alternate" ? node.alternatives : node.items) {
				const first = firstCodes(item)

				if (first === null) return null

				for (const code of first.codes) firsts.codes.add(code)
				for (const code of first.folded) firsts.folded.add(code)

				if (node.type === "alternate") firsts.empty ||= first.empty
				else if (!first.empty) {
					firsts.empty = false

					return firsts
				}
			}

			return firsts
		}
		default:
			return null
	}
}

// The literal runs every match holds in order (the pattern's own letters, outside any repeat or alternative): a text
// that does not hold them in that order from a position holds no match from there.
function requiredRuns(root: Node): { readonly codes: readonly number[]; readonly caseless: readonly boolean[] }[] {
	const items = root.type === "concat" ? root.items : [root]
	const runs: { codes: number[]; caseless: boolean[] }[] = []
	let run: { codes: number[]; caseless: boolean[] } | null = null

	for (const item of items) {
		if (item.type === "char" && item.code <= 0xffff) {
			run ??= { codes: [], caseless: [] }
			run.codes.push(item.code)
			run.caseless.push(item.caseless)

			continue
		}

		if (run !== null) runs.push(run)

		run = null
	}

	if (run !== null) runs.push(run)

	return runs
}

// A search over its step budget: the formula keeps the file's result.
export class RegexBudgetError extends RegexUnsupportedError {}

const NEWLINE = 0x0a

// A count of instructions, Infinity past the limit: a nested repeat's product then never overflows to NaN.
function capped(count: number): number {
	return count > MAX_INSTRUCTIONS ? Infinity : count
}

// The instructions a node compiles to (Infinity past the limit).
function cost(node: Node, captures: boolean): number {
	switch (node.type) {
		case "empty":
			return 0
		case "char":
		case "class":
		case "any":
		case "assert":
			return 1
		case "group":
			return capped(cost(node.body, captures) + (captures ? 2 : 0))
		case "concat": {
			let total = 0

			for (const item of node.items) {
				total = capped(total + cost(item, captures))

				if (total === Infinity) return total
			}

			return total
		}
		case "alternate": {
			let total = -2

			for (const item of node.alternatives) {
				total = capped(total + cost(item, captures) + 2)

				if (total === Infinity) return total
			}

			return total
		}
		case "repeat": {
			const body = cost(node.body, captures)

			// Even repeated no times: the pattern is refused, not compiled to one that never matches.
			if (body === Infinity) return body
			if (node.max < 0) return capped(node.min === 0 ? body + 2 : node.min * body + 1)

			return capped(node.min * body + (node.max > node.min ? (node.max - node.min) * (body + 1) : 0))
		}
	}
}

// Whether every way a nullable node matches something comes before its way of matching nothing.
function emptyLast(node: Node): boolean {
	switch (node.type) {
		case "empty":
			return true
		case "group":
			return emptyLast(node.body)
		case "repeat":
			return node.min === 0 ? node.greedy && !nullable(node.body) : emptyLast(node.body)
		case "concat":
			return node.items.every(emptyLast)
		case "alternate":
			return node.alternatives.every((alternative, index) =>
				index === node.alternatives.length - 1 ? emptyLast(alternative) : !nullable(alternative)
			)
		default:
			return false
	}
}

function hasGroup(node: Node): boolean {
	switch (node.type) {
		case "group":
			return true
		case "repeat":
			return hasGroup(node.body)
		case "concat":
			return node.items.some(hasGroup)
		case "alternate":
			return node.alternatives.some(hasGroup)
		default:
			return false
	}
}

// PCRE2 ends a loop at an iteration that matches nothing, keeping that iteration. The VM drops such an iteration
// instead (it meets the loop's start again at the same place), which matches the same text only when matching
// nothing is the body's last choice, and the same captures only when the body holds none.
function checkLoops(node: Node, captures: boolean): void {
	switch (node.type) {
		case "group":
			checkLoops(node.body, captures)
			return
		case "concat":
			for (const item of node.items) checkLoops(item, captures)

			return
		case "alternate":
			for (const alternative of node.alternatives) checkLoops(alternative, captures)

			return
		case "repeat":
			if (node.max < 0 && nullable(node.body) && (!emptyLast(node.body) || (captures && hasGroup(node.body))))
				throw new RegexUnsupportedError("loop over a body that can match nothing")

			checkLoops(node.body, captures)
			return
		default:
			return
	}
}

export interface MatchOptions {
	// Where the search starts, in UTF-16 units.
	readonly start: number
	// Where \G holds: where the previous match ended (`start` by default).
	readonly previousEnd?: number
	// Only a match at `start`.
	readonly anchored?: boolean
	// No empty match at `start` (PCRE2_NOTEMPTY_ATSTART).
	readonly notEmptyAtStart?: boolean
}

interface ThreadList {
	readonly pcs: Int32Array
	readonly slots: Int32Array[]
	count: number
}

export class Program {
	private readonly ops: Uint8Array
	private readonly args: Int32Array
	private readonly args2: Int32Array
	private readonly classes: CharClass[] = []
	private length = 0
	// Capture slots kept per thread: 2 per group and 2 for the whole match.
	readonly slotCount: number
	// Literal text every match starts with (case-sensitive), found by indexOf.
	private readonly prefix: string
	// The characters every match starts with (from the Basic Multilingual Plane; a caseless letter by its fold), or null
	// when that is not known (a class, a pattern that may match nothing first): where no search is under way, the text
	// up to the next of them is passed over without a step.
	private readonly firstCodes: ReadonlySet<number> | null
	private readonly firstFolded: ReadonlySet<number>
	// The literal runs every match holds in order (requiredRuns), and the last text looked through for them with the
	// last position a match may start from in it (-1: none).
	private readonly runs: ReturnType<typeof requiredRuns>
	private runsText: string | null = null
	private runsFrom = -1
	// Whether every match starts at the start of the text (^ or \A first).
	private readonly startAnchored: boolean
	private readonly visited: Int32Array
	private stamp = 0
	private readonly stackPcs: number[] = []
	private readonly stackSlots: Int32Array[] = []
	private lists: [ThreadList, ThreadList] | null = null
	private budget = STEP_BUDGET
	private work = 0
	// The work one capture copied takes (WORK_PER_STEP).
	private readonly copyWork: number

	constructor(parsed: Parsed, captures: boolean) {
		const size = cost(parsed.root, captures) + 2

		// Negated: a count that is not a number fails too.
		if (!(size <= MAX_INSTRUCTIONS)) throw new RegexUnsupportedError("pattern too large")

		checkLoops(parsed.root, captures)

		this.slotCount = captures ? 2 * (parsed.groups + 1) : 2

		if (captures && !(size * this.slotCount <= MAX_CAPTURE_WORK)) throw new RegexUnsupportedError("pattern too large")

		this.copyWork = this.slotCount >> 3
		this.resetBudget()

		this.ops = new Uint8Array(size)
		this.args = new Int32Array(size)
		this.args2 = new Int32Array(size)
		this.emitNode(parsed.root, captures)
		this.emit(SAVE, 1)
		this.emit(MATCH)
		this.visited = new Int32Array(this.length)

		const first = parsed.root.type === "concat" ? parsed.root.items : [parsed.root]
		let prefix = ""

		for (const item of first) {
			if (item.type !== "char" || item.caseless) break

			prefix += String.fromCodePoint(item.code)
		}

		this.prefix = prefix

		const firsts = firstCodes(parsed.root)

		this.firstCodes = firsts === null || firsts.empty || [...firsts.codes].some(code => code > 0xffff) ? null : firsts.codes
		this.firstFolded = firsts?.folded ?? new Set()
		this.runs = requiredRuns(parsed.root)
		this.startAnchored = first[0]?.type === "assert" && (first[0].kind === "bol" || first[0].kind === "start")
	}

	private emit(op: number, arg = 0, arg2 = 0): number {
		const at = this.length++

		this.ops[at] = op
		this.args[at] = arg
		this.args2[at] = arg2

		return at
	}

	private patch(at: number, arg: number, arg2: number): void {
		this.args[at] = arg
		this.args2[at] = arg2
	}

	// A split preferring `first` when greedy.
	private split(at: number, body: number, out: number, greedy: boolean): void {
		if (greedy) this.patch(at, body, out)
		else this.patch(at, out, body)
	}

	private emitNode(node: Node, captures: boolean): void {
		switch (node.type) {
			case "empty":
				return
			case "char":
				if (node.caseless) this.emit(CHAR_CASELESS, fold(node.code), node.code)
				else this.emit(CHAR, node.code)

				return
			case "class":
				this.classes.push(node.set)
				this.emit(CLASS, this.classes.length - 1)
				return
			case "any":
				this.emit(node.newline ? ANY : ANY_BUT_NEWLINE)
				return
			case "assert":
				this.emit(ASSERT, ASSERT_CODES[node.kind])
				return
			case "group":
				if (captures) this.emit(SAVE, node.index * 2)

				this.emitNode(node.body, captures)

				if (captures) this.emit(SAVE, node.index * 2 + 1)

				return
			case "concat":
				for (const item of node.items) this.emitNode(item, captures)

				return
			case "alternate": {
				const jumps: number[] = []

				node.alternatives.forEach((alternative, index) => {
					if (index === node.alternatives.length - 1) {
						this.emitNode(alternative, captures)
						return
					}

					const split = this.emit(SPLIT)

					this.emitNode(alternative, captures)
					jumps.push(this.emit(JUMP))
					this.patch(split, split + 1, this.length)
				})

				for (const jump of jumps) this.patch(jump, this.length, 0)

				return
			}
			case "repeat":
				this.emitRepeat(node.body, node.min, node.max, node.greedy, captures)
				return
		}
	}

	private emitRepeat(body: Node, min: number, max: number, greedy: boolean, captures: boolean): void {
		if (cost(body, captures) === 0) return

		if (max < 0) {
			for (let index = 1; index < min; index++) this.emitNode(body, captures)

			if (min > 0) {
				// body+
				const start = this.length

				this.emitNode(body, captures)

				const split = this.emit(SPLIT)

				this.split(split, start, this.length, greedy)
				return
			}

			if (nullable(body)) {
				// (body+)?: an iteration that matches nothing ends the loop, as in PCRE2.
				const enter = this.emit(SPLIT)
				const start = this.length

				this.emitNode(body, captures)

				const again = this.emit(SPLIT)

				this.split(again, start, this.length, greedy)
				this.split(enter, start, this.length, greedy)
				return
			}

			const loop = this.emit(SPLIT)

			this.emitNode(body, captures)
			this.emit(JUMP, loop)
			this.split(loop, loop + 1, this.length, greedy)
			return
		}

		for (let index = 0; index < min; index++) this.emitNode(body, captures)

		const splits: number[] = []

		for (let index = min; index < max; index++) {
			splits.push(this.emit(SPLIT))
			this.emitNode(body, captures)
		}

		for (const split of splits) this.split(split, split + 1, this.length, greedy)
	}

	get size(): number {
		return this.length
	}

	// The last position a match may start from in `text`: where the first required run is found, the runs taken from
	// the end in reverse order (each before the next); -1 when they are not all there. Once per text.
	private lastStart(text: string): number {
		if (this.runsText === text) return this.runsFrom

		let limit = text.length

		for (let r = this.runs.length - 1; r >= 0 && limit >= 0; r--) {
			const run = this.runs[r] as ReturnType<typeof requiredRuns>[number]
			const length = run.codes.length
			let found = -1

			for (let at = limit - length; at >= 0 && found < 0; at--) {
				let all = true

				for (let i = 0; i < length && all; i++) {
					const code = text.charCodeAt(at + i)
					const want = run.codes[i] ?? 0

					all = code === want || (run.caseless[i] === true && fold(code) === fold(want))
				}

				if (all) found = at
			}

			limit = found
		}

		this.runsText = text
		this.runsFrom = limit

		return limit
	}

	// Starts a new step budget of `steps`, and the work that comes with it (WORK_PER_STEP).
	resetBudget(steps = STEP_BUDGET): void {
		this.budget = steps
		this.work = Math.min(WORK_BUDGET, steps * (WORK_PER_STEP + this.copyWork))
	}

	// The match's capture slots (UTF-16 offsets, -1 for a group that took no part), or null for none.
	exec(text: string, options: MatchOptions): Int32Array | null {
		return this.run(text, options, false)
	}

	// Whether the pattern matches anywhere in the text.
	test(text: string): boolean {
		return this.run(text, { start: 0 }, true) !== null
	}

	private run(text: string, options: MatchOptions, any: boolean): Int32Array | null {
		const size = this.length
		const end = text.length
		const start = options.start

		if (this.runs.length > 0 && start > this.lastStart(text)) return null

		const previousEnd = options.previousEnd ?? start
		const anchored = options.anchored === true
		const notEmpty = options.notEmptyAtStart === true
		this.lists ??= [
			{ pcs: new Int32Array(size), slots: new Array<Int32Array>(size), count: 0 },
			{ pcs: new Int32Array(size), slots: new Array<Int32Array>(size), count: 0 }
		]

		let [current, next] = this.lists

		current.count = 0
		next.count = 0
		let matched: Int32Array | null = null
		let stamp = this.nextStamp()

		for (let pos = start; pos <= end;) {
			if (matched === null && current.count === 0) {
				if (anchored || this.startAnchored) {
					if (pos !== start || (this.startAnchored && pos !== 0)) break
				} else if (this.prefix !== "") {
					const found = text.indexOf(this.prefix, pos)

					if (found < 0) break

					pos = found
				} else if (this.firstCodes !== null) {
					const codes = this.firstCodes
					const folded = this.firstFolded

					for (; pos < end; pos++) {
						const at = text.charCodeAt(pos)

						if (codes.has(at) || (folded.size > 0 && folded.has(fold(at)))) break
					}

					if (pos >= end) break
				}
			}

			if (matched === null && (pos === start || (!anchored && !this.startAnchored))) {
				const slots = new Int32Array(this.slotCount).fill(-1)

				slots[0] = pos
				this.add(current, 0, slots, text, pos, previousEnd, stamp)
			}

			if (current.count === 0 && (matched !== null || anchored || this.startAnchored)) break

			let code = -1
			let width = 0

			if (pos < end) {
				code = text.charCodeAt(pos)
				width = 1

				if (code >= 0xd800 && code <= 0xdbff && pos + 1 < end) {
					const low = text.charCodeAt(pos + 1)

					if (low >= 0xdc00 && low <= 0xdfff) {
						code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000
						width = 2
					}
				}
			}

			stamp = this.nextStamp()
			this.budget -= current.count

			if (this.budget < 0) throw new RegexBudgetError("search too long")

			for (let index = 0; index < current.count; index++) {
				const pc = current.pcs[index] ?? 0
				const slots = current.slots[index] as Int32Array
				let taken = false

				switch (this.ops[pc]) {
					case MATCH:
						if (notEmpty && slots[0] === start && pos === start) continue
						if (any) return slots

						matched = slots
						// Every thread after this one has lower priority.
						index = current.count
						continue
					case CHAR:
						taken = code === this.args[pc]
						break
					case CHAR_CASELESS:
						taken = code >= 0 && (code === this.args2[pc] || fold(code) === this.args[pc])
						break
					case CLASS:
						taken = code >= 0 && (this.classes[this.args[pc] ?? 0] as CharClass).matches(code)
						break
					case ANY:
						taken = code >= 0
						break
					case ANY_BUT_NEWLINE:
						taken = code >= 0 && code !== NEWLINE
						break
				}

				if (taken) this.add(next, pc + 1, slots, text, pos + width, previousEnd, stamp)
			}

			current.count = 0

			const swap = current

			current = next
			next = swap

			if (pos >= end) break

			pos += width
		}

		return matched
	}

	private nextStamp(): number {
		if (this.stamp >= 0x7fffffff) {
			this.stamp = 0
			this.visited.fill(0)
		}

		return ++this.stamp
	}

	// Adds the thread at `pc` to the list, following jumps, splits, saves and assertions at `pos` in priority order.
	private add(list: ThreadList, pc: number, slots: Int32Array, text: string, pos: number, previousEnd: number, stamp: number): void {
		const pcs = this.stackPcs
		const stackSlots = this.stackSlots

		pcs.push(pc)
		stackSlots.push(slots)

		while (pcs.length > 0) {
			const at = pcs.pop() ?? 0
			const held = stackSlots.pop() as Int32Array

			if (--this.work < 0) {
				// Left empty for the next search, whose budget is reset.
				pcs.length = 0
				stackSlots.length = 0

				throw new RegexBudgetError("search too long")
			}

			if (this.visited[at] === stamp) continue

			this.visited[at] = stamp

			switch (this.ops[at]) {
				case JUMP:
					pcs.push(this.args[at] ?? 0)
					stackSlots.push(held)
					break
				case SPLIT:
					pcs.push(this.args2[at] ?? 0, this.args[at] ?? 0)
					stackSlots.push(held, held)
					break
				case SAVE: {
					const copy = held.slice()

					this.work -= this.copyWork

					copy[this.args[at] ?? 0] = pos
					pcs.push(at + 1)
					stackSlots.push(copy)
					break
				}
				case ASSERT:
					if (this.holds(this.args[at] ?? 0, text, pos, previousEnd)) {
						pcs.push(at + 1)
						stackSlots.push(held)
					}

					break
				default:
					list.pcs[list.count] = at
					list.slots[list.count] = held
					list.count++
			}
		}
	}

	private holds(kind: number, text: string, pos: number, previousEnd: number): boolean {
		const end = text.length

		switch (kind) {
			case 0:
			case 4:
				return pos === 0
			case 1:
				return pos === 0 || (pos < end && text.charCodeAt(pos - 1) === NEWLINE)
			case 2:
				return pos === end || (pos === end - 1 && text.charCodeAt(pos) === NEWLINE)
			case 3:
				return pos === end || text.charCodeAt(pos) === NEWLINE
			case 5:
				return pos === end
			case 6:
				return pos === previousEnd
			default: {
				const before = pos > 0 && isWord(text.charCodeAt(pos - 1))
				const after = pos < end && isWord(text.charCodeAt(pos))

				return (before !== after) === (kind === 7)
			}
		}
	}
}
