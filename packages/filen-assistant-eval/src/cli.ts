import { fork } from "node:child_process"
import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { MITIGATION_PRESETS } from "./agent"
import { EVAL_CASES } from "./cases"
import { INJECTION_CASES } from "./cases/injection"
import { TRANSFORM_CASES, TRANSFORM_CATEGORIES } from "./cases/transform"
import { CATEGORIES, LANGUAGES } from "./cases/types"
import { ensureModel, loadManifest, PACKAGE_ROOT } from "./models"
import { list, resolveRun } from "./options"
import { writeReport } from "./report"
import type { WorkerJob } from "./worker"

const USAGE = `Usage: pnpm eval <command> [options]

Commands:
  run        Run the evaluation (resumes unless --fresh), then write the report
  download   Download and verify the configured models
  report     Rebuild summary.json and summary.md from existing results
  list       Show the case counts

Options:
  --models <ids>       Comma-separated model ids (default: every enabled model)
  --suite <name>       main | injection | transform | all (default: all)
  --presets <names>    Presets for the injection suite (default: shipped,loop)
  --main-presets <n>   Presets for the main suite (default: shipped)

Presets: shipped (the shipping loop with the tools the web app runs), loop (the shipping loop with every
web tool), desktop (the desktop app's tools; runs only the desktop cases), and the legacy harness's mitigation presets (${Object.keys(MITIGATION_PRESETS).join(", ")}).
  --categories <list>  Main- and transform-suite categories to run
  --languages <list>   Languages to run (every suite)
  --cases <ids>        Exact case ids to run
  --sample <n>         Keep every n-th case of the selection (quick subsets)
  --out <dir>          Results directory (default: results/default)
  --models-dir <dir>   Model cache (default: .models)
  --fresh              Delete the selected models' previous results first`

function runWorker(job: WorkerJob): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		// One process per model: memory is returned to the OS between models and peak RSS is per model.
		const child = fork(join(PACKAGE_ROOT, "src", "worker.ts"), [JSON.stringify(job)], {
			execArgv: process.execArgv,
			stdio: "inherit"
		})

		child.on("exit", code => (code === 0 ? resolvePromise() : reject(new Error(`Worker for ${job.modelId} exited with ${code}`))))
	})
}

async function main(): Promise<void> {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			models: {
				type: "string"
			},
			suite: {
				type: "string"
			},
			presets: {
				type: "string"
			},
			"main-presets": {
				type: "string"
			},
			categories: {
				type: "string"
			},
			languages: {
				type: "string"
			},
			cases: {
				type: "string"
			},
			sample: {
				type: "string"
			},
			out: {
				type: "string"
			},
			"models-dir": {
				type: "string"
			},
			fresh: {
				type: "boolean"
			},
			help: {
				type: "boolean"
			}
		}
	})
	const command = positionals[0]

	if (command === undefined || values.help === true) {
		console.log(USAGE)

		return
	}

	const outDir = resolve(PACKAGE_ROOT, values.out ?? "results/default")
	const modelsDir = resolve(PACKAGE_ROOT, values["models-dir"] ?? ".models")
	const manifest = await loadManifest()
	const wantedModels = list(values.models)
	const models = manifest.filter(model => (wantedModels === undefined ? model.enabled : wantedModels.includes(model.id)))

	if (wantedModels !== undefined && models.length !== wantedModels.length) {
		throw new Error(`Unknown model in ${wantedModels.join(", ")}; known: ${manifest.map(model => model.id).join(", ")}`)
	}

	if (command === "list") {
		const counts = (items: readonly { lang: string }[]) =>
			LANGUAGES.map(lang => `${lang} ${items.filter(item => item.lang === lang).length}`).join(", ")

		for (const category of CATEGORIES) {
			const items = EVAL_CASES.filter(item => item.category === category)

			console.log(`${category}: ${items.length} (${counts(items)})`)
		}

		for (const category of TRANSFORM_CATEGORIES) {
			const items = TRANSFORM_CASES.filter(item => item.category === category)

			console.log(`${category}: ${items.length} (${counts(items)})`)
		}

		console.log(
			`main total: ${EVAL_CASES.length}; injection: ${INJECTION_CASES.length} in ${new Set(INJECTION_CASES.map(item => item.lang)).size} languages; transform: ${TRANSFORM_CASES.length}`
		)

		return
	}

	if (command === "report") {
		await writeReport({
			outDir,
			manifest
		})

		return
	}

	if (command !== "download" && command !== "run") {
		throw new Error(`Unknown command "${command}"\n\n${USAGE}`)
	}

	const selection = command === "run" ? resolveRun(values) : undefined

	for (const model of models) {
		const modelPath = await ensureModel({
			model,
			dir: modelsDir
		})

		if (selection === undefined) {
			console.log(`${model.id}: ${modelPath}`)

			continue
		}

		if (values.fresh === true) {
			await rm(join(outDir, model.id), {
				recursive: true,
				force: true
			})
		}

		await runWorker({
			modelId: model.id,
			modelPath,
			outDir,
			main: {
				presets: selection.mainPresets,
				caseIds: selection.mainCaseIds
			},
			injection: {
				presets: selection.injectionPresets,
				caseIds: selection.injectionCaseIds
			},
			transform: {
				caseIds: selection.transformCaseIds
			}
		})
	}

	if (command === "run") {
		await writeReport({
			outDir,
			manifest
		})
	}
}

await main()
