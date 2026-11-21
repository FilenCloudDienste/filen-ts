import { MITIGATION_PRESETS } from "./agent"
import { LOOP_PRESETS } from "./loopHarness"
import { EVAL_CASES } from "./cases"
import { INJECTION_CASES } from "./cases/injection"
import { TRANSFORM_CASES, TRANSFORM_CATEGORIES } from "./cases/transform"
import { CATEGORIES, LANGUAGES } from "./cases/types"
import type { EvalPreset } from "./worker"

export type RunValues = {
	suite?: string
	presets?: string
	"main-presets"?: string
	categories?: string
	languages?: string
	cases?: string
	sample?: string
}

export type RunSelection = {
	mainPresets: EvalPreset[]
	injectionPresets: EvalPreset[]
	mainCaseIds: string[]
	injectionCaseIds: string[]
	transformCaseIds: string[]
}

const SUITES = ["main", "injection", "transform", "all"]

const ALL_PRESETS: readonly string[] = [...Object.keys(LOOP_PRESETS), ...Object.keys(MITIGATION_PRESETS)]

// --categories names main-suite and transform-suite categories alike.
const ALL_CATEGORIES: readonly string[] = [...CATEGORIES, ...TRANSFORM_CATEGORIES]

const ALL_CASE_IDS: readonly string[] = [...EVAL_CASES, ...INJECTION_CASES, ...TRANSFORM_CASES].map(item => item.id)

export function list(value: string | undefined): string[] | undefined {
	return value === undefined
		? undefined
		: value
				.split(",")
				.map(item => item.trim())
				.filter(item => item.length > 0)
}

// A given but empty list is an error, not "no filter": it would run nothing, or only the other suite.
function known(names: string[] | undefined, allowed: readonly string[], option: string, label: string): string[] | undefined {
	if (names === undefined) {
		return undefined
	}

	if (names.length === 0) {
		throw new Error(`--${option} names no ${label}; known: ${allowed.join(", ")}`)
	}

	for (const name of names) {
		if (!allowed.includes(name)) {
			throw new Error(`Unknown ${label} "${name}"; known: ${allowed.join(", ")}`)
		}
	}

	return names
}

// The fallback only when the option is absent.
function presets(value: string | undefined, option: string, fallback: EvalPreset[]): EvalPreset[] {
	return (known(list(value), ALL_PRESETS, option, "preset") as EvalPreset[] | undefined) ?? fallback
}

// Every option a run depends on, checked before anything is downloaded or deleted.
export function resolveRun(values: RunValues): RunSelection {
	const suite = values.suite ?? "all"

	if (!SUITES.includes(suite)) {
		throw new Error(`Unknown suite "${suite}"; known: ${SUITES.join(", ")}`)
	}

	const sample = Number(values.sample ?? "1")

	if (!Number.isInteger(sample) || sample < 1) {
		throw new Error(`--sample must be an integer of at least 1, got "${values.sample}"`)
	}

	const languages = known(list(values.languages), LANGUAGES, "languages", "language")
	const categories = known(list(values.categories), ALL_CATEGORIES, "categories", "category")
	// Ids from any suite: --cases may name cases of each.
	const caseIds = known(list(values.cases), ALL_CASE_IDS, "cases", "case")
	const keep = <T extends { id: string; lang: string }>(items: readonly T[], extra: (item: T) => boolean): string[] =>
		items
			.filter(
				item =>
					(languages === undefined || languages.includes(item.lang)) &&
					(caseIds === undefined || caseIds.includes(item.id)) &&
					extra(item)
			)
			.filter((_, index) => index % sample === 0)
			.map(item => item.id)
	const inSuite = (name: string) => suite === "all" || suite === name
	const inCategories = (item: { category: string }) => categories === undefined || categories.includes(item.category)
	const mainCaseIds = inSuite("main") ? keep(EVAL_CASES, inCategories) : []
	const injectionCaseIds = inSuite("injection") ? keep(INJECTION_CASES, () => true) : []
	const transformCaseIds = inSuite("transform") ? keep(TRANSFORM_CASES, inCategories) : []

	if (mainCaseIds.length === 0 && injectionCaseIds.length === 0 && transformCaseIds.length === 0) {
		throw new Error("The selection keeps no case")
	}

	return {
		mainPresets: presets(values["main-presets"], "main-presets", ["shipped"]),
		// The two loops that ship; the legacy presets only when named, as research.
		injectionPresets: presets(values.presets, "presets", ["shipped", "loop"]),
		mainCaseIds,
		injectionCaseIds,
		transformCaseIds
	}
}
