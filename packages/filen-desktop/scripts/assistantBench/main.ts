import { execFile } from "node:child_process"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { EVAL_CASES } from "@filen/assistant-eval/src/cases/index.ts"
import type { EvalCase } from "@filen/assistant-eval/src/cases/types.ts"
import { FakeApp } from "@filen/assistant-eval/src/fakeApp.ts"
import { FakeAppExecutor, LOOP_PRESETS } from "@filen/assistant-eval/src/loopHarness.ts"
import { EVAL_NOW, EVAL_TIME_ZONE, PROMPT_CANARY } from "@filen/assistant-eval/src/prompts.ts"
import {
	ROUTER_SYSTEM_PROMPT,
	runAssistantTurn,
	type AssistantGenerateRequest,
	type AssistantGenerateResult,
	type AssistantModel
} from "@filen/shared/assistant"
import { app, BrowserWindow, net, protocol, utilityProcess, type UtilityProcess } from "electron"
import type { BenchConfig, EngineLoadResult, FromEngine, RawRequest, RawResult, ToEngine } from "./protocol.ts"

// The bench's Electron main: runs the native engine in a second utility process ("Filen Assistant") and the
// wasm engine in a hidden page, one after the other, and writes what it measured to <out>/<engine>.json.

const config = JSON.parse(process.env["FILEN_ASSISTANT_BENCH"] ?? "") as BenchConfig
const here = import.meta.dirname

// The prompt the shipped load primes: the router's system prompt in the model's ChatML layout.
const PRIME_PROMPT = `<|im_start|>system\n${ROUTER_SYSTEM_PROMPT.trim()}<|im_end|>\n<|im_start|>user\nHi`

app.setPath("userData", path.join(config.out, "electron-profile"))
protocol.registerSchemesAsPrivileged([
	{ scheme: "bench", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])

// ---- Memory ----

const execFileAsync = promisify(execFile)

// phys_footprint as macOS's footprint tool reports it (what Activity Monitor shows as Memory), GPU memory included.
async function footprintBytes(pid: number): Promise<number | null> {
	try {
		const { stdout } = await execFileAsync("footprint", ["-p", String(pid)])
		const match = /Footprint: ([\d.]+) (B|KB|MB|GB)/.exec(stdout)

		if (match === null) {
			return null
		}

		const units: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }

		return Number(match[1]) * (units[match[2] ?? "B"] ?? 1)
	} catch {
		return null
	}
}

// Peak working set per process, sampled from app.getAppMetrics().
const peaks = new Map<number, number>()
const sampler = setInterval(() => {
	for (const metric of app.getAppMetrics()) {
		peaks.set(metric.pid, Math.max(peaks.get(metric.pid) ?? 0, metric.memory.workingSetSize * 1024))
	}
}, 250)

function gpuPid(): number | null {
	return app.getAppMetrics().find(metric => metric.type === "GPU")?.pid ?? null
}

type MemorySnapshot = Record<string, { footprintBytes: number | null; peakWorkingSetBytes: number | null }>

async function snapshot(pids: Record<string, number | null>): Promise<MemorySnapshot> {
	const entries = await Promise.all(
		Object.entries(pids).map(async ([name, pid]) => [
			name,
			{
				footprintBytes: pid === null ? null : await footprintBytes(pid),
				peakWorkingSetBytes: pid === null ? null : (peaks.get(pid) ?? null)
			}
		])
	)

	return Object.fromEntries(entries) as MemorySnapshot
}

// ---- Shared bench steps ----

type RawEngine = { raw: (request: RawRequest) => Promise<RawResult> }

type Prompts = { prompt: string; promptTokens: number; fidelity: { caseId: string; prompt: string }[] }

async function speed(engine: RawEngine, prompts: Prompts): Promise<RawResult[]> {
	const results: RawResult[] = []

	for (let run = 0; run < config.runs; run++) {
		// One token past the measured ones: the first comes from the prompt's logits.
		results.push(await engine.raw({ prompt: prompts.prompt, maxTokens: config.genTokens + 1, ignoreEos: true }))
	}

	return results
}

async function fidelity(engine: RawEngine, prompts: Prompts): Promise<{ caseId: string; text: string }[]> {
	const replies: { caseId: string; text: string }[] = []

	for (const item of prompts.fidelity) {
		const { text } = await engine.raw({ prompt: item.prompt, maxTokens: config.fidelityTokens, ignoreEos: false })

		replies.push({ caseId: item.caseId, text })
	}

	return replies
}

function write(name: string, data: unknown): void {
	writeFileSync(path.join(config.out, `${name}.json`), `${JSON.stringify(data, null, "\t")}\n`)
}

// ---- Native: node-llama-cpp in a utility process ----

class EngineProcess implements RawEngine {
	readonly child: UtilityProcess
	private nextId = 1
	private readonly pending = new Map<number, { resolve: (message: FromEngine) => void; reject: (error: Error) => void }>()
	private onLoaded: ((message: Extract<FromEngine, { t: "loaded" }>) => void) | null = null
	private onFailed: ((error: Error) => void) | null = null
	readonly exited: Promise<number>

	constructor() {
		this.child = utilityProcess.fork(path.join(here, "engine.mjs"), [], { serviceName: "Filen Assistant", stdio: "inherit" })
		this.child.on("message", (message: FromEngine) => {
			if (message.t === "loaded") {
				this.onLoaded?.(message)

				return
			}

			if (message.t === "error" && message.id === undefined) {
				this.onFailed?.(new Error(message.message))

				return
			}

			if ("id" in message && message.id !== undefined) {
				const waiter = this.pending.get(message.id)

				this.pending.delete(message.id)

				if (message.t === "error") {
					waiter?.reject(new Error(message.message))
				} else {
					waiter?.resolve(message)
				}
			}
		})
		this.exited = new Promise(resolve => this.child.once("exit", resolve))
	}

	load(): Promise<Extract<FromEngine, { t: "loaded" }>> {
		return new Promise((resolve, reject) => {
			this.onLoaded = resolve
			this.onFailed = reject
			this.exited.then(code => reject(new Error(`engine exited with ${String(code)}`))).catch(reject)
			this.child.postMessage({
				t: "load",
				gguf: config.gguf,
				modelsJson: config.modelsJson,
				modelId: config.modelId,
				primeSystem: PRIME_PROMPT
			} satisfies ToEngine)
		})
	}

	private call<T extends FromEngine["t"]>(message: ToEngine & { id: number }): Promise<Extract<FromEngine, { t: T }>> {
		return new Promise((resolve, reject) => {
			this.pending.set(message.id, { resolve: resolve as (message: FromEngine) => void, reject })
			this.child.postMessage(message)
		})
	}

	async raw(request: RawRequest): Promise<RawResult> {
		return (await this.call<"raw">({ t: "raw", id: this.nextId++, request })).result
	}

	generate(request: AssistantGenerateRequest): Promise<Extract<FromEngine, { t: "generated" }>> {
		return this.call<"generated">({ t: "generate", id: this.nextId++, request })
	}

	async tokens(text: string): Promise<number> {
		return (await this.call<"tokens">({ t: "tokens", id: this.nextId++, text })).count
	}

	memory(): Promise<Extract<FromEngine, { t: "memory" }>> {
		return this.call<"memory">({ t: "memory", id: this.nextId++ })
	}

	async stop(): Promise<void> {
		this.child.kill()
		await this.exited
	}
}

// The shared AssistantModel over the utility process: every request is a process message, as a shipped
// native engine would take them. Records the first main request's prompt of each turn.
class UtilityAssistantModel implements AssistantModel {
	readonly contextTokens: number
	readonly specialTokens: readonly string[]
	firstMainPrompt: string | null = null
	routerMs = 0
	private readonly engine: EngineProcess

	constructor(engine: EngineProcess, loaded: Extract<FromEngine, { t: "loaded" }>) {
		this.engine = engine
		this.contextTokens = loaded.contextTokens
		this.specialTokens = loaded.specialTokens
	}

	async generate(request: AssistantGenerateRequest): Promise<AssistantGenerateResult> {
		const started = performance.now()
		const { result, prompt } = await this.engine.generate(request)

		if (request.slot === "router") {
			this.routerMs += performance.now() - started
		}

		if (prompt !== null) {
			this.firstMainPrompt ??= prompt
		}

		return result
	}
}

// English single-turn cases, one category after another, so every kind of request is in the set.
function benchCases(count: number): EvalCase[] {
	const byCategory = new Map<string, EvalCase[]>()

	for (const item of EVAL_CASES) {
		if (item.lang === "en" && item.followUps === undefined) {
			byCategory.set(item.category, [...(byCategory.get(item.category) ?? []), item])
		}
	}

	const picked: EvalCase[] = []

	for (let index = 0; picked.length < count; index++) {
		const round = [...byCategory.values()].flatMap(cases => cases.slice(index, index + 1))

		if (round.length === 0) {
			break
		}

		picked.push(...round.slice(0, count - picked.length))
	}

	return picked
}

async function turns(engine: EngineProcess, loaded: Extract<FromEngine, { t: "loaded" }>) {
	const records: {
		caseId: string
		category: string
		route: string | null
		totalMs: number
		routerMs: number
		reply: string
		prompt: string | null
	}[] = []

	for (const item of benchCases(config.cases)) {
		const fakeApp = new FakeApp(item.context)

		item.setup?.(fakeApp.state)

		const model = new UtilityAssistantModel(engine, loaded)
		const started = performance.now()
		const result = await runAssistantTurn({
			model,
			executor: new FakeAppExecutor(fakeApp, LOOP_PRESETS.shipped.supports),
			history: [],
			message: item.prompt,
			signal: new AbortController().signal,
			onEvent: () => undefined,
			confirm: () => Promise.resolve(true),
			nonce: () => PROMPT_CANARY,
			secrets: { canary: PROMPT_CANARY },
			now: EVAL_NOW,
			timeZone: EVAL_TIME_ZONE,
			weekStart: 1
		})

		records.push({
			caseId: item.id,
			category: item.category,
			route: result.route,
			totalMs: performance.now() - started,
			routerMs: model.routerMs,
			reply: result.reply,
			prompt: model.firstMainPrompt
		})
		console.log(`[native] turn ${String(records.length)}: ${item.id} ${String(Math.round(performance.now() - started))} ms`)
	}

	return records
}

async function runNative(): Promise<void> {
	const loads: (EngineLoadResult & { spawnToFirstTokenMs: number; memory: MemorySnapshot })[] = []
	let engine: EngineProcess | null = null
	let loaded: Extract<FromEngine, { t: "loaded" }> | null = null

	for (let run = 0; run < config.runs; run++) {
		await engine?.stop()

		const started = performance.now()

		engine = new EngineProcess()
		loaded = await engine.load()

		const pid = engine.child.pid ?? null

		loads.push({ ...loaded.result, spawnToFirstTokenMs: performance.now() - started, memory: await snapshot({ engine: pid }) })
		console.log(`[native] load ${String(run + 1)}: ${String(Math.round(performance.now() - started))} ms`)
	}

	if (engine === null || loaded === null) {
		return
	}

	const turnRecords = await turns(engine, loaded)
	const captured = turnRecords.flatMap(record => (record.prompt === null ? [] : [{ caseId: record.caseId, prompt: record.prompt }]))
	const sized = await Promise.all(captured.map(async item => ({ ...item, tokens: await engine.tokens(item.prompt) })))
	// The captured main prompt closest to the target size, the longer one on a tie.
	const chosen = sized.reduce<(typeof sized)[number] | undefined>(
		(best, item) =>
			best === undefined || Math.abs(item.tokens - config.promptTokens) < Math.abs(best.tokens - config.promptTokens) ? item : best,
		undefined
	)

	if (chosen === undefined) {
		throw new Error("No main prompt was captured")
	}

	const prompts: Prompts = { prompt: chosen.prompt, promptTokens: chosen.tokens, fidelity: captured }

	write("prompts", { ...prompts, promptCaseId: chosen.caseId, sizes: sized.map(({ caseId, tokens }) => ({ caseId, tokens })) })

	const speedRuns = await speed(engine, prompts)
	const replies = await fidelity(engine, prompts)
	const engineMemory = await engine.memory()
	const pid = engine.child.pid ?? null
	const memory = await snapshot({ engine: pid })

	await engine.stop()
	write("native", {
		loads,
		turns: turnRecords.map(({ prompt: _prompt, ...rest }) => rest),
		speed: speedRuns,
		fidelity: replies,
		memory: { ...memory, maxRssBytes: engineMemory.maxRssBytes, gpuUsedBytes: engineMemory.gpuUsedBytes }
	})
}

// ---- wasm: wllama + WebGPU in a hidden page ----

const PAGE = `<!doctype html><meta charset="utf-8"><title>assistant bench</title><script type="module" src="page.js"></script>`

function serve(): void {
	const isolation = {
		"Cross-Origin-Opener-Policy": "same-origin",
		"Cross-Origin-Embedder-Policy": "require-corp",
		"Cross-Origin-Resource-Policy": "same-origin"
	}

	protocol.handle("bench", async request => {
		const { pathname } = new URL(request.url)

		if (pathname === "/" || pathname === "/index.html") {
			return new Response(PAGE, { headers: { ...isolation, "Content-Type": "text/html" } })
		}

		const files: Record<string, [string, string]> = {
			"/page.js": [path.join(here, "page.js"), "text/javascript"],
			"/wllama.wasm": [config.wasm, "application/wasm"],
			"/model.gguf": [config.gguf, "application/octet-stream"]
		}
		const file = files[pathname]

		if (file === undefined) {
			return new Response("not found", { status: 404 })
		}

		const response = await net.fetch(pathToFileURL(file[0]).href)

		return new Response(response.body, { headers: { ...isolation, "Content-Type": file[1] } })
	})
}

class Page implements RawEngine {
	readonly window: BrowserWindow

	constructor() {
		this.window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } })
	}

	async open(): Promise<void> {
		await this.window.loadURL("bench://app/index.html")
	}

	call<T>(fn: string, ...args: unknown[]): Promise<T> {
		return this.window.webContents.executeJavaScript(
			`assistantBench.${fn}(${args.map(arg => JSON.stringify(arg)).join(",")})`
		) as Promise<T>
	}

	raw(request: RawRequest): Promise<RawResult> {
		return this.call<RawResult>("raw", request)
	}

	async close(): Promise<void> {
		const closed = new Promise<void>(resolve => this.window.once("closed", () => resolve()))

		this.window.destroy()
		await closed
	}
}

async function runWasm(): Promise<void> {
	const prompts = JSON.parse(readFileSync(path.join(config.out, "prompts.json"), "utf8")) as Prompts

	serve()

	const stager = new Page()

	await stager.open()

	const adapter = await stager.call<string>("webgpu")
	const staged = await stager.call<{ copied: boolean; ms: number }>("stage", statSync(config.gguf).size)

	await stager.close()
	console.log(`[wasm] adapter ${adapter}; model ${staged.copied ? "copied to" : "already in"} OPFS (${String(Math.round(staged.ms))} ms)`)

	const baseline = await snapshot({ gpu: gpuPid() })
	const loads: (EngineLoadResult & { openToFirstTokenMs: number; memory: MemorySnapshot })[] = []
	let page: Page | null = null

	for (let run = 0; run < config.runs; run++) {
		await page?.close()

		const started = performance.now()

		page = new Page()
		await page.open()

		const result = await page.call<EngineLoadResult>("load", PRIME_PROMPT)

		loads.push({
			...result,
			openToFirstTokenMs: performance.now() - started,
			memory: await snapshot({ page: page.window.webContents.getOSProcessId(), gpu: gpuPid() })
		})
		console.log(`[wasm] load ${String(run + 1)}: ${String(Math.round(performance.now() - started))} ms`)
	}

	if (page === null) {
		return
	}

	const speedRuns = await speed(page, prompts)
	const replies = await fidelity(page, prompts)
	const memory = await snapshot({ page: page.window.webContents.getOSProcessId(), gpu: gpuPid() })

	await page.close()
	write("wasm", { adapter, baseline, loads, speed: speedRuns, fidelity: replies, memory })
}

async function main(): Promise<void> {
	await app.whenReady()

	if (config.engines.includes("native")) {
		await runNative()
	}

	if (config.engines.includes("wasm")) {
		await runWasm()
	}
}

app.on("window-all-closed", () => undefined)

main()
	.catch((e: unknown) => {
		console.error(e)
		process.exitCode = 1
	})
	.finally(() => {
		clearInterval(sampler)
		app.quit()
	})
