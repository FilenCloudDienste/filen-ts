import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createChatWrapper } from "@filen/assistant-eval/src/chatWrappers.ts"
import { LlamaAssistantModel, toHistory, type LoopRuntime } from "@filen/assistant-eval/src/loopHarness.ts"
import type { ModelEntry } from "@filen/assistant-eval/src/models.ts"
import { getLlama, type ChatModelFunctions, type Llama, type LlamaContext, type LlamaModel, type Token } from "node-llama-cpp"
import type { FromEngine, RawRequest, RawResult, ToEngine } from "./protocol.ts"

// The native engine of the bench: node-llama-cpp in a utility process of its own, the eval harness's
// AssistantModel over three sequences (router, main, extraction) as the web worker keeps three slots. Main
// drives the shared loop over it through process messages.

// The eval's settings: each sequence gets its own 8192 cells (the web worker shares 12288 across its slots).
const CONTEXT_TOKENS = 8192
const SEQUENCES = 3

const port = process.parentPort
// The package exports no package.json; it sits beside dist/.
const NODE_LLAMA_CPP_VERSION = (
	JSON.parse(
		readFileSync(path.join(path.dirname(fileURLToPath(import.meta.resolve("node-llama-cpp"))), "..", "package.json"), "utf8")
	) as {
		version: string
	}
).version

let state: { llama: Llama; model: LlamaModel; context: LlamaContext; runtime: LoopRuntime; assistant: LlamaAssistantModel } | null = null

function send(message: FromEngine): void {
	port.postMessage(message)
}

function loaded(): NonNullable<typeof state> {
	if (state === null) {
		throw new Error("No model loaded")
	}

	return state
}

async function raw(request: RawRequest): Promise<RawResult> {
	const { model, runtime } = loaded()
	const sequence = runtime.mainSequence

	await sequence.clearHistory()

	const tokens = model.tokenize(request.prompt, true)
	const started = performance.now()
	let first = started
	const out: Token[] = []

	for await (const token of sequence.evaluate(tokens, { temperature: 0, yieldEogToken: true })) {
		if (out.length === 0) {
			first = performance.now()
		}

		if (!request.ignoreEos && model.isEogToken(token)) {
			break
		}

		out.push(token)

		if (out.length >= request.maxTokens) {
			break
		}
	}

	const ended = performance.now()

	return {
		text: model.detokenize(out),
		promptTokens: tokens.length,
		promptMs: first - started,
		// The first token comes from the prompt's logits; each later one is a decode step.
		generatedTokens: Math.max(0, out.length - 1),
		generateMs: ended - first,
		wallMs: ended - started
	}
}

// The text a main request reads, as node-llama-cpp's chat wrapper renders it, so the wasm engine can read
// the very same tokens.
function renderPrompt(request: Extract<ToEngine, { t: "generate" }>["request"]): string {
	const { model, runtime } = loaded()
	const wrapper = runtime.createWrapper()
	const functions: ChatModelFunctions | undefined =
		request.tools === undefined || request.tools.length === 0
			? undefined
			: Object.fromEntries(request.tools.map(tool => [tool.name, { description: tool.description, params: tool.parameters }]))
	const history = [
		...toHistory(request.messages, wrapper.settings.functions.parallelism !== undefined),
		{ type: "model" as const, response: [] }
	]
	const { contextText } = wrapper.generateContextState({
		chatHistory: history,
		...(functions === undefined ? {} : { availableFunctions: functions })
	})

	return model.detokenize(contextText.tokenize(model.tokenizer), true)
}

async function load(message: Extract<ToEngine, { t: "load" }>): Promise<void> {
	const manifest = JSON.parse(readFileSync(message.modelsJson, "utf8")) as { models: ModelEntry[] }
	const entry = manifest.models.find(model => model.id === message.modelId)

	if (entry === undefined) {
		throw new Error(`Unknown model ${message.modelId}`)
	}

	const started = performance.now()
	const llama = await getLlama({ gpu: "auto", build: "never" })
	const engineMs = performance.now() - started
	const model = await llama.loadModel({ modelPath: message.gguf })
	const weightsMs = performance.now() - started - engineMs
	const context = await model.createContext({ contextSize: CONTEXT_TOKENS, sequences: SEQUENCES })
	const loadMs = performance.now() - started
	const specialTokens: string[] = []

	for (const token of model.iterateAllTokens()) {
		if (model.isSpecialToken(token)) {
			const text = model.detokenize([token], true)

			if (text.length > 1) {
				specialTokens.push(text)
			}
		}
	}

	const runtime: LoopRuntime = {
		llama,
		routerSequence: context.getSequence(),
		mainSequence: context.getSequence(),
		quarantineSequence: context.getSequence(),
		createWrapper: () => createChatWrapper({ entry, model }),
		specialTokens,
		contextTokens: CONTEXT_TOKENS
	}

	state = { llama, model, context, runtime, assistant: new LlamaAssistantModel(runtime) }

	// As the shipped load primes the router's system prompt: read it and sample one token.
	const prime = await raw({ prompt: message.primeSystem, maxTokens: 1, ignoreEos: true })

	send({
		t: "loaded",
		result: {
			loadMs,
			steps: { engineMs, weightsMs, contextMs: loadMs - engineMs - weightsMs },
			firstTokenMs: loadMs + prime.wallMs,
			backend: String(llama.gpu),
			engineVersion: `node-llama-cpp ${NODE_LLAMA_CPP_VERSION}, llama.cpp ${llama.llamaCppRelease.repo}@${llama.llamaCppRelease.release}`,
			kvCells: CONTEXT_TOKENS * SEQUENCES,
			gpuUsedBytes: (await llama.getVramState()).used
		},
		specialTokens,
		contextTokens: CONTEXT_TOKENS
	})
}

async function handle(message: ToEngine): Promise<void> {
	switch (message.t) {
		case "load":
			await load(message)
			break
		case "generate": {
			const { assistant } = loaded()
			const prompt = message.request.slot === "main" ? renderPrompt(message.request) : null
			const result = await assistant.generate(message.request, { signal: new AbortController().signal })

			send({ t: "generated", id: message.id, result, prompt })
			break
		}
		case "raw":
			send({ t: "raw", id: message.id, result: await raw(message.request) })
			break
		case "tokens":
			send({ t: "tokens", id: message.id, count: loaded().model.tokenize(message.text, true).length })
			break
		case "memory":
			send({
				t: "memory",
				id: message.id,
				rssBytes: process.memoryUsage.rss(),
				// maxRSS is reported in kilobytes on every platform.
				maxRssBytes: process.resourceUsage().maxRSS * 1024,
				gpuUsedBytes: state === null ? 0 : (await state.llama.getVramState()).used
			})
			break
	}
}

port.on("message", ({ data }: { data: ToEngine }) => {
	handle(data).catch((e: unknown) => {
		send({ t: "error", ...("id" in data ? { id: data.id } : {}), message: e instanceof Error ? (e.stack ?? e.message) : String(e) })
	})
})
