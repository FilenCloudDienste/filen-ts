import { createInterface } from "node:readline"
import { type } from "arktype"
import type { AssistantGenerateRequest, AssistantGenerateResult } from "@filen/shared/assistant"
import type {
	DesktopAssistantEvent,
	DesktopAssistantImport,
	DesktopAssistantInspection,
	DesktopAssistantLoaded,
	DesktopAssistantLoadOptions,
	DesktopAssistantResult
} from "@filen/shared/desktop"
import type { AssistantModelFiles } from "@filen/shared/dom/assistantModel/manifest"
import { deleteModels, ensureModelDir, inspectModel, otherModels } from "../../assistant/modelDir.ts"
import {
	ENGINE_BACKENDS,
	failure,
	fromEngineSchema,
	loadedSchema,
	type EngineBackend,
	type EngineCall,
	type FromEngine,
	type ToEngine
} from "../../shared/assistantProtocol.ts"
import { CHANNELS } from "../../shared/channels.ts"
import { serialQueue } from "../../shared/serial.ts"
import type { AtomicFile } from "../atomicFile.ts"
import type { Page } from "../pages.ts"
import { redact } from "../redact.ts"
import { createModelImporter } from "./importer.ts"

// Main's side of the assistant's native engine: starts the "Filen Assistant" utility process for the page that asks
// (a download or a load) and ends it when that page lets go, navigates or goes away, so an idle app holds none of its
// memory. Picks the backend: the engine tries the best one this machine supports first and falls back to the next on
// an error; one that crashes the process is recorded and left out from then on. When none runs, the engine counts as
// unavailable for this version of the app and the page uses its own (WebGPU) engine instead.

// The part of Electron's UtilityProcess the service uses; tests pass a fake.
export interface EngineProcess {
	readonly stdout: NodeJS.ReadableStream | null
	readonly stderr: NodeJS.ReadableStream | null
	postMessage(message: ToEngine): void
	kill(): boolean
	on(event: "message", listener: (message: unknown) => void): unknown
	on(event: "exit", listener: (code: number) => void): unknown
}

export interface AssistantServiceDeps {
	// The engine's files are in this build.
	shipped(): boolean
	fork(): EngineProcess
	// `<userData>/assistant/models`: one directory per model.
	modelsRoot: string
	// What failed on this machine, for this version of the app.
	stateFile: AtomicFile
	version: string
	log: { info(message: string): void; warn(message: string): void }
}

export interface AssistantService {
	available(): Promise<boolean>
	inspect(model: AssistantModelFiles): Promise<DesktopAssistantInspection>
	otherModels(id: string): Promise<{ present: boolean; bytes: number }>
	deleteModels(keep: string | null): Promise<void>
	download(page: Page, model: AssistantModelFiles, baseUrl: string): Promise<DesktopAssistantResult<null>>
	cancelDownload(page: Page): void
	importChunk(
		page: Page,
		model: AssistantModelFiles,
		file: string,
		offset: number,
		bytes: Uint8Array,
		last: boolean
	): Promise<DesktopAssistantResult<DesktopAssistantImport>>
	load(
		page: Page,
		model: AssistantModelFiles,
		options: DesktopAssistantLoadOptions
	): Promise<DesktopAssistantResult<DesktopAssistantLoaded>>
	generate(
		page: Page,
		gen: number,
		request: AssistantGenerateRequest,
		updates: boolean
	): Promise<DesktopAssistantResult<AssistantGenerateResult>>
	cancel(page: Page, gen: number): void
	unload(page: Page): Promise<void>
	release(page: Page): void
	pageGone(pageId: number): void
	// Quitting, or signing out: the process goes at once, whatever it was doing.
	stop(): void
	// Signing out: stops, then deletes every downloaded model. Settles once they are gone.
	wipe(): Promise<void>
}

const stateSchema = type({
	version: "string",
	crashed: type.enumerated(...ENGINE_BACKENDS).array(),
	unusable: "boolean",
	"+": "delete"
})

export type EngineState = typeof stateSchema.infer

interface Child {
	proc: EngineProcess
	page: Page
	nextId: number
	pending: Map<number, (result: DesktopAssistantResult<unknown>) => void>
	// The backend being tried by a load, until its outcome: an exit meanwhile is its crash.
	trying: EngineBackend | null
	// The backend whose binary runs, once it does.
	started: EngineBackend | null
	// Ended on purpose: what it had pending was stopped, not crashed.
	stopped: boolean
	exited: boolean
}

const CRASHED = failure("crashed", "The assistant engine stopped")

const STOPPED = failure("aborted", "The assistant engine was stopped")

export function createAssistantService(deps: AssistantServiceDeps): AssistantService {
	const serial = serialQueue()
	let child: Child | null = null
	let state: EngineState | null = null
	const importer = createModelImporter(deps.modelsRoot)

	async function readState(): Promise<EngineState> {
		if (state !== null) {
			return state
		}

		let read: EngineState | null

		try {
			const data = await deps.stateFile.read()
			const parsed = data === null ? null : stateSchema(JSON.parse(data.toString("utf8")))

			read = parsed instanceof type.errors ? null : parsed
		} catch {
			read = null
		}

		// Another version of the app may run what this one could not.
		state = read?.version === deps.version ? read : { version: deps.version, crashed: [], unusable: false }

		return state
	}

	async function saveState(next: EngineState): Promise<void> {
		state = next

		try {
			await deps.stateFile.write(Buffer.from(JSON.stringify(next)))
		} catch (error) {
			deps.log.warn(`assistant: engine state not saved: ${error instanceof Error ? error.message : String(error)}`)
		}
	}

	function exited(current: Child): void {
		if (current.exited) {
			return
		}

		current.exited = true

		if (child === current) {
			child = null
		}

		for (const resolve of current.pending.values()) {
			resolve(current.stopped ? STOPPED : CRASHED)
		}

		current.pending.clear()
		current.page.send(CHANNELS.assistantEvent, { kind: "exited" } satisfies DesktopAssistantEvent)
	}

	function onMessage(current: Child, raw: unknown): void {
		const message = fromEngineSchema(raw)

		if (message instanceof type.errors) {
			deps.log.warn("assistant: invalid engine message dropped")

			return
		}

		handleMessage(current, message)
	}

	function handleMessage(current: Child, message: FromEngine): void {
		switch (message.t) {
			case "reply": {
				const resolve = current.pending.get(message.id)

				current.pending.delete(message.id)
				resolve?.(message.result)
				break
			}
			case "trying":
				current.trying = message.backend
				break
			case "started":
				current.started = message.backend
				break
			case "progress":
				current.page.send(CHANNELS.assistantEvent, {
					kind: "download",
					receivedBytes: message.receivedBytes,
					waiting: message.waiting
				} satisfies DesktopAssistantEvent)
				break
			case "verifying":
				current.page.send(CHANNELS.assistantEvent, { kind: "verifying" } satisfies DesktopAssistantEvent)
				break
			case "update":
				current.page.send(CHANNELS.assistantEvent, {
					kind: "update",
					id: message.gen,
					update: message.update
				} satisfies DesktopAssistantEvent)
				break
			case "log":
				deps.log[message.level](redact(message.message))
				break
		}
	}

	function kill(current: Child): void {
		current.stopped = true
		current.proc.kill()
		exited(current)
	}

	// The process for `page`, started when there is none; another page's goes first (only one page runs the model).
	function childFor(page: Page): Child | null {
		if (child !== null && child.page.id !== page.id) {
			kill(child)
		}

		if (child !== null) {
			return child
		}

		if (!deps.shipped()) {
			return null
		}

		const proc = deps.fork()

		const current: Child = { proc, page, nextId: 1, pending: new Map(), trying: null, started: null, stopped: false, exited: false }

		proc.on("message", raw => {
			onMessage(current, raw)
		})
		proc.on("exit", code => {
			if (!current.exited) {
				deps.log.warn(`assistant: engine exited (${String(code)})`)
			}

			exited(current)
		})

		for (const stream of [proc.stdout, proc.stderr]) {
			if (stream !== null) {
				createInterface({ input: stream, crlfDelay: Infinity }).on("line", line => {
					deps.log.info(`assistant engine: ${redact(line)}`)
				})
			}
		}

		child = current

		return current
	}

	function call(current: Child, body: EngineCall): Promise<DesktopAssistantResult<unknown>> {
		if (current.exited) {
			return Promise.resolve(CRASHED)
		}

		const id = current.nextId++

		return new Promise(resolve => {
			current.pending.set(id, resolve)

			try {
				current.proc.postMessage({ t: "call", id, ...body })
			} catch {
				current.pending.delete(id)
				resolve(CRASHED)
			}
		})
	}

	function owned(page: Page): Child | null {
		return child !== null && child.page.id === page.id ? child : null
	}

	async function load(
		page: Page,
		model: AssistantModelFiles,
		options: DesktopAssistantLoadOptions
	): Promise<DesktopAssistantResult<DesktopAssistantLoaded>> {
		const dir = await ensureModelDir(deps.modelsRoot, model.id)

		// A backend that crashes the process is left out and the next one tried, in a new process.
		for (;;) {
			const current = childFor(page)

			if (current === null) {
				return failure("unavailable", "The assistant engine is not in this build")
			}

			const known = await readState()

			current.trying = null
			current.started = null

			const result = await call(current, {
				op: "load",
				model,
				dir,
				exclude: known.crashed,
				sequenceTokens: options.sequenceTokens,
				primeSystem: options.primeSystem
			})

			if (result.ok) {
				const loaded = loadedSchema(result.value)

				if (loaded instanceof type.errors) {
					kill(current)

					return failure("load-failed", "The assistant engine answered an invalid load")
				}

				deps.log.info(`assistant: model loaded on ${loaded.backend}`)

				return { ok: true, value: loaded }
			}

			// Reading the model (its memory, a driver): the next load may well get through, so nothing is left out.
			if (result.error === "crashed" && current.trying !== null && current.started === current.trying) {
				return result
			}

			if (result.error === "crashed" && current.trying !== null) {
				deps.log.warn(`assistant: the ${current.trying} backend crashed the engine; left out from now on`)
				await saveState({ ...known, crashed: [...known.crashed, current.trying] })

				continue
			}

			// Gone before it tried any backend, or every backend failed: the engine cannot run here. Its model is dead weight
			// to this version of the app; the page downloads its own.
			if (result.error === "crashed" || result.error === "unavailable") {
				deps.log.warn(`assistant: no backend runs here; the page's engine is used instead: ${redact(result.message)}`)
				await saveState({ ...known, unusable: true })
				kill(current)
				await serial(() => deleteModels(deps.modelsRoot, null)).catch((error: unknown) => {
					deps.log.warn(`assistant: unusable models not deleted: ${error instanceof Error ? error.message : String(error)}`)
				})

				return failure("unavailable", result.message)
			}

			return result
		}
	}

	return {
		available: async () => {
			const known = await readState()

			return deps.shipped() && !known.unusable && known.crashed.length < ENGINE_BACKENDS.length
		},
		inspect: model => inspectModel(deps.modelsRoot, model),
		otherModels: id => otherModels(deps.modelsRoot, id),
		deleteModels: keep => serial(() => deleteModels(deps.modelsRoot, keep)),
		download: async (page, model, baseUrl) => {
			const dir = await ensureModelDir(deps.modelsRoot, model.id)
			const current = childFor(page)

			if (current === null) {
				return failure("unavailable", "The assistant engine is not in this build")
			}

			return (await call(current, { op: "download", model, baseUrl, dir })) as DesktopAssistantResult<null>
		},
		cancelDownload: page => {
			owned(page)?.proc.postMessage({ t: "cancelDownload" })
		},
		importChunk: (page, model, file, offset, bytes, last) => serial(() => importer.chunk(page.id, model, file, offset, bytes, last)),
		load: (page, model, options) => load(page, model, options),
		generate: async (page, gen, request, updates) => {
			const current = owned(page)

			if (current === null) {
				return failure("missing", "No model is loaded")
			}

			return (await call(current, { op: "generate", gen, request, updates })) as DesktopAssistantResult<AssistantGenerateResult>
		},
		cancel: (page, gen) => {
			owned(page)?.proc.postMessage({ t: "cancel", gen })
		},
		unload: async page => {
			const current = owned(page)

			if (current !== null) {
				await call(current, { op: "unload" })
			}
		},
		release: page => {
			const current = owned(page)

			if (current !== null) {
				kill(current)
			}
		},
		pageGone: pageId => {
			if (child !== null && child.page.id === pageId) {
				kill(child)
			}

			void serial(() => importer.abandon(pageId))
		},
		stop: () => {
			if (child !== null) {
				kill(child)
			}
		},
		wipe: async () => {
			if (child !== null) {
				kill(child)
			}

			await serial(() => importer.abandon())

			await serial(() => deleteModels(deps.modelsRoot, null))
		}
	}
}
