// List counter semantics informed by SuperDoc 1.46.3 (packages/word-layout/src/numbering-manager.ts), copyright
// Harbour and the SuperDoc contributors, licensed under the GNU Affero General Public License v3.0. Rewritten
// for @filen/office as a single forward pass.

import { formatNumber } from "./formats"
import { MAX_LEVEL, type Numbering, type NumberingLevel, type PictureBullet } from "./numbering"

const LEVELS = MAX_LEVEL + 1

export interface ListMarker {
	readonly numId: number
	readonly ilvl: number
	readonly level: NumberingLevel
	// The counter value at this level.
	readonly value: number
	// The marker text from w:lvlText (empty when the level has none).
	readonly text: string
	readonly bullet: boolean
	readonly suffix: "tab" | "space" | "nothing"
	readonly alignment: string
	readonly pictureBullet: PictureBullet | undefined
}

// One counter set per abstract definition: every w:num referencing it continues the same sequence.
interface CounterSet {
	// Float64: incrementing past int32 must not wrap.
	readonly values: Float64Array
	// Whether each level has counted since it last (re)started.
	readonly active: Uint8Array
}

export interface CounterSnapshot {
	readonly sets: ReadonlyMap<number, CounterSet>
	readonly overridesApplied: ReadonlyMap<number, number>
}

// Counts list items in document order. Call `next` once for every numbered paragraph of a story, in
// order; use one instance per story that numbers on its own (the body, each text box...).
export class NumberingCounters {
	private numbering: Numbering
	private readonly sets = new Map<number, CounterSet>()
	// Per numId, a bit per level whose w:startOverride has been applied.
	private readonly overridesApplied = new Map<number, number>()

	constructor(numbering: Numbering) {
		this.numbering = numbering
	}

	// Counts with other definitions from now on (the counts so far stay).
	use(numbering: Numbering): void {
		this.numbering = numbering
	}

	reset(): void {
		this.sets.clear()
		this.overridesApplied.clear()
	}

	// The counting state, to continue from later (layout restarting at a page).
	snapshot(): CounterSnapshot {
		const sets = new Map<number, CounterSet>()

		for (const [id, set] of this.sets) sets.set(id, { values: set.values.slice(), active: set.active.slice() })

		return { sets, overridesApplied: new Map(this.overridesApplied) }
	}

	restore(snapshot: CounterSnapshot): void {
		this.sets.clear()

		for (const [id, set] of snapshot.sets) this.sets.set(id, { values: set.values.slice(), active: set.active.slice() })

		this.overridesApplied.clear()

		for (const [id, applied] of snapshot.overridesApplied) this.overridesApplied.set(id, applied)
	}

	// `language`: the marker run's (the paragraph mark's resolved w:lang under the level's w:rPr, StyleResolver.listMarker),
	// which ordinal and number-word formats follow ("the run language", ST_NumberFormat); the level's own w:lang without.
	next(numId: number, ilvl: number, language?: string): ListMarker | undefined {
		const effective = this.numbering.level(numId, ilvl)

		if (effective === undefined) return undefined

		const level = effective.ilvl
		let set = this.sets.get(effective.abstractId)

		if (set === undefined) {
			set = { values: new Float64Array(LEVELS), active: new Uint8Array(LEVELS) }
			this.sets.set(effective.abstractId, set)
		}

		// A w:num's start override restarts its level the first time that num reaches the level.
		if (effective.startOverridden) {
			const applied = this.overridesApplied.get(numId) ?? 0

			if ((applied & (1 << level)) === 0) {
				this.overridesApplied.set(numId, applied | (1 << level))
				set.active[level] = 0
			}
		}

		const value = set.active[level] === 1 ? (set.values[level] ?? 0) + 1 : effective.start

		set.values[level] = value
		set.active[level] = 1

		for (let deeper = level + 1; deeper < LEVELS; deeper++) {
			if (set.active[deeper] === 0) continue

			const restart = this.numbering.level(numId, deeper)?.level.restart

			// lvlRestart n restarts after levels 1..n (1-based) are used; 0 never restarts; a value that does
			// not name a higher level is ignored (§17.9.10).
			if (restart === undefined || restart >= deeper + 1 || (restart !== 0 && level <= restart - 1)) set.active[deeper] = 0
		}

		const definition = effective.level
		const bullet = definition.format === "bullet"

		return {
			numId,
			ilvl: level,
			level: definition,
			value,
			text: bullet ? (definition.text ?? "") : this.text(numId, level, value, set, definition, language),
			bullet,
			suffix: definition.suffix,
			alignment: definition.alignment,
			pictureBullet:
				definition.pictureBulletId === undefined ? undefined : this.numbering.pictureBullets.get(definition.pictureBulletId)
		}
	}

	// Expands %1..%9 in the level text: higher levels show their current value (their start when unused),
	// deeper levels show nothing. A legal (isLgl) level shows every number in decimal.
	private text(
		numId: number,
		level: number,
		value: number,
		set: CounterSet,
		definition: NumberingLevel,
		marker: string | undefined
	): string {
		const template = definition.text

		if (template === undefined || template.length === 0) return ""

		// The marker run's language, else the level's own (w:lang); English without one.
		const language = marker ?? definition.run.lang?.latin
		let out = ""
		let from = 0

		for (let at = template.indexOf("%"); at >= 0; at = template.indexOf("%", at + 1)) {
			const digit = template.charCodeAt(at + 1) - 48

			if (digit < 1 || digit > LEVELS) continue

			out += template.slice(from, at)
			from = at + 2

			const target = digit - 1

			if (target > level) continue

			let number = value
			let format = definition.format
			let customFormat = definition.customFormat

			if (target < level) {
				const ancestor = this.numbering.level(numId, target)

				number = set.active[target] === 1 ? (set.values[target] ?? 0) : (ancestor?.start ?? 0)
				format = ancestor?.level.format ?? "decimal"
				customFormat = ancestor?.level.customFormat
			}

			if (definition.legal && format !== "none" && format !== "bullet") format = "decimal"

			out += formatNumber(number, format, customFormat, language)
			at = from - 1
		}

		return out + template.slice(from)
	}
}
