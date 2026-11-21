import type { AssistantGenerateRequest, AssistantGenerateResult } from "@filen/shared/assistant"

// Messages between the bench's main process and its two engines: the native engine's utility process (plain
// process messaging) and the wasm engine's page (executeJavaScript). Bench only; nothing here ships.

export type BenchConfig = {
	gguf: string
	wasm: string
	modelsJson: string
	modelId: string
	out: string
	engines: readonly ("native" | "wasm")[]
	runs: number
	cases: number
	genTokens: number
	fidelityTokens: number
	promptTokens: number
}

// A raw prompt, the same text for both engines: special tokens are parsed, nothing is cached between runs.
export type RawRequest = {
	prompt: string
	maxTokens: number
	ignoreEos: boolean
}

export type RawResult = {
	text: string
	promptTokens: number
	promptMs: number
	generatedTokens: number
	generateMs: number
	wallMs: number
}

export type EngineLoadResult = {
	// getLlama + loadModel + createContext (native) or new Wllama + loadModel (wasm).
	loadMs: number
	steps?: Record<string, number>
	// The router system prompt read and one token sampled, as the shipped load primes it.
	firstTokenMs: number
	backend: string
	engineVersion: string
	// KV cells across all slots.
	kvCells: number
	gpuUsedBytes?: number
}

export type ToEngine =
	| { t: "load"; gguf: string; modelsJson: string; modelId: string; primeSystem: string }
	| { t: "generate"; id: number; request: AssistantGenerateRequest }
	| { t: "raw"; id: number; request: RawRequest }
	| { t: "tokens"; id: number; text: string }
	| { t: "memory"; id: number }

export type FromEngine =
	| { t: "loaded"; result: EngineLoadResult; specialTokens: readonly string[]; contextTokens: number }
	| { t: "generated"; id: number; result: AssistantGenerateResult; prompt: string | null }
	| { t: "raw"; id: number; result: RawResult }
	| { t: "tokens"; id: number; count: number }
	| { t: "memory"; id: number; rssBytes: number; maxRssBytes: number; gpuUsedBytes: number }
	| { t: "error"; id?: number; message: string }
