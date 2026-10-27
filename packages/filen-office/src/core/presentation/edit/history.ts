import type { Dirt, Inverse, Touch } from "./apply"
import type { DeckOp } from "./ops"

// The deck's undo history: one timeline of applied steps (`entries[0..cursor)`) and redoable ones
// (`entries[cursor..)`), each with its op as applied, its inverse, and what it touched with a fingerprint of every
// touched thing before and after it. Bounded by bytes and by steps (the oldest step goes first); a typing burst
// coalesces into one step.
//
// Dirtiness is recomputed, never accumulated: the saved state is an anchor in the timeline, and a touched key is
// dirty when its fingerprint now differs from its fingerprint at the anchor, derived from the steps between the two
// (before the first one when the anchor is behind, after the last one when it is ahead). So an op followed by its
// inverse cancels out, and an undo back to the saved state is clean. When steps between the anchor and now leave
// the timeline (trimmed from the bottom, or a redo branch discarded by a new op), their saved fingerprints are kept
// in the anchor's baseline, so a different state at the same position never looks saved. Kept incrementally: each
// step updates only the keys it touched.
//
// The net bytes dirty (the autosave tiers' threshold) are estimated as the ops and inverses of the steps between the
// anchor and now that still leave one of their keys dirty, plus those of the steps that left the timeline into the
// baseline while one of their keys is dirty. Kept as a running total (each step counts its dirty keys), so reading it
// is O(1) and a change costs only the keys that flipped.

// A key's state: a stable digest of the model values it covers; `part` is the part it lives in (a slide's), so a
// removed slide still names its part. `exists` false: the thing is absent.
export interface Fingerprint {
	readonly digest: string
	readonly exists: boolean
	readonly part?: string
	// A sibling order's ids (back to front), so the moved shapes can be told.
	readonly order?: readonly number[]
}

// Keys whose state cannot be read back from the model compare unequal to anything (dirty while in range).
export const UNKNOWN_FINGERPRINT: Fingerprint = { digest: "\u0000unknown", exists: true }

export type TouchKey = string

export interface HistoryStep {
	readonly id: number
	op: DeckOp
	inverse: Inverse
	// What it touched (the page's change events).
	touches: readonly Touch[]
	// Every key it changed, with its fingerprint before and after (the same keys): a touch's key, the keys under a
	// whole node, and the sibling orders it changed.
	readonly before: ReadonlyMap<TouchKey, Fingerprint>
	after: ReadonlyMap<TouchKey, Fingerprint>
	bytes: number
	// A typing burst's identity (family, target, burst id): later transactions of the same burst coalesce.
	readonly burst: string | undefined
	// The history's own: the step as the dirty total counts it.
	counted?: StepCount | undefined
}

export interface HistoryLimits {
	readonly maxBytes: number
	readonly maxSteps: number
}

export const DECK_HISTORY_LIMITS: HistoryLimits = { maxBytes: 64 * 1024 * 1024, maxSteps: 500 }

// The fingerprint of a key in the model now.
export type FingerprintOf = (key: TouchKey) => Fingerprint

// A position in the timeline (after `pos` steps of `entries`) and the saved fingerprints of keys whose steps left it.
interface Anchor {
	pos: number
	readonly baseline: Map<TouchKey, Fingerprint>
	// The steps whose fingerprints went into the baseline, counted as one: their bytes and their keys.
	readonly lost: Counted
}

// A save in flight: the state it serializes, made the saved state when the save commits.
export interface SavePoint {
	readonly revision: number
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
	return a !== UNKNOWN_FINGERPRINT && b !== UNKNOWN_FINGERPRINT && a.exists === b.exists && a.digest === b.digest
}

let nextId = 1

// A step's bytes as the dirty total counts them, its keys, and how many of them are dirty now.
export interface StepCount extends Counted {
	// Counted in the total now (the step is in the saved anchor's range).
	live: boolean
}

interface Counted {
	bytes: number
	readonly keys: { keys(): Iterable<TouchKey> }
	dirty: number
}

function noneLost(): Counted {
	return { bytes: 0, keys: new Set<TouchKey>(), dirty: 0 }
}

function stepCount(step: HistoryStep): StepCount {
	return { bytes: opBytesOf(step.op) + step.inverse.bytes, keys: step.before, dirty: 0, live: false }
}

export class DeckHistory {
	readonly limits: HistoryLimits
	// Bumps on every applied step, undo and redo (the page's change events).
	revision = 0
	private readonly entries: HistoryStep[] = []
	private cursor = 0
	private bytes = 0
	private saved: Anchor = { pos: 0, baseline: new Map(), lost: noneLost() }
	// Whether the saved anchor is a step of the timeline (false once its branch was discarded or trimmed away).
	private savedReachable = true
	private readonly pending = new Map<SavePoint, Anchor>()
	// The saved anchor's derived fingerprints and how many steps in range touch each key.
	private readonly savedValue = new Map<TouchKey, Fingerprint>()
	private readonly inRange = new Map<TouchKey, number>()
	private readonly dirtyKeys = new Set<TouchKey>()
	// The counted steps of the saved anchor's range and baseline by key, the range's by step, and their dirty total.
	private readonly countedByKey = new Map<TouchKey, Set<Counted>>()
	private dirtyTotal = 0
	private readonly fingerprint: FingerprintOf

	constructor(fingerprint: FingerprintOf, limits: HistoryLimits = DECK_HISTORY_LIMITS) {
		this.fingerprint = fingerprint
		this.limits = limits
	}

	get canUndo(): boolean {
		return this.cursor > 0
	}

	get canRedo(): boolean {
		return this.cursor < this.entries.length
	}

	get dirty(): boolean {
		return this.dirtyKeys.size > 0
	}

	// Steps held and their bytes (accounting, tests).
	get size(): { readonly steps: number; readonly bytes: number } {
		return { steps: this.entries.length, bytes: this.bytes }
	}

	// The id of the current state's step (0 before any), and whether it is the saved state.
	get current(): number {
		return this.entries[this.cursor - 1]?.id ?? 0
	}

	get atSaved(): boolean {
		return this.savedReachable && this.saved.pos === this.cursor && this.saved.baseline.size === 0
	}

	// The net bytes dirty against the saved state, estimated (0 when clean).
	get dirtyBytes(): number {
		return this.dirtyKeys.size === 0 ? 0 : this.dirtyTotal
	}

	// The keys dirty against the saved state.
	dirtyTouchKeys(): ReadonlySet<TouchKey> {
		return this.dirtyKeys
	}

	// The fingerprint a dirty key had in the saved state.
	savedFingerprint(key: TouchKey): Fingerprint | undefined {
		return this.saved.baseline.get(key) ?? this.savedValue.get(key)
	}

	// A step applied now. `burst` steps of one burst coalesce into the step on top while it is not the saved state.
	push(step: Omit<HistoryStep, "id">): HistoryStep {
		this.discardRedo()

		const top = this.entries[this.cursor - 1]

		if (step.burst !== undefined && top?.burst === step.burst && this.saved.pos !== this.cursor && !this.pendingAt(this.cursor)) {
			return this.coalesce(top, step)
		}

		const entry: HistoryStep = { ...step, id: nextId++, counted: undefined }

		this.entries.push(entry)
		this.cursor++
		this.bytes += entry.bytes
		this.revision++
		this.enter(entry)
		this.refreshKeys(entry.before.keys())
		this.trim()

		return entry
	}

	// The step to undo (its inverse is applied by the caller, then undone() records it).
	peekUndo(): HistoryStep | undefined {
		return this.entries[this.cursor - 1]
	}

	peekRedo(): HistoryStep | undefined {
		return this.entries[this.cursor]
	}

	undone(): void {
		const entry = this.entries[this.cursor - 1]

		if (entry === undefined) return

		this.cursor--
		this.revision++

		if (this.saved.pos <= this.cursor) this.leave(entry)
		else this.enter(entry)

		this.refreshKeys(entry.before.keys())
	}

	redone(): void {
		const entry = this.entries[this.cursor]

		if (entry === undefined) return

		this.cursor++
		this.revision++

		if (this.saved.pos >= this.cursor) this.leave(entry)
		else this.enter(entry)

		this.refreshKeys(entry.before.keys())
	}

	// A redone step's inverse, made again as it applied (its bytes read from the base source as it is now).
	replaceInverse(step: HistoryStep, inverse: Inverse): void {
		const bytes = step.bytes - step.inverse.bytes + inverse.bytes

		this.bytes += bytes - step.bytes
		step.inverse = inverse
		step.bytes = bytes
		this.trim()
	}

	// A save of the current state starts: the point to commit when it lands.
	savePoint(): SavePoint {
		const point: SavePoint = { revision: this.revision }

		this.pending.set(point, { pos: this.cursor, baseline: new Map(), lost: noneLost() })

		return point
	}

	// A save landed: its state is the saved one.
	commit(point: SavePoint): void {
		const anchor = this.pending.get(point)

		if (anchor === undefined) return

		this.pending.delete(point)
		this.saved = anchor
		this.savedReachable = anchor.baseline.size === 0
		this.rebuild()
	}

	// A save that failed or was abandoned.
	abandon(point: SavePoint): void {
		this.pending.delete(point)
	}

	// Everything forgotten (a deck reopened from scratch): the current state is saved.
	clear(): void {
		this.entries.length = 0
		this.cursor = 0
		this.bytes = 0
		this.pending.clear()
		this.saved = { pos: 0, baseline: new Map(), lost: noneLost() }
		this.savedReachable = true
		this.rebuild()
	}

	private pendingAt(pos: number): boolean {
		for (const anchor of this.pending.values()) if (anchor.pos === pos) return true

		return false
	}

	private coalesce(top: HistoryStep, step: Omit<HistoryStep, "id">): HistoryStep {
		const touches = [...top.touches]
		const before = new Map(top.before)
		const named = new Set(top.touches.map(touchKey))

		for (const touch of step.touches) {
			if (named.has(touchKey(touch))) continue

			named.add(touchKey(touch))
			touches.push(touch)
		}

		for (const [key, value] of step.before) if (!before.has(key)) before.set(key, value)

		const after = new Map(top.after)

		for (const [key, value] of step.after) after.set(key, value)

		const merged: HistoryStep = {
			id: nextId++,
			op: step.op,
			inverse: top.inverse,
			touches,
			before,
			after,
			bytes: top.bytes - opBytesOf(top.op) + opBytesOf(step.op),
			burst: top.burst,
			counted: undefined
		}

		this.leave(top)
		this.entries[this.cursor - 1] = merged
		this.bytes += merged.bytes - top.bytes
		this.revision++
		this.enter(merged)
		this.refreshKeys(merged.before.keys())
		this.trim()

		return merged
	}

	// The redo branch, dropped when a new step is applied; anchors on it keep their fingerprints in their baselines.
	private discardRedo(): void {
		if (this.cursor === this.entries.length) return

		this.dropFrom(this.cursor)
	}

	private dropFrom(from: number): void {
		const anchors: Anchor[] = [this.saved, ...this.pending.values()]

		for (const anchor of anchors) {
			if (anchor.pos <= from) continue

			// The saved state was on the dropped steps: their after-state is what it held.
			for (let index = anchor.pos - 1; index >= from; index--) {
				const entry = this.entries[index] as HistoryStep

				for (const [key, value] of entry.after) if (!anchor.baseline.has(key)) anchor.baseline.set(key, value)

				this.lose(anchor, entry)
			}

			anchor.pos = from

			if (anchor === this.saved) this.savedReachable = false
		}

		for (let index = from; index < this.entries.length; index++) this.bytes -= (this.entries[index] as HistoryStep).bytes

		this.entries.length = from

		if (this.cursor > from) this.cursor = from

		this.rebuild()
	}

	private trim(): void {
		while (this.entries.length > 0 && (this.entries.length > this.limits.maxSteps || this.bytes > this.limits.maxBytes)) {
			if (this.cursor === 0) {
				this.dropFrom(this.entries.length - 1)

				continue
			}

			const oldest = this.entries.shift() as HistoryStep

			this.bytes -= oldest.bytes
			this.cursor--

			for (const anchor of [this.saved, ...this.pending.values()]) {
				if (anchor.pos > 0) {
					anchor.pos--

					continue
				}

				// The anchor is at the bottom: the step leaves its range, its before-state is what the anchor held.
				for (const [key, value] of oldest.before) if (!anchor.baseline.has(key)) anchor.baseline.set(key, value)

				this.lose(anchor, oldest)

				if (anchor === this.saved) {
					this.savedReachable = false
					this.leave(oldest)
					this.refreshKeys(oldest.before.keys())
				}
			}
		}
	}

	// A step entering the saved anchor's range (at its end when the anchor is behind, at its front when ahead). The
	// saved value of a key is the before-state of the first step touching it when behind, the after-state of the last
	// one when ahead: a key new to the range takes it from this step; one already in range keeps its own.
	private enter(entry: HistoryStep): void {
		const behind = this.saved.pos <= this.cursor

		this.countStep(entry)

		for (const key of entry.before.keys()) {
			const count = this.inRange.get(key) ?? 0

			this.inRange.set(key, count + 1)

			if (count > 0) continue

			const value = behind ? entry.before.get(key) : entry.after.get(key)

			if (value !== undefined) this.savedValue.set(key, value)
		}
	}

	// A step leaving the range at the side away from the anchor's derivation: the keys it alone touched leave.
	private leave(entry: HistoryStep): void {
		const counted = entry.counted

		if (counted?.live === true) {
			counted.live = false
			this.uncount(counted)
		}

		for (const key of entry.before.keys()) {
			const count = (this.inRange.get(key) ?? 1) - 1

			if (count <= 0) {
				this.inRange.delete(key)
				this.savedValue.delete(key)
			} else {
				this.inRange.set(key, count)
			}
		}
	}

	// The saved anchor's derived state from a scan of its range (after it moved or steps left).
	private rebuild(): void {
		this.inRange.clear()
		this.savedValue.clear()
		for (const entry of this.entries) if (entry.counted !== undefined) entry.counted.live = false

		this.countedByKey.clear()
		this.dirtyKeys.clear()
		this.dirtyTotal = 0

		this.count(this.saved.lost)

		const { pos } = this.saved

		if (pos <= this.cursor) {
			for (let index = pos; index < this.cursor; index++) {
				const entry = this.entries[index] as HistoryStep

				this.countStep(entry)

				for (const key of entry.before.keys()) {
					this.inRange.set(key, (this.inRange.get(key) ?? 0) + 1)

					const value = entry.before.get(key)

					if (!this.savedValue.has(key) && value !== undefined) this.savedValue.set(key, value)
				}
			}
		} else {
			for (let index = pos - 1; index >= this.cursor; index--) {
				const entry = this.entries[index] as HistoryStep

				this.countStep(entry)

				for (const key of entry.before.keys()) {
					this.inRange.set(key, (this.inRange.get(key) ?? 0) + 1)

					const value = entry.after.get(key)

					if (!this.savedValue.has(key) && value !== undefined) this.savedValue.set(key, value)
				}
			}
		}

		const keys = new Set<TouchKey>([...this.inRange.keys(), ...this.saved.baseline.keys()])

		this.refreshKeys(keys)
	}

	private refreshKeys(keys: Iterable<TouchKey>): void {
		for (const key of keys) {
			const saved = this.saved.baseline.get(key) ?? this.savedValue.get(key)
			const dirty = saved === undefined ? this.inRange.has(key) : !sameFingerprint(saved, this.fingerprint(key))

			if (dirty === this.dirtyKeys.has(key)) continue

			if (dirty) this.dirtyKeys.add(key)
			else this.dirtyKeys.delete(key)

			for (const counted of this.countedByKey.get(key) ?? []) {
				if (dirty) {
					if (counted.dirty++ === 0) this.dirtyTotal += counted.bytes
				} else if (--counted.dirty === 0) {
					this.dirtyTotal -= counted.bytes
				}
			}
		}
	}

	// A step entering the saved anchor's range is counted (anew: a step re-entering is counted as it is now).
	private countStep(entry: HistoryStep): void {
		const counted = (entry.counted ??= stepCount(entry))

		if (counted.live) this.uncount(counted)

		counted.live = true
		this.count(counted)
	}

	// A step leaves the timeline into an anchor's baseline: its bytes and keys join the anchor's lost count.
	private lose(anchor: Anchor, entry: HistoryStep): void {
		const lost = anchor.lost
		const keys = lost.keys as Set<TouchKey>
		const counted = anchor === this.saved
		const bytes = (entry.counted ??= stepCount(entry)).bytes

		if (counted && lost.dirty > 0) this.dirtyTotal += bytes

		lost.bytes += bytes

		for (const key of entry.before.keys()) {
			if (keys.has(key)) continue

			keys.add(key)

			if (!counted) continue

			this.indexed(key).add(lost)

			if (this.dirtyKeys.has(key) && lost.dirty++ === 0) this.dirtyTotal += lost.bytes
		}
	}

	private indexed(key: TouchKey): Set<Counted> {
		let set = this.countedByKey.get(key)

		if (set === undefined) {
			set = new Set()
			this.countedByKey.set(key, set)
		}

		return set
	}

	private count(counted: Counted): void {
		counted.dirty = 0

		for (const key of counted.keys.keys()) {
			this.indexed(key).add(counted)

			if (this.dirtyKeys.has(key)) counted.dirty++
		}

		if (counted.dirty > 0) this.dirtyTotal += counted.bytes
	}

	private uncount(counted: Counted): void {
		if (counted.dirty > 0) this.dirtyTotal -= counted.bytes

		for (const key of counted.keys.keys()) {
			const set = this.countedByKey.get(key)

			set?.delete(counted)

			if (set?.size === 0) this.countedByKey.delete(key)
		}
	}
}

// The key of what a touch names (a shape's xfrm, one of its property groups, its text, its whole node; a slide's
// part or node; a presentation-level list; a package part).
export function touchKey(touch: Touch): TouchKey {
	switch (touch.kind) {
		case "shape":
			return `s:${String(touch.slide)}:${String(touch.shape)}:${dirtKey(touch.dirt)}`
		case "slide":
			return `n:${String(touch.slide)}:${dirtKey(touch.dirt)}`
		case "presentation":
			return `d:${touch.what}`
		case "part":
			return `p:${touch.change}:${touch.part}`
	}
}

function dirtKey(dirt: Dirt): string {
	switch (dirt.kind) {
		case "xfrm":
			return "x"
		case "props":
			return `p.${dirt.group}`
		case "text":
			return "t"
		case "slidePart":
			return `sp.${dirt.part}`
		case "node":
			return "n"
	}
}

// An estimate of the bytes an op holds (its typed values and raw bytes), for the history's accounting.
export function opBytesOf(op: DeckOp): number {
	return valueBytes(op, 0)
}

function valueBytes(value: unknown, depth: number): number {
	if (value === null || value === undefined) return 0
	if (typeof value === "string") return 16 + value.length * 2
	if (typeof value !== "object") return 8
	if (ArrayBuffer.isView(value)) return 32 + value.byteLength
	if (depth > 64) return 0

	let total = 16

	if (Array.isArray(value)) {
		for (const item of value) total += 8 + valueBytes(item, depth + 1)

		return total
	}

	for (const key in value) total += 16 + valueBytes((value as Record<string, unknown>)[key], depth + 1)

	return total
}
