import { HyperFormula } from "hyperformula"

// The engine's exact search (VLOOKUP, HLOOKUP, MATCH and XLOOKUP without wildcards) folds accents whatever its
// configuration says ("résumé" finds "resume"), where Excel compares text without case only, and builds an
// accent-stripped copy of every value searched at each call. Here text compares by its lower case alone, value by
// value, without the copy. The key as given is kept for the search (the engine hands on only its folded form).

type Search = (this: unknown, key: unknown, range: unknown, coordinate: unknown, options: unknown) => number
type Find = (this: unknown, key: unknown, values: readonly unknown[], ifNoMatch?: string, occurrence?: string) => number

interface SearchPrototype {
	basicFind: Search
	findNormalizedValue: Find
}

// The key of the exact search running now, as its caller gave it.
let searched: { readonly key: unknown } | null = null

function raw(value: unknown): unknown {
	return typeof value === "object" && value !== null && "val" in value ? (value as { readonly val: unknown }).val : value
}

let installed = false

// Wraps the engine's search once, over what wholeRanges.ts installed before it.
export function installExactSearch(licenseKey: string): void {
	if (installed) return

	installed = true

	const probe = HyperFormula.buildEmpty({ licenseKey })

	try {
		const prototype = Object.getPrototypeOf(Object.getPrototypeOf(probe.columnSearch)) as SearchPrototype
		const basic = prototype.basicFind
		const normalized = prototype.findNormalizedValue

		prototype.basicFind = function (key, range, coordinate, options) {
			const outer = searched

			searched = { key }

			try {
				return basic.call(this, key, range, coordinate, options)
			} finally {
				searched = outer
			}
		}

		prototype.findNormalizedValue = function (key, values, ifNoMatch = "returnNotFound", occurrence = "first") {
			const given = searched === null ? undefined : raw(searched.key)

			if (ifNoMatch !== "returnNotFound" || given === undefined || (typeof given === "string" && typeof key !== "string"))
				return normalized.call(this, key, values, ifNoMatch, occurrence)

			const text = typeof given === "string" ? given.toLowerCase() : null
			const last = occurrence !== "first"
			const count = values.length

			for (let step = 0; step < count; step++) {
				const index = last ? count - 1 - step : step
				const value = raw(values[index])

				if (text === null ? value === given : typeof value === "string" && value.toLowerCase() === text) return index
			}

			return -1
		}
	} finally {
		probe.destroy()
	}
}
