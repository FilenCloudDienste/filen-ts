import path from "node:path"
import type { AssistantGenerateRequest } from "@filen/shared/assistant"
import type { DesktopAssistantError, DesktopAssistantLoaded, DesktopAssistantUpdate } from "@filen/shared/desktop"
import { downloadModelShards, ModelDownloadError, type Connectivity, type StreamingHasher } from "@filen/shared/dom/assistantModel/download"
import type { AssistantModelFiles } from "@filen/shared/dom/assistantModel/manifest"
import type { Llama, LlamaContext, LlamaGpuType, LlamaModel } from "node-llama-cpp"
import { ENGINE_BACKENDS, failure, type EngineBackend, type FromEngine, type ToEngine } from "../shared/assistantProtocol.ts"
import { LlamaSlotModel, type GenerateUpdate } from "@filen/assistant-node"
import { hashFile, shardStore, type EngineShardStore } from "./shardFiles.ts"

// The assistant's engine: runs in the "Filen Assistant" utility process, apart from sync, mounts and transfers, so a
// crash or an out-of-memory kill takes nothing else down. Downloads the model's shards into the app's data directory
// (the shared resumable, verified download) and runs it with llama.cpp through node-llama-cpp, the weights
// memory-mapped. Main starts it for a download or a load and ends it once the page lets go.

export type LlamaModule = Pick<typeof import("node-llama-cpp"), "getLlama" | "getLlamaGpuTypes" | "LlamaLogLevel">

export interface EngineDeps {
	send(message: FromEngine): void
	fetchShard(url: string, init: RequestInit): Promise<Response>
	createHasher(): Promise<StreamingHasher>
	connectivity: Connectivity
	// node-llama-cpp's entry points the engine loads a model with.
	llama(): Promise<LlamaModule>
}

// The order backends are tried in: the fastest first, the CPU last.
export function backendOrder(supported: readonly EngineBackend[], exclude: readonly EngineBackend[]): EngineBackend[] {
	return ENGINE_BACKENDS.filter(backend => supported.includes(backend) && !exclude.includes(backend))
}

// null for a backend the app does not ship (CUDA).
export function toBackend(gpu: LlamaGpuType): EngineBackend | null {
	const backend = gpu === false ? "cpu" : gpu

	return ENGINE_BACKENDS.find(shipped => shipped === backend) ?? null
}

function toGpu(backend: EngineBackend): LlamaGpuType {
	return backend === "cpu" ? false : backend
}

// Streamed text reaches main at most this often; the last state always goes before the result.
const TEXT_THROTTLE_MS = 50

// How long an unload waits for cancelled generations to settle.
const SETTLE_GRACE_MS = 500

// The prompt batch a Stop waits out at most, for the page's watchdog (node-llama-cpp checks a stop between batches).
const WATCHDOG_BATCH_TOKENS = 512

const PRIME_USER = "Hi"

function isOutOfMemory(text: string): boolean {
	return /out of memory|cannot allocate|allocation failed|failed to allocate|unable to allocate|insufficient memory|bad_alloc|\boom\b/i.test(
		text
	)
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (error instanceof Error && error.name === "AbortError")
}

function downloadError(error: unknown): DesktopAssistantError {
	if (error instanceof ModelDownloadError) {
		return error.kind
	}

	if (error instanceof Error && error.name === "QuotaExceededError") {
		return "storage-full"
	}

	return error instanceof Error && error.name === "AbortError" ? "aborted" : "network"
}

type Reply = Extract<FromEngine, { t: "reply" }>["result"]

interface Loaded {
	llama: Llama
	model: LlamaModel
	context: LlamaContext
	slots: LlamaSlotModel
}

export interface Engine {
	handle(message: ToEngine): void
}

export function createEngine(deps: EngineDeps): Engine {
	let download: { controller: AbortController; done: Promise<void> } | null = null
	let loaded: Loaded | null = null
	const generations = new Map<number, { controller: AbortController; done: Promise<unknown> }>()
	let tail: Promise<unknown> = Promise.resolve()

	function log(level: "info" | "warn", message: string): void {
		deps.send({ t: "log", level, message })
	}

	async function runDownload(model: AssistantModelFiles, baseUrl: string, dir: string): Promise<void> {
		const previous = download
		const controller = new AbortController()
		const run = (async () => {
			await previous?.done.catch(() => undefined)
			controller.signal.throwIfAborted()
			await downloadModelShards({
				manifest: model,
				baseUrl,
				store: await shardStore(dir, model),
				createHasher: deps.createHasher,
				fetchShard: deps.fetchShard,
				connectivity: deps.connectivity,
				signal: controller.signal,
				onProgress: ({ receivedBytes, waiting }) => {
					deps.send({ t: "progress", receivedBytes, waiting })
				}
			})
		})()

		previous?.controller.abort()
		download = { controller, done: run }

		try {
			await run
		} finally {
			if (download?.controller === controller) {
				download = null
			}
		}
	}

	// Every shard at its size; one at full size but missing from the record is hashed now, once, and dropped if it
	// does not match. Whether all are there.
	async function checkShards(model: AssistantModelFiles, dir: string, store: EngineShardStore): Promise<boolean> {
		for (const shard of model.shards) {
			if (store.sizeOnDisk(shard) !== shard.size) {
				return false
			}

			if (!store.isVerified(shard)) {
				deps.send({ t: "verifying" })

				if ((await hashFile(path.join(dir, shard.file))) !== shard.sha256) {
					store.discard(shard)

					return false
				}

				await store.markVerified(shard)
			}
		}

		return true
	}

	// After every backend failed: a shard damaged on disk since it was verified is one cause the record cannot show.
	async function discardDamaged(model: AssistantModelFiles, dir: string, store: EngineShardStore): Promise<boolean> {
		let damaged = false

		deps.send({ t: "verifying" })

		for (const shard of model.shards) {
			if ((await hashFile(path.join(dir, shard.file))) !== shard.sha256) {
				store.discard(shard)
				damaged = true
			}
		}

		return damaged
	}

	async function loadOn(
		module: LlamaModule,
		backend: EngineBackend,
		{ modelPath, sequenceTokens, primeSystem }: { modelPath: string; sequenceTokens: number; primeSystem: string }
	): Promise<DesktopAssistantLoaded & Loaded> {
		const llama = await module.getLlama({
			gpu: toGpu(backend),
			build: "never",
			usePrebuiltBinaries: true,
			progressLogs: false,
			logLevel: module.LlamaLogLevel.warn,
			logger: (level, message) => {
				log(level === module.LlamaLogLevel.info ? "info" : "warn", `llama.cpp: ${message}`)
			}
		})

		deps.send({ t: "started", backend })

		try {
			// Memory-mapped: the weights stay file pages the system can drop and read back.
			const model = await llama.loadModel({ modelPath, useMmap: true })
			const context = await model.createContext({ contextSize: sequenceTokens, sequences: 3 })
			const slots = new LlamaSlotModel({
				llama,
				sequences: { router: context.getSequence(), main: context.getSequence(), extraction: context.getSequence() }
			})
			const specialTokens: string[] = []

			for (const token of model.iterateAllTokens()) {
				if (model.isSpecialToken(token)) {
					const text = model.detokenize([token], true)

					if (text.length > 1) {
						specialTokens.push(text)
					}
				}
			}

			// The router's system prompt, read once so every routing request reads only its own message after it.
			const started = performance.now()
			const promptTokens = model.tokenize(primeSystem, false).length

			await slots.generate(
				{
					slot: "router",
					maxTokens: 1,
					messages: [
						{ role: "system", content: primeSystem },
						{ role: "user", content: PRIME_USER }
					]
				},
				{ signal: new AbortController().signal }
			)

			const msPerToken = promptTokens > 0 ? (performance.now() - started) / promptTokens : 0

			return {
				llama,
				model,
				context,
				slots,
				specialTokens,
				backend,
				...(msPerToken > 0 ? { promptBatchMs: msPerToken * WATCHDOG_BATCH_TOKENS } : {})
			}
		} catch (error) {
			await llama.dispose().catch(() => undefined)

			throw error
		}
	}

	async function load(call: Extract<ToEngine, { op: "load" }>): Promise<Reply> {
		if (loaded !== null) {
			return failure("load-failed", "A model is already loaded")
		}

		const store = await shardStore(call.dir, call.model)
		const first = call.model.shards[0]

		if (first === undefined || !(await checkShards(call.model, call.dir, store))) {
			return failure("missing", "The model is not downloaded")
		}

		const module = await deps.llama()
		const supported = (await module.getLlamaGpuTypes("supported")).flatMap(gpu => toBackend(gpu) ?? [])
		const errors: string[] = []

		for (const backend of backendOrder([...supported, "cpu"], call.exclude)) {
			deps.send({ t: "trying", backend })

			try {
				const result = await loadOn(module, backend, {
					modelPath: path.join(call.dir, first.file),
					sequenceTokens: call.sequenceTokens,
					primeSystem: call.primeSystem
				})

				loaded = { llama: result.llama, model: result.model, context: result.context, slots: result.slots }

				return {
					ok: true,
					value: {
						specialTokens: result.specialTokens,
						backend: result.backend,
						...(result.promptBatchMs === undefined ? {} : { promptBatchMs: result.promptBatchMs })
					} satisfies DesktopAssistantLoaded
				}
			} catch (error) {
				const message = messageOf(error)

				// Another backend would not have more memory than the one that ran out of it.
				if (isOutOfMemory(message)) {
					return failure("out-of-memory", message)
				}

				log("warn", `assistant engine: ${backend} did not load: ${message}`)
				errors.push(`${backend}: ${message}`)
			}
		}

		if (await discardDamaged(call.model, call.dir, store)) {
			return failure("missing", "A downloaded shard was damaged")
		}

		return failure("unavailable", errors.join("\n") || "No backend of this build runs here")
	}

	async function generate(call: Extract<ToEngine, { op: "generate" }>): Promise<Reply> {
		const controller = new AbortController()
		const previous = tail
		let finish: () => void = () => undefined
		const done = new Promise<void>(resolve => {
			finish = resolve
		})

		tail = previous.then(() => done)
		generations.set(call.gen, { controller, done })

		let pending: string | null = null
		let timer: NodeJS.Timeout | undefined
		const flush = () => {
			clearTimeout(timer)
			timer = undefined

			if (pending !== null) {
				deps.send({ t: "update", gen: call.gen, update: { type: "text", text: pending } })
				pending = null
			}
		}
		const onUpdate = call.updates
			? (update: GenerateUpdate) => {
					if (update.type === "text") {
						pending = update.text
						timer ??= setTimeout(flush, TEXT_THROTTLE_MS)

						return
					}

					flush()
					deps.send({ t: "update", gen: call.gen, update: update satisfies DesktopAssistantUpdate })
				}
			: undefined

		try {
			await previous

			const current = loaded

			if (current === null) {
				return failure("missing", "No model is loaded")
			}

			controller.signal.throwIfAborted()

			const result = await current.slots.generate(call.request as AssistantGenerateRequest, {
				signal: controller.signal,
				...(onUpdate === undefined ? {} : { onUpdate })
			})

			return { ok: true, value: result }
		} catch (error) {
			return isAbort(error, controller.signal) ? failure("aborted", "Stopped") : failure("failed", messageOf(error))
		} finally {
			flush()
			generations.delete(call.gen)
			finish()
		}
	}

	async function unload(): Promise<void> {
		const running = [...generations.values()]

		for (const { controller } of running) {
			controller.abort()
		}

		const current = loaded

		loaded = null
		await Promise.race([
			Promise.allSettled(running.map(({ done }) => done)),
			new Promise(resolve => {
				setTimeout(resolve, SETTLE_GRACE_MS)
			})
		])

		if (current !== null) {
			current.slots.dispose()
			await current.context.dispose()
			await current.model.dispose()
			await current.llama.dispose()
		}
	}

	async function call(message: Extract<ToEngine, { t: "call" }>): Promise<Reply> {
		switch (message.op) {
			case "download":
				try {
					await runDownload(message.model, message.baseUrl, message.dir)

					return { ok: true, value: null }
				} catch (error) {
					return failure(downloadError(error), messageOf(error))
				}
			case "load":
				return load(message)
			case "generate":
				return generate(message)
			case "unload":
				await unload()

				return { ok: true, value: null }
		}
	}

	return {
		handle: message => {
			switch (message.t) {
				case "cancelDownload":
					download?.controller.abort()
					break
				case "cancel":
					generations.get(message.gen)?.controller.abort()
					break
				case "call":
					void call(message)
						.catch((error: unknown) => failure("failed", messageOf(error)))
						.then(result => {
							deps.send({ t: "reply", id: message.id, result })
						})
					break
			}
		}
	}
}
