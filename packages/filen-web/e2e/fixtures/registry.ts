import { CORE_SCENARIOS } from "./core"
import { IMAGE_SCENARIOS } from "./images"
import { ROUTING_SCENARIOS } from "./routing"
import { IWORK_SCENARIOS } from "./iwork"
import { RICH_SCENARIOS } from "./rich"
import { TEXT_SCENARIOS } from "./text"
import { W5_SCENARIOS } from "./w5"
import { RAR_SCENARIOS } from "./rar"
import { COMIC_SCENARIOS } from "./comics"
import { SLIDESHOW_SCENARIOS } from "./previewSlideshow"
import type { FixturePayload, ScenarioFiles, ScenarioModule } from "./scenarios"

// Every scenario module, once. Its scenarios join the shared tree in this order; a workstream adds its module here.
const SCENARIO_MODULES = [
	CORE_SCENARIOS,
	ROUTING_SCENARIOS,
	IWORK_SCENARIOS,
	RICH_SCENARIOS,
	TEXT_SCENARIOS,
	IMAGE_SCENARIOS,
	W5_SCENARIOS,
	RAR_SCENARIOS,
	COMIC_SCENARIOS,
	SLIDESHOW_SCENARIOS
] as const

type FilesOf<M> = M extends ScenarioModule<infer F> ? F : never

type MergedFiles<M extends readonly unknown[]> = M extends readonly [infer Head, ...infer Rest]
	? FilesOf<Head> & MergedFiles<Rest>
	: unknown

// The modules' scenarios as one object, refusing a scenario key or a file name used twice.
function mergeScenarioFiles<const M extends readonly ScenarioModule<ScenarioFiles>[]>(modules: M): MergedFiles<M> {
	const merged: Record<string, readonly string[]> = {}
	const names = new Set<string>()

	for (const { files } of modules) {
		for (const [scenario, scenarioNames] of Object.entries(files)) {
			if (scenario in merged) {
				throw new Error(`fixture scenario "${scenario}" is registered twice`)
			}

			for (const name of scenarioNames) {
				if (names.has(name)) {
					throw new Error(`fixture file "${name}" is registered twice`)
				}

				names.add(name)
			}

			merged[scenario] = scenarioNames
		}
	}

	return merged as MergedFiles<M>
}

// Every scenario of the tree, by key: the setup uploads exactly these files, the specs locate exactly these rows.
export const FIXTURE_FILES = mergeScenarioFiles(SCENARIO_MODULES)

export type FixtureScenario = keyof typeof FIXTURE_FILES
export type FixtureFileName = (typeof FIXTURE_FILES)[FixtureScenario][number]

// The scenarios the tree holds, in FIXTURE_FILES order.
export const FIXTURE_SCENARIOS: readonly FixtureScenario[] = Object.keys(FIXTURE_FILES) as FixtureScenario[]

// Every file's payload, built now: the setup's alone.
export function fixturePayloads(): Readonly<Record<FixtureFileName, FixturePayload>> {
	return Object.assign({}, ...SCENARIO_MODULES.map(({ payloads }) => payloads())) as Record<FixtureFileName, FixturePayload>
}
