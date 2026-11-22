import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getLlama, type Token } from "node-llama-cpp"
import type { AssistantActOnReadAction } from "@filen/shared/assistant"
import { MITIGATION_PRESETS, runTurn, type AgentRuntime, type MitigationPreset, type Transcript } from "./agent"
import { createChatWrapper, parseSpecialTokensInResults } from "./chatWrappers"
import { EVAL_CASES } from "./cases"
import { INJECTION_CASES } from "./cases/injection"
import { FORMULA_CASES } from "./cases/formula"
import { TRANSFORM_CASES } from "./cases/transform"
import { FakeApp } from "./fakeApp"
import { gradeCase } from "./grader"
import { gradeInjection } from "./injectionGrader"
import { caseFingerprint, modelKey, parseRecordLine } from "./fingerprint"
import {
	isLoopPreset,
	presetRunsCase,
	runFormulaCase,
	runLoopTurns,
	runTransformCase,
	shippedCase,
	type LoopPreset,
	type LoopRuntime
} from "./loopHarness"
import { loadManifest, type ModelEntry } from "./models"
import { ROUTER_GRAMMAR } from "./prompts"
import { gradeFormula } from "./formulaGrader"
import { gradeTransform } from "./transformGrader"

export type WorkerJob = {
	modelId: string
	modelPath: string
	outDir: string
	main: {
		presets: EvalPreset[]
		caseIds: string[]
	}
	injection: {
		presets: EvalPreset[]
		caseIds: string[]
	}
	// One generation per case, no presets: what ships.
	transform: {
		caseIds: string[]
	}
	// One or two generations per case (a refused formula is written again), no presets.
	formula: {
		caseIds: string[]
	}
}

// A preset of the legacy harness (agent.ts: mitigations switched on and off one by one) or of the shipping loop.
export type EvalPreset = MitigationPreset | LoopPreset

const CONTEXT_SIZE = 8192
// Router, main and quarantine.
const SEQUENCES = 3

// Cases already measured against the current prompts, tools and case definition.
async function doneIds(path: string, fingerprints: ReadonlyMap<string, string>): Promise<Set<string>> {
	const text = await readFile(path, "utf8").catch(() => "")

	return new Set(
		text
			.split("\n")
			.filter(line => line.length > 0)
			.flatMap(line => {
				const record = parseRecordLine<{ caseId: string; fingerprint?: string }>(line)

				return record !== null && record.fingerprint !== undefined && record.fingerprint === fingerprints.get(record.caseId)
					? [record.caseId]
					: []
			})
	)
}

function rssBytes(): number {
	// maxRSS is reported in kilobytes on every platform.
	return process.resourceUsage().maxRSS * 1024
}

async function main(): Promise<void> {
	const job = JSON.parse(process.argv[2] ?? "{}") as WorkerJob
	const found = (await loadManifest()).find(model => model.id === job.modelId)

	if (found === undefined) {
		throw new Error(`Unknown model ${job.modelId}`)
	}

	const entry: ModelEntry = found

	const dir = join(job.outDir, entry.id)

	await mkdir(dir, {
		recursive: true
	})

	const loadStarted = performance.now()
	const llama = await getLlama({
		gpu: "auto"
	})
	const model = await llama.loadModel({
		modelPath: job.modelPath
	})
	const context = await model.createContext({
		contextSize: CONTEXT_SIZE,
		sequences: SEQUENCES,
		...(entry.contextOptions ?? {})
	})
	const loadMs = performance.now() - loadStarted
	const rssAfterLoad = process.memoryUsage.rss()
	const vramAfterLoad = await llama.getVramState()
	const specialTokens: string[] = []

	for (const token of model.iterateAllTokens()) {
		if (model.isSpecialToken(token)) {
			const text = model.detokenize([token as Token], true)

			if (text.length > 1) {
				specialTokens.push(text)
			}
		}
	}

	const routerGrammar = await llama.createGrammar({
		grammar: ROUTER_GRAMMAR
	})
	const sequences = [context.getSequence(), context.getSequence(), context.getSequence()] as const

	const loopRuntime: LoopRuntime = {
		llama,
		routerSequence: sequences[0],
		mainSequence: sequences[1],
		quarantineSequence: sequences[2],
		createWrapper: () => createChatWrapper({ entry, model }),
		specialTokens,
		contextTokens: CONTEXT_SIZE
	}

	// The shipping loop for its presets, the legacy harness for the rest; the legacy harness runs one turn, so
	// it leaves out the cases of several.
	async function transcriptOf({
		app,
		item,
		preset,
		injectionTools
	}: {
		app: FakeApp
		item: { prompt: string; followUps?: readonly string[]; actOnRead?: AssistantActOnReadAction }
		preset: EvalPreset
		injectionTools: boolean
	}): Promise<Transcript> {
		if (isLoopPreset(preset)) {
			return runLoopTurns({
				runtime: loopRuntime,
				app,
				prompts: [item.prompt, ...(item.followUps ?? [])],
				preset,
				actOnRead: item.actOnRead
			})
		}

		const mitigations = MITIGATION_PRESETS[preset]
		const runtime: AgentRuntime = {
			routerSequence: sequences[0],
			mainSequence: sequences[1],
			quarantineSequence: sequences[2],
			routerGrammar,
			specialTokens,
			createWrapper: () => {
				const wrapper = createChatWrapper({
					entry,
					model
				})

				if (!mitigations.sanitize) {
					parseSpecialTokensInResults(wrapper)
				}

				return wrapper
			}
		}

		return runTurn({
			runtime,
			app,
			prompt: item.prompt,
			mitigations,
			injectionTools
		})
	}

	// A suite without presets (null) writes <suite>.jsonl.
	async function run<T extends { id: string; followUps?: readonly string[]; app?: "desktop" }, P extends EvalPreset | null>({
		suite,
		presets,
		cases,
		execute
	}: {
		suite: "main" | "injection" | "transform" | "formula"
		presets: readonly P[]
		cases: readonly T[]
		execute: (options: { item: T; preset: P }) => Promise<unknown>
	}): Promise<void> {
		for (const preset of presets) {
			const path = join(dir, preset === null ? `${suite}.jsonl` : `${suite}-${preset}.jsonl`)
			const label = preset === null ? suite : `${suite}/${preset}`
			const fingerprints = new Map(cases.map(item => [item.id, caseFingerprint({ modelId: modelKey(entry), item })]))
			const done = await doneIds(path, fingerprints)
			const pending = cases.filter(
				item =>
					!done.has(item.id) &&
					(preset === null || isLoopPreset(preset) || item.followUps === undefined) &&
					presetRunsCase(preset, item)
			)

			console.log(`[${entry.id}] ${label}: ${pending.length} of ${cases.length} cases to run`)

			for (const [index, item] of pending.entries()) {
				const record = await execute({
					item,
					preset
				})

				await appendFile(path, `${JSON.stringify({ ...(record as object), fingerprint: fingerprints.get(item.id) })}\n`)

				if ((index + 1) % 10 === 0) {
					console.log(`[${entry.id}] ${label}: ${index + 1}/${pending.length}`)
				}
			}
		}
	}

	await run({
		suite: "main",
		presets: job.main.presets,
		cases: EVAL_CASES.filter(item => job.main.caseIds.includes(item.id)),
		execute: async ({ item, preset }) => {
			const app = new FakeApp(item.context, { desktop: item.app === "desktop" })

			item.setup?.(app.state)

			const before = structuredClone(app.state)
			const transcript = await transcriptOf({ app, item, preset, injectionTools: false })

			return {
				caseId: item.id,
				category: item.category,
				lang: item.lang,
				preset,
				grade: gradeCase({
					evalCase: preset === "shipped" ? shippedCase(item) : item,
					transcript,
					app,
					before
				}),
				transcript
			}
		}
	})

	await run({
		suite: "injection",
		presets: job.injection.presets,
		cases: INJECTION_CASES.filter(item => job.injection.caseIds.includes(item.id)),
		execute: async ({ item, preset }) => {
			const app = new FakeApp(item.context, { desktop: item.app === "desktop" })

			item.setup(app.state)

			const transcript = await transcriptOf({ app, item, preset, injectionTools: true })

			return {
				caseId: item.id,
				lang: item.lang,
				payloadLang: item.payloadLang,
				carrier: item.carrier,
				goal: item.goal,
				framing: item.framing,
				preset,
				grade: gradeInjection({
					injection: item,
					transcript
				}),
				transcript
			}
		}
	})

	await run({
		suite: "transform",
		presets: [null],
		cases: TRANSFORM_CASES.filter(item => job.transform.caseIds.includes(item.id)),
		execute: async ({ item }) => {
			const result = await runTransformCase({ runtime: loopRuntime, item })

			return {
				caseId: item.id,
				category: item.category,
				lang: item.lang,
				kind: item.kind,
				grade: gradeTransform({ item, result }),
				result
			}
		}
	})

	await run({
		suite: "formula",
		presets: [null],
		cases: FORMULA_CASES.filter(item => job.formula.caseIds.includes(item.id)),
		execute: async ({ item }) => {
			const result = await runFormulaCase({ runtime: loopRuntime, item })

			return {
				caseId: item.id,
				category: item.category,
				lang: item.lang,
				grade: gradeFormula({ item, result }),
				result
			}
		}
	})

	const metaPath = join(dir, "meta.json")
	const previous = JSON.parse(await readFile(metaPath, "utf8").catch(() => "{}")) as {
		fingerprint?: string
		peakRssBytes?: number
	}
	const key = modelKey(entry)
	// A peak belongs to what the records were measured with (engine, sources, weights, context): whatever
	// invalidates the records starts the peak afresh, a resume keeps the max.
	const fingerprint = caseFingerprint({
		modelId: key,
		item: {
			contextSize: context.contextSize,
			sequences: SEQUENCES
		}
	})
	const sameSettings = previous.fingerprint === fingerprint

	await writeFile(
		metaPath,
		`${JSON.stringify(
			{
				model: entry.id,
				key,
				fingerprint,
				gpu: llama.gpu,
				contextSize: context.contextSize,
				sequences: SEQUENCES,
				loadMs,
				rssAfterLoadBytes: rssAfterLoad,
				peakRssBytes: sameSettings ? Math.max(previous.peakRssBytes ?? 0, rssBytes()) : rssBytes(),
				vramAfterLoadBytes: vramAfterLoad.used,
				modelSizeBytes: model.size,
				specialTokenCount: specialTokens.length,
				updated: new Date().toISOString()
			},
			null,
			"\t"
		)}\n`
	)

	await context.dispose()
	await model.dispose()
	await llama.dispose()
}

await main()
