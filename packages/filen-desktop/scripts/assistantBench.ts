import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseArgs } from "node:util"
import electronPath from "electron"
import { build } from "esbuild"
import { packageDir } from "./paths.ts"

// Bench-only spike: the shipped wasm/WebGPU engine (wllama in a page) against a native llama.cpp engine
// (node-llama-cpp in a second utility process), on the same GGUF and prompts. Measures load time, prompt and
// generation tok/s, turn latency through the shared loop over the eval's fake app (native), memory per
// process and greedy fidelity. Not part of the app or its build.
//
//   node scripts/assistantBench.ts --gguf <path to Qwen3.5-4B-Q4_K_M.gguf> [--engines native,wasm] [--runs 5]
//
// The wasm engine reads the prompts the native run captured (<out>/prompts.json), so a wasm-only run needs a
// native run first. The page's OPFS (in <out>/electron-profile) keeps a copy of the model between runs.

const { values } = parseArgs({
	options: {
		gguf: { type: "string" },
		engines: { type: "string", default: "native,wasm" },
		runs: { type: "string", default: "5" },
		cases: { type: "string", default: "20" },
		"gen-tokens": { type: "string", default: "256" },
		"fidelity-tokens": { type: "string", default: "128" },
		"prompt-tokens": { type: "string", default: "2048" },
		out: { type: "string", default: path.join(packageDir, "build", "assistant-bench") }
	}
})

if (values.gguf === undefined || !existsSync(values.gguf)) {
	console.error("--gguf <path> is required: the shipped Qwen3.5-4B Q4_K_M GGUF (the eval keeps it in .models/)")
	process.exit(1)
}

const out = path.resolve(values.out)
const bundleDir = path.join(out, "bundle")
const engines = values.engines.split(",").filter((engine): engine is "native" | "wasm" => engine === "native" || engine === "wasm")
const evalDir = path.join(packageDir, "..", "filen-assistant-eval")

mkdirSync(bundleDir, { recursive: true })

const common = { bundle: true, sourcemap: false, logLevel: "warning", absWorkingDir: packageDir } as const
// Bundled CommonJS reaches Node built-ins only through a require of its own.
const esmRequire = {
	js: 'import { createRequire as __benchCreateRequire } from "node:module"; const require = __benchCreateRequire(import.meta.url);'
}

await Promise.all([
	build({
		...common,
		entryPoints: ["scripts/assistantBench/main.ts"],
		outfile: path.join(bundleDir, "main.mjs"),
		platform: "node",
		target: "node24",
		format: "esm",
		banner: esmRequire,
		external: ["electron", "node-llama-cpp"]
	}),
	// node-llama-cpp loads its prebuilt binaries by path, so it stays external and resolves from this package.
	build({
		...common,
		entryPoints: ["scripts/assistantBench/engine.ts"],
		outfile: path.join(bundleDir, "engine.mjs"),
		platform: "node",
		target: "node24",
		format: "esm",
		banner: esmRequire,
		external: ["electron", "node-llama-cpp"]
	}),
	build({
		...common,
		entryPoints: ["scripts/assistantBench/page.ts"],
		outfile: path.join(bundleDir, "page.js"),
		platform: "browser",
		target: "chrome140",
		format: "esm"
	})
])

const config = {
	gguf: path.resolve(values.gguf),
	wasm: path.join(packageDir, "..", "filen-web", "src", "vendor", "wllama", "wllama.wasm"),
	modelsJson: path.join(evalDir, "models.json"),
	modelId: "qwen3.5-4b",
	out,
	engines,
	runs: Number(values.runs),
	cases: Number(values.cases),
	genTokens: Number(values["gen-tokens"]),
	fidelityTokens: Number(values["fidelity-tokens"]),
	promptTokens: Number(values["prompt-tokens"])
}

const run = spawnSync(String(electronPath), [path.join(bundleDir, "main.mjs")], {
	stdio: "inherit",
	env: { ...process.env, FILEN_ASSISTANT_BENCH: JSON.stringify(config) }
})

if (run.status !== 0) {
	process.exit(run.status ?? 1)
}

// ---- Summary ----

type Raw = { text: string; promptTokens: number; promptMs: number; generatedTokens: number; generateMs: number }
type Memory = Record<string, { footprintBytes: number | null; peakWorkingSetBytes: number | null } | number>
type Load = { loadMs: number; firstTokenMs: number; backend: string; engineVersion: string; memory: Memory }
type Result = {
	loads: (Load & { spawnToFirstTokenMs?: number; openToFirstTokenMs?: number })[]
	speed: Raw[]
	fidelity: { caseId: string; text: string }[]
	memory: Memory
	turns?: { totalMs: number; routerMs: number }[]
}

function read(name: string): Result | null {
	const file = path.join(out, `${name}.json`)

	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Result) : null
}

function quantile(values: readonly number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b)

	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN
}

function stat(values: readonly number[], digits = 1): string {
	return `${quantile(values, 0.5).toFixed(digits)} (${Math.min(...values).toFixed(digits)}–${Math.max(...values).toFixed(digits)})`
}

function mib(bytes: unknown): string {
	return typeof bytes === "number" ? `${Math.round(bytes / 1024 ** 2)} MiB` : "–"
}

function memoryLine(memory: Memory): string {
	return Object.entries(memory)
		.map(([name, value]) =>
			typeof value === "number"
				? `${name} ${mib(value)}`
				: `${name} ${mib(value.footprintBytes)} (peak RSS ${mib(value.peakWorkingSetBytes)})`
		)
		.join(", ")
}

const results = { native: read("native"), wasm: read("wasm") }

for (const [name, result] of Object.entries(results)) {
	if (result === null) {
		continue
	}

	const first = result.loads[0]

	console.log(`\n## ${name}: ${first?.engineVersion ?? "?"} (${first?.backend ?? "?"})`)
	console.log(
		`- load (engine): ${stat(
			result.loads.map(load => load.loadMs / 1000),
			2
		)} s; first run ${((first?.loadMs ?? 0) / 1000).toFixed(2)} s`
	)
	console.log(
		`- load → first token (process/page start included): ${stat(
			result.loads.map(load => (load.spawnToFirstTokenMs ?? load.openToFirstTokenMs ?? 0) / 1000),
			2
		)} s`
	)
	console.log(
		`- prompt: ${stat(result.speed.map(item => (item.promptTokens / item.promptMs) * 1000))} tok/s over ${String(result.speed[0]?.promptTokens ?? 0)} tokens`
	)
	console.log(
		`- generation: ${stat(result.speed.map(item => (item.generatedTokens / item.generateMs) * 1000))} tok/s over ${String(result.speed[0]?.generatedTokens ?? 0)} tokens`
	)

	if (result.turns !== undefined) {
		const totals = result.turns.map(turn => turn.totalMs / 1000)

		console.log(
			`- turn: median ${quantile(totals, 0.5).toFixed(2)} s, p90 ${quantile(totals, 0.9).toFixed(2)} s over ${String(totals.length)} turns`
		)
	}

	console.log(`- memory after the last load: ${memoryLine(result.loads.at(-1)?.memory ?? {})}`)
	console.log(`- memory after the benches: ${memoryLine(result.memory)}`)
}

if (results.native !== null && results.wasm !== null) {
	const wasm = new Map(results.wasm.fidelity.map(item => [item.caseId, item.text]))
	const differing = results.native.fidelity.filter(item => wasm.get(item.caseId) !== item.text)

	console.log(
		`\n## fidelity: ${String(results.native.fidelity.length - differing.length)}/${String(results.native.fidelity.length)} identical greedy replies`
	)

	for (const item of differing) {
		console.log(`- ${item.caseId}\n  native: ${JSON.stringify(item.text)}\n  wasm:   ${JSON.stringify(wasm.get(item.caseId) ?? null)}`)
	}
}
