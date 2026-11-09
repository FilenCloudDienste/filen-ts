import { CellError, FunctionArgumentType, SimpleRangeValue, type ImplementedFunctions } from "hyperformula"
import { Regex, RegexSyntaxError, RegexUnsupportedError, STEP_BUDGET } from "../regex/index"
import { MAX_TEXT, naError, SheetFunctionPlugin, unmodeledError, valueError, type PluginCall, type PluginState } from "./plugin"

// REGEXTEST, REGEXEXTRACT and REGEXREPLACE as support.microsoft.com defines them, over PCRE2 patterns run by the
// app's own linear-time engine (formula/regex). A pattern PCRE2 rejects is #VALUE!; one the engine does not run
// (backreferences, lookaround and the like) keeps the file's result.

const CASE = { argumentType: FunctionArgumentType.INTEGER, defaultValue: 0, emptyAsDefault: true } as const
const TEXT = { argumentType: FunctionArgumentType.STRING } as const

// The thread steps one call may take (formula/regex). One search visits each character at most once per instruction of
// the program (the engine is linear), so a call over a text, work the user's own text and pattern set, is given room for
// eight such scans: finding every match rescans what higher-priority threads read past one. What runs out of it is a
// search that rescans more than that. At least MIN_STEPS, at most STEP_BUDGET (a pattern of some sixty instructions over
// a cell's longest text). Each call has its own: its result is the same whatever else calculates with it.
const MIN_STEPS = 4_096
const STEPS_PER_INSTRUCTION = 8

function callSteps(regex: Regex, text: string): number {
	return Math.min(STEP_BUDGET, Math.max(MIN_STEPS, text.length * regex.size * STEPS_PER_INSTRUCTION))
}

// Compiled patterns by flags and text: a column of formulas usually shares one pattern.
const CACHE_SIZE = 64
const cache = new Map<string, Regex | CellError>()

// The pattern compiled (from the cache when it was before), its step budget set for a call over `text`.
function compiled(pattern: string, caseSensitivity: number, captures: boolean, text: string): Regex | CellError {
	if (caseSensitivity !== 0 && caseSensitivity !== 1) return valueError()

	const key = `${String(caseSensitivity)}${captures ? "c" : "-"}${pattern}`
	const known = cache.get(key)

	if (known !== undefined) {
		cache.delete(key)
		cache.set(key, known)

		if (known instanceof Regex) known.resetBudget(callSteps(known, text))

		return known
	}

	let regex: Regex | CellError

	try {
		regex = Regex.compile(pattern, { caseless: caseSensitivity === 1, captures })
	} catch (error) {
		regex = failure(error)
	}

	if (cache.size >= CACHE_SIZE) {
		const oldest = cache.keys().next()

		if (oldest.done !== true) cache.delete(oldest.value)
	}

	if (regex instanceof Regex) regex.resetBudget(callSteps(regex, text))

	cache.set(key, regex)

	return regex
}

function failure(error: unknown): CellError {
	if (error instanceof RegexSyntaxError) return valueError()
	if (error instanceof RegexUnsupportedError) return unmodeledError()

	throw error
}

// A search, its budget running out (or a construct only met while matching) giving the error the formula keeps
// the file's result for.
function searched<T>(work: () => T): T | CellError {
	try {
		return work()
	} catch (error) {
		return failure(error)
	}
}

type ReplacementPart = string | number

// PCRE2's replacement text (pcre2_substitute without extended syntax): $$ a dollar sign, $n and ${n} group n, $name
// and ${name} a named group. Anything else after $ is an error.
function replacementParts(replacement: string, regex: Regex): ReplacementPart[] | CellError {
	const parts: ReplacementPart[] = []
	let literal = ""
	let index = 0

	while (index < replacement.length) {
		const dollar = replacement.indexOf("$", index)

		if (dollar < 0) {
			literal += replacement.slice(index)
			break
		}

		literal += replacement.slice(index, dollar)
		index = dollar + 1

		if (replacement[index] === "$") {
			literal += "$"
			index++
			continue
		}

		const braced = replacement[index] === "{"

		if (braced) index++
		if (braced && replacement[index] === "*") return unmodeledError()

		const reference = /^(?:\d+|[A-Za-z_][A-Za-z0-9_]*)/.exec(replacement.slice(index, index + 140))?.[0]

		if (reference === undefined) return valueError()

		index += reference.length

		if (braced && replacement[index++] !== "}") return valueError()

		let group: number

		if (/^\d/.test(reference)) group = Number(reference)
		else {
			if (regex.parsed.duplicateNames.has(reference)) return unmodeledError()

			group = regex.parsed.names.get(reference) ?? -1
		}

		if (group < 0 || group > regex.groups) return valueError()
		if (literal !== "") parts.push(literal)

		literal = ""
		parts.push(group)
	}

	if (literal !== "") parts.push(literal)

	return parts
}

// The replacement for one match; null where it names a group that took no part (PCRE2 leaves that to an option
// Excel's setting of is unknown).
function replaced(text: string, slots: Int32Array, parts: readonly ReplacementPart[]): string | null {
	let out = ""

	for (const part of parts) {
		if (typeof part === "string") {
			out += part
			continue
		}

		const start = slots[part * 2] ?? -1
		const end = slots[part * 2 + 1] ?? -1

		if (start < 0 || end < 0) return null

		out += text.slice(start, end)
	}

	return out
}

export class RegexFunctions extends SheetFunctionPlugin {
	static override implementedFunctions: ImplementedFunctions = {
		REGEXTEST: { method: "regextest", parameters: [TEXT, TEXT, CASE] },
		REGEXEXTRACT: {
			method: "regexextract",
			parameters: [TEXT, TEXT, { argumentType: FunctionArgumentType.INTEGER, defaultValue: 0, emptyAsDefault: true }, CASE]
		},
		REGEXREPLACE: {
			method: "regexreplace",
			parameters: [TEXT, TEXT, TEXT, { argumentType: FunctionArgumentType.INTEGER, defaultValue: 0, emptyAsDefault: true }, CASE]
		}
	}

	// REGEXTEST(text, pattern, [case_sensitivity]): whether any part of the text matches.
	regextest(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(ast.args, state, this.metadata("REGEXTEST"), (text: string, pattern: string, caseSensitivity: number) => {
			if (text.length > MAX_TEXT) return valueError()

			const regex = compiled(pattern, caseSensitivity, false, text)

			return regex instanceof CellError ? regex : searched(() => regex.test(text))
		})
	}

	// REGEXEXTRACT(text, pattern, [return_mode], [case_sensitivity]): the first match (0), every match down a column
	// (1), or the first match's capturing groups across a row (2); #N/A when nothing matches.
	regexextract(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("REGEXEXTRACT"),
			(text: string, pattern: string, mode: number, caseSensitivity: number) => {
				if (text.length > MAX_TEXT || (mode !== 0 && mode !== 1 && mode !== 2)) return valueError()

				const regex = compiled(pattern, caseSensitivity, mode === 2, text)

				if (regex instanceof CellError) return regex

				return searched(() => {
					if (mode === 1) {
						const found: string[][] = []

						for (const slots of regex.matches(text)) found.push([text.slice(slots[0], slots[1])])

						return found.length === 0 ? naError() : SimpleRangeValue.onlyValues(found)
					}

					const slots = regex.exec(text)

					if (slots === null) return naError()
					if (mode === 0) return text.slice(slots[0], slots[1])
					// A pattern without groups, or a group that took no part: what Excel gives is not documented.
					if (regex.groups === 0) return unmodeledError()

					const groups: string[] = []

					for (let group = 1; group <= regex.groups; group++) {
						const start = slots[group * 2] ?? -1
						const end = slots[group * 2 + 1] ?? -1

						if (start < 0 || end < 0) return unmodeledError()

						groups.push(text.slice(start, end))
					}

					return SimpleRangeValue.onlyValues([groups])
				})
			}
		)
	}

	// REGEXREPLACE(text, pattern, replacement, [occurrence], [case_sensitivity]): the text with every match (0), or
	// the occurrence-th (from the end when negative), replaced; $n names a capturing group.
	regexreplace(ast: PluginCall, state: PluginState): unknown {
		return this.runFunction(
			ast.args,
			state,
			this.metadata("REGEXREPLACE"),
			(text: string, pattern: string, replacement: string, occurrence: number, caseSensitivity: number) => {
				if (text.length > MAX_TEXT) return valueError()

				const probe = compiled(pattern, caseSensitivity, false, text)

				if (probe instanceof CellError) return probe

				const parts = replacementParts(replacement, probe)

				if (parts instanceof CellError) return parts

				const regex = parts.some(part => typeof part === "number" && part > 0)
					? compiled(pattern, caseSensitivity, true, text)
					: probe

				if (regex instanceof CellError) return regex

				return searched(() => {
					const all = [...regex.matches(text)]
					const chosen = occurrence === 0 ? all : [all[occurrence > 0 ? occurrence - 1 : all.length + occurrence]]
					let out = ""
					let at = 0

					for (const slots of chosen) {
						if (slots === undefined) return text

						const piece = replaced(text, slots, parts)

						if (piece === null) return unmodeledError()

						out += text.slice(at, slots[0]) + piece
						at = slots[1] ?? at

						if (out.length > MAX_TEXT) return valueError()
					}

					out += text.slice(at)

					return out.length > MAX_TEXT ? valueError() : out
				})
			}
		)
	}
}
