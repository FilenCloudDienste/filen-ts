import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { createFixtureState, type AppContext, type AppState } from "./fixture"
import { EVAL_DATE_LINE } from "./prompts"

const SHARED_ASSISTANT = new URL("../../filen-shared/src/assistant/", import.meta.url)

// Shared helpers the fake app renders tool results with (formatBytes, storageSummary): they run at tool-call
// time, so the built state below does not cover them.
const SHARED_HELPERS = ["misc", "storageQuota"]

// The eval sources that decide what a case measures: the fake app and its data, both loops, the chat
// wrappers, the prompts and the worker's context settings (and, below, @filen/assistant-node's model mapping). Not the cases (each record hashes its own), the
// graders (a grading change needs --fresh or another --out), the report or the CLI.
const EVAL_SOURCES = ["agent", "chatWrappers", "decoys", "fakeApp", "fixture", "formulaSheet", "loopHarness", "prompts", "worker"]

// The formula check and preview the formula suite runs every written formula through.
const OFFICE_SOURCES = ["input/formulaCheck", "formula/preview"]

// What a stored result was measured against: every source of the shared assistant (prompts, tools and
// their titles and guard metadata, the loop, guard, sanitizing, dates, budgets), the shared helpers and eval
// sources above, the inference engine's version (its llama.cpp build, samplers, chat templates and grammar),
// the case itself with the state its setup builds, and the model (its file's sha256 and context options). A record whose fingerprint differs
// measured something else, so a resumed run does it again and the report leaves it out; otherwise a prompt
// edit would re-report the numbers from before it.
const PROMPTS_AND_TOOLS = JSON.stringify({
	date: EVAL_DATE_LINE,
	shared: readdirSync(SHARED_ASSISTANT)
		.filter(file => file.endsWith(".ts"))
		.sort()
		.map(file => [file, readFileSync(new URL(file, SHARED_ASSISTANT), "utf8")]),
	helpers: SHARED_HELPERS.map(file => readFileSync(new URL(`../../filen-shared/src/${file}.ts`, import.meta.url), "utf8")),
	eval: EVAL_SOURCES.map(file => readFileSync(new URL(`./${file}.ts`, import.meta.url), "utf8")),
	office: OFFICE_SOURCES.map(file => readFileSync(new URL(`../../filen-office/src/core/sheet/${file}.ts`, import.meta.url), "utf8")),
	// The node-llama-cpp mapping the desktop app's engine shares.
	adapter: readFileSync(new URL("../../filen-assistant-node/src/llamaModel.ts", import.meta.url), "utf8"),
	engine: (
		JSON.parse(readFileSync(new URL("../node_modules/node-llama-cpp/package.json", import.meta.url), "utf8")) as {
			version: string
		}
	).version
})

type FixtureCase = {
	context?: Partial<AppContext>
	setup?: (state: AppState) => void
}

// The state a case's context and setup build, per case object: worker and report fingerprint each case once per
// model and preset. A setup is mostly a closure over a payload or a helper, which its source text does not show.
const BUILT_STATES = new WeakMap<object, string>()

function builtState(item: unknown): string {
	if (typeof item !== "object" || item === null || !("context" in item || "setup" in item)) {
		return ""
	}

	const cached = BUILT_STATES.get(item)

	if (cached !== undefined) {
		return cached
	}

	const { context, setup } = item as FixtureCase
	const state = createFixtureState(context)

	setup?.(state)

	const built = JSON.stringify(state)

	BUILT_STATES.set(item, built)

	return built
}

// A model as fingerprints name it: its id, the exact weights and the context it runs with.
export function modelKey(entry: { id: string; sha256: string; contextOptions?: unknown }): string {
	return `${entry.id}:${entry.sha256}:${JSON.stringify(entry.contextOptions ?? {})}`
}

export function caseFingerprint({ modelId, item }: { modelId: string; item: unknown }): string {
	return createHash("sha256")
		.update(PROMPTS_AND_TOOLS)
		.update("\0")
		.update(modelId)
		.update("\0")
		.update(
			JSON.stringify(item, (key, value: unknown) => {
				if (key === "setup") {
					return undefined
				}

				return typeof value === "function" ? String(value) : value
			})
		)
		.update("\0")
		.update(builtState(item))
		.digest("hex")
		.slice(0, 16)
}

// One JSONL line, or null for a line a crash cut short.
export function parseRecordLine<T>(line: string): T | null {
	try {
		return JSON.parse(line) as T
	} catch {
		return null
	}
}
