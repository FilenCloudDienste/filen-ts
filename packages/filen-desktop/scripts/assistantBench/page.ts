import { LogLevel, Wllama } from "@wllama/wllama/esm/index.js"
import type { EngineLoadResult, RawRequest, RawResult } from "./protocol.ts"

// The wasm engine of the bench, in a page of its own: wllama 3.8.1 (pnpm-patched) with the web app's rebuilt
// wllama.wasm, loaded from OPFS with the web worker's WebGPU settings (src/workers/assistant.worker.ts in
// filen-web). Main calls the functions on `globalThis.assistantBench` through executeJavaScript.

const MODEL_FILE = "model.gguf"
// The web app's context: ASSISTANT_CONTEXT_TOKENS + ROUTER_CONTEXT_TOKENS + QUARANTINE_CONTEXT_TOKENS.
const CONTEXT_TOKENS = 8192 + 2048 + 2048

let engine: Wllama | null = null

// Copies the model into this page's OPFS once, as the web app keeps it there.
async function stage(size: number): Promise<{ copied: boolean; ms: number }> {
	const started = performance.now()
	const root = await navigator.storage.getDirectory()
	const handle = await root.getFileHandle(MODEL_FILE, { create: true })

	if ((await handle.getFile()).size === size) {
		return { copied: false, ms: performance.now() - started }
	}

	const response = await fetch("bench://app/model.gguf")

	if (!response.ok || response.body === null) {
		throw new Error(`model fetch failed: ${String(response.status)}`)
	}

	await response.body.pipeTo(await handle.createWritable())

	return { copied: true, ms: performance.now() - started }
}

async function load(primeSystem: string): Promise<EngineLoadResult> {
	if (engine !== null) {
		throw new Error("A model is already loaded")
	}

	if (!crossOriginIsolated) {
		throw new Error("The page is not cross-origin isolated")
	}

	const root = await navigator.storage.getDirectory()
	const file = await (await root.getFileHandle(MODEL_FILE)).getFile()
	const started = performance.now()
	const instance = new Wllama({ default: "bench://app/wllama.wasm" }, { suppressNativeLog: true })

	instance.setCompat(null)

	await instance.loadModel([file], {
		n_ctx: CONTEXT_TOKENS,
		n_threads: Math.max(1, Math.min(8, Math.floor(navigator.hardwareConcurrency / 2))),
		n_gpu_layers: 999,
		jinja: true,
		reasoning: false,
		n_batch: 512,
		n_ubatch: 512,
		n_parallel: 3,
		kv_unified: true,
		cache_idle_slots: false,
		n_ctx_checkpoints: 6,
		checkpoint_min_step: 256,
		cache_ram_mib: 2048,
		log_level: LogLevel.ERROR
	})

	const loadMs = performance.now() - started
	const info = instance.getLoadedContextInfo()

	if (!(info.n_vocab > 0 && info.n_ctx > 0)) {
		throw new Error("The engine did not load the model")
	}

	engine = instance

	const prime = await raw({ prompt: primeSystem, maxTokens: 1, ignoreEos: true })

	return {
		loadMs,
		firstTokenMs: loadMs + prime.wallMs,
		backend: "webgpu",
		engineVersion: "wllama 3.8.1, llama.cpp 46ca246 (filen-web vendor build)",
		kvCells: info.n_ctx
	}
}

async function raw(request: RawRequest): Promise<RawResult> {
	if (engine === null) {
		throw new Error("No model loaded")
	}

	// cache_prompt and ignore_eos reach llama.cpp's server as they are (wllama forwards the JSON).
	const params = {
		prompt: request.prompt,
		max_tokens: request.maxTokens,
		temperature: 0,
		ignore_eos: request.ignoreEos,
		cache_prompt: false
	}
	const started = performance.now()
	const response = await engine.createCompletion(params)
	const wallMs = performance.now() - started
	const timings = response.timings

	if (timings === undefined) {
		throw new Error("The engine reported no timings")
	}

	return {
		text: response.choices[0]?.text ?? "",
		promptTokens: timings.prompt_n,
		promptMs: timings.prompt_ms,
		generatedTokens: Math.max(0, timings.predicted_n - 1),
		generateMs: timings.predicted_ms,
		wallMs
	}
}

async function webgpu(): Promise<string> {
	const adapter = await navigator.gpu.requestAdapter()

	return adapter === null ? "none" : `${adapter.info.vendor} ${adapter.info.architecture}`.trim()
}

Object.assign(globalThis, { assistantBench: { stage, load, raw, webgpu } })
