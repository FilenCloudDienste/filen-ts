import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopAssistantEvent } from "@filen/shared/desktop"
import { registerAssistantIpc } from "../main/assistant/ipc.ts"
import { createAssistantService, type AssistantService, type EngineProcess } from "../main/assistant/service.ts"
import type { AtomicFile } from "../main/atomicFile.ts"
import type { IpcEvent, Page } from "../main/pages.ts"
import { ASSISTANT_CALLS, type AssistantCall, assistantChannel, CHANNELS } from "../shared/channels.ts"
import type { ToEngine } from "../shared/assistantProtocol.ts"
import { fakeIpc } from "./ipcFakes.ts"

// Main's side of the native engine against scripted engine processes: which backends a crash rules out, when the
// engine counts as unusable (and the page falls back to its own), what reaches the page, and what the IPC refuses.

const MODEL = {
	id: "test-model",
	shards: [{ file: "m.gguf", size: 4, sha256: "a".repeat(64) }]
}
const OPTIONS = { sequenceTokens: 8192, primeSystem: "route" }

class FakeProcess implements EngineProcess {
	readonly stdout = null
	readonly stderr = null
	readonly sent: ToEngine[] = []
	killed = false
	private readonly listeners = { message: [] as ((message: unknown) => void)[], exit: [] as ((code: number) => void)[] }

	postMessage(message: ToEngine): void {
		this.sent.push(message)
	}

	kill(): boolean {
		this.killed = true
		this.exit(0)

		return true
	}

	on(event: "message" | "exit", listener: (value: never) => void): unknown {
		this.listeners[event].push(listener as never)

		return this
	}

	emit(message: unknown): void {
		for (const listener of this.listeners.message) {
			listener(message)
		}
	}

	exit(code: number): void {
		for (const listener of this.listeners.exit) {
			listener(code)
		}
	}

	// The last call's id.
	lastCall(): number {
		const call = this.sent.filter(message => message.t === "call").at(-1)

		if (call === undefined) {
			throw new Error("no call")
		}

		return call.id
	}
}

function memoryFile(): AtomicFile & { data: Buffer | null } {
	const file = {
		data: null as Buffer | null,
		read: () => Promise.resolve(file.data),
		write: (data: Buffer) => {
			file.data = data

			return Promise.resolve()
		},
		remove: () => {
			file.data = null

			return Promise.resolve()
		}
	}

	return file
}

let root: string

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "filen-assistant-service-"))
})

afterEach(async () => {
	await rm(root, { recursive: true, force: true })
})

function setup(options: { shipped?: boolean; version?: string; stateFile?: AtomicFile & { data: Buffer | null } } = {}) {
	const processes: FakeProcess[] = []
	const stateFile = options.stateFile ?? memoryFile()
	const service = createAssistantService({
		shipped: () => options.shipped ?? true,
		fork: () => {
			const proc = new FakeProcess()

			processes.push(proc)

			return proc
		},
		modelsRoot: path.join(root, "models"),
		stateFile,
		version: options.version ?? "4.0.0",
		log: { info: vi.fn(), warn: vi.fn() }
	})
	const page = (id: number): Page & { events: DesktopAssistantEvent[] } => {
		const events: DesktopAssistantEvent[] = []

		return {
			id,
			events,
			send: (channel, payload) => {
				if (channel === CHANNELS.assistantEvent) {
					events.push(payload as DesktopAssistantEvent)
				}
			}
		}
	}

	return { service, processes, stateFile, page }
}

// Once the service's awaits (the state file, the model directory on disk) have run and process `index` got its call.
function engineCalled(processes: readonly FakeProcess[], index: number): Promise<FakeProcess> {
	return vi.waitFor(() => {
		const proc = processes[index]

		if (proc === undefined || !proc.sent.some(message => message.t === "call")) {
			throw new Error("the engine has no call yet")
		}

		return proc
	})
}

describe("assistant service", () => {
	it("is unavailable without the engine's files", async () => {
		const { service, page } = setup({ shipped: false })

		expect(await service.available()).toBe(false)
		expect(await service.load(page(1), MODEL, OPTIONS)).toMatchObject({ ok: false, error: "unavailable" })
	})

	it("hands a load's result on and routes the engine's events to the page that owns it", async () => {
		const { service, processes, page } = setup()
		const owner = page(1)
		const loading = service.load(owner, MODEL, OPTIONS)

		await engineCalled(processes, 0)

		const proc = processes[0]

		expect(proc?.sent[0]).toMatchObject({ t: "call", op: "load", exclude: [], sequenceTokens: 8192 })
		proc?.emit({ t: "verifying" })
		proc?.emit({ t: "trying", backend: "metal" })
		proc?.emit({ t: "reply", id: proc.lastCall(), result: { ok: true, value: { specialTokens: ["<|im_end|>"], backend: "metal" } } })

		expect(await loading).toEqual({ ok: true, value: { specialTokens: ["<|im_end|>"], backend: "metal" } })

		const generating = service.generate(owner, 3, { slot: "main", maxTokens: 4, messages: [{ role: "user", content: "hi" }] }, true)

		proc?.emit({ t: "update", gen: 3, update: { type: "text", text: "He" } })
		proc?.emit({ t: "reply", id: proc.lastCall(), result: { ok: true, value: { content: "Hello", toolCalls: [] } } })
		expect(await generating).toEqual({ ok: true, value: { content: "Hello", toolCalls: [] } })
		expect(owner.events).toEqual([{ kind: "verifying" }, { kind: "update", id: 3, update: { type: "text", text: "He" } }])
		// The models directory is created owner-only for the engine to write.
		expect((await stat(path.join(root, "models", MODEL.id))).isDirectory()).toBe(true)
	})

	it("leaves out a backend that crashed the engine and tries the rest in a new process, for good in this version", async () => {
		const { service, processes, stateFile, page } = setup()
		const loading = service.load(page(1), MODEL, OPTIONS)

		await engineCalled(processes, 0)
		processes[0]?.emit({ t: "trying", backend: "vulkan" })
		processes[0]?.exit(-1)
		await engineCalled(processes, 1)

		expect(processes).toHaveLength(2)
		expect(processes[1]?.sent[0]).toMatchObject({ op: "load", exclude: ["vulkan"] })
		processes[1]?.emit({ t: "trying", backend: "cpu" })
		processes[1]?.emit({
			t: "reply",
			id: processes[1].lastCall(),
			result: { ok: true, value: { specialTokens: [], backend: "vulkan" } }
		})
		expect(await loading).toMatchObject({ ok: true, value: { backend: "vulkan" } })
		expect(JSON.parse(stateFile.data?.toString("utf8") ?? "null")).toEqual({ version: "4.0.0", crashed: ["vulkan"], unusable: false })

		// The next start reads it back.
		const next = setup({ stateFile })
		const again = next.service.load(next.page(1), MODEL, OPTIONS)

		await engineCalled(next.processes, 0)
		expect(next.processes[0]?.sent[0]).toMatchObject({ exclude: ["vulkan"] })
		next.processes[0]?.emit({ t: "reply", id: 1, result: { ok: false, error: "missing", message: "gone" } })
		expect(await again).toMatchObject({ ok: false, error: "missing" })
	})

	it("leaves nothing out for a crash while the model was read: a later load may get through", async () => {
		const { service, processes, stateFile, page } = setup()
		const loading = service.load(page(1), MODEL, OPTIONS)

		await engineCalled(processes, 0)
		processes[0]?.emit({ t: "trying", backend: "metal" })
		processes[0]?.emit({ t: "started", backend: "metal" })
		processes[0]?.exit(-1)

		expect(await loading).toMatchObject({ ok: false, error: "crashed" })
		expect(processes).toHaveLength(1)
		expect(stateFile.data).toBeNull()
		expect(await service.available()).toBe(true)
	})

	it("counts as unusable once no backend runs, until another version of the app", async () => {
		const { service, processes, stateFile, page } = setup()
		const loading = service.load(page(1), MODEL, OPTIONS)

		await engineCalled(processes, 0)
		processes[0]?.emit({ t: "reply", id: 1, result: { ok: false, error: "unavailable", message: "cpu: no binary" } })
		expect(await loading).toMatchObject({ ok: false, error: "unavailable" })
		expect(processes[0]?.killed).toBe(true)
		expect(await service.available()).toBe(false)
		// Its model is of no use to this version: the page downloads its own.
		await expect(stat(path.join(root, "models", MODEL.id))).rejects.toThrow()

		expect(await setup({ stateFile }).service.available()).toBe(false)
		expect(await setup({ stateFile, version: "4.0.1" }).service.available()).toBe(true)
	})

	it("counts an engine that dies before trying any backend as unusable, but not one the page stopped", async () => {
		const crashed = setup()
		const loading = crashed.service.load(crashed.page(1), MODEL, OPTIONS)

		await engineCalled(crashed.processes, 0)
		crashed.processes[0]?.exit(-1)
		expect(await loading).toMatchObject({ ok: false, error: "unavailable" })
		expect(await crashed.service.available()).toBe(false)

		const stopped = setup()
		const owner = stopped.page(1)
		const pending = stopped.service.load(owner, MODEL, OPTIONS)

		await engineCalled(stopped.processes, 0)
		stopped.service.release(owner)
		expect(await pending).toMatchObject({ ok: false, error: "aborted" })
		expect(await stopped.service.available()).toBe(true)
		expect(owner.events).toContainEqual({ kind: "exited" })
	})

	it("answers a crashed generation as crashed and tells the page", async () => {
		const { service, processes, page } = setup()
		const owner = page(1)
		const loading = service.load(owner, MODEL, OPTIONS)

		await engineCalled(processes, 0)
		processes[0]?.emit({ t: "reply", id: 1, result: { ok: true, value: { specialTokens: [], backend: "cpu" } } })
		await loading

		const generating = service.generate(owner, 1, { slot: "main", maxTokens: 4, messages: [{ role: "user", content: "hi" }] }, false)

		processes[0]?.exit(-1)
		expect(await generating).toMatchObject({ ok: false, error: "crashed" })
		expect(owner.events).toContainEqual({ kind: "exited" })
	})

	it("runs one page's engine at a time and ends it when that page goes", async () => {
		const { service, processes, page } = setup()
		const first = page(1)
		const second = page(2)

		void service.download(first, MODEL, "https://cdn.example/gguf/")
		await engineCalled(processes, 0)
		void service.download(second, MODEL, "https://cdn.example/gguf/")
		await engineCalled(processes, 1)

		expect(processes[0]?.killed).toBe(true)
		expect(processes).toHaveLength(2)
		// Another page's cancel or generation never reaches this page's engine.
		service.cancelDownload(first)
		expect(processes[1]?.sent.some(message => message.t === "cancelDownload")).toBe(false)
		expect(
			await service.generate(first, 1, { slot: "main", maxTokens: 1, messages: [{ role: "user", content: "x" }] }, false)
		).toMatchObject({
			ok: false,
			error: "missing"
		})

		service.pageGone(2)
		expect(processes[1]?.killed).toBe(true)
	})

	it("drops an engine message that is not in the protocol", async () => {
		const { service, processes, page } = setup()
		const owner = page(1)

		void service.download(owner, MODEL, "https://cdn.example/gguf/")
		await engineCalled(processes, 0)
		processes[0]?.emit({ t: "progress", receivedBytes: -1, waiting: false })
		processes[0]?.emit({ t: "progress", receivedBytes: 10, waiting: true })
		expect(owner.events).toEqual([{ kind: "download", receivedBytes: 10, waiting: true }])
	})
})

describe("assistant ipc", () => {
	const APP = "filen://app/"

	function wired() {
		const { ipc, handlers } = fakeIpc()
		const service = {
			available: vi.fn(() => Promise.resolve(true)),
			inspect: vi.fn(() => Promise.resolve({ presentBytes: 0, verifiedBytes: 0, complete: false })),
			otherModels: vi.fn(() => Promise.resolve({ present: false, bytes: 0 })),
			deleteModels: vi.fn(() => Promise.resolve()),
			download: vi.fn(() => Promise.resolve({ ok: true as const, value: null })),
			cancelDownload: vi.fn(),
			importChunk: vi.fn(() => Promise.resolve({ ok: true as const, value: "more" as const })),
			load: vi.fn(),
			generate: vi.fn(() => Promise.resolve({ ok: true as const, value: { content: "", toolCalls: [] } })),
			cancel: vi.fn(),
			unload: vi.fn(() => Promise.resolve()),
			release: vi.fn(),
			pageGone: vi.fn(),
			stop: vi.fn(),
			wipe: vi.fn()
		} satisfies AssistantService

		registerAssistantIpc(ipc, service, url => url?.startsWith(APP) === true)

		const event = (url = APP): IpcEvent => ({ senderFrame: { url }, sender: { id: 1, send: vi.fn(), isDestroyed: () => false } })
		const invoke = async (name: AssistantCall, from: IpcEvent, ...args: unknown[]) => {
			const handler = handlers.get(assistantChannel(name))

			if (handler === undefined) {
				throw new Error(`no handler for ${name}`)
			}

			return await handler(from, ...args)
		}

		return { service, invoke, event, handlers }
	}

	it("registers every call, and answers the app's own page only", async () => {
		const { invoke, event, handlers, service } = wired()

		expect([...handlers.keys()].sort()).toEqual(ASSISTANT_CALLS.map(assistantChannel).sort())
		await expect(invoke("available", event("https://evil.example/"))).rejects.toThrow("untrusted sender")
		expect(service.available).not.toHaveBeenCalled()
	})

	it("keeps only a manifest's files, and refuses a name that escapes the models directory", async () => {
		const { invoke, event, service } = wired()

		await invoke("download", event(), { ...MODEL, label: "Test", license: { name: "MIT", url: "" } }, "https://cdn.example/gguf/")
		expect(service.download).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), MODEL, "https://cdn.example/gguf/")

		await expect(invoke("inspect", event(), { ...MODEL, id: ".." })).rejects.toThrow("invalid assistant payload")
		await expect(
			invoke("inspect", event(), { ...MODEL, shards: [{ file: "../m.gguf", size: 4, sha256: "a".repeat(64) }] })
		).rejects.toThrow("invalid assistant payload")
		await expect(invoke("deleteModels", event(), "..")).rejects.toThrow("invalid assistant payload")
	})

	it("takes an imported shard as bytes of at most 16 MiB a chunk, for a file the manifest names", async () => {
		const { invoke, event, service } = wired()

		await invoke("importChunk", event(), MODEL, "m.gguf", 0, new Uint8Array(8), true)
		expect(service.importChunk).toHaveBeenCalledWith(expect.anything(), MODEL, "m.gguf", 0, new Uint8Array(8), true)
		await expect(invoke("importChunk", event(), MODEL, "m.gguf", 0, new Uint8Array(16 * 1024 * 1024 + 1), false)).rejects.toThrow(
			"invalid assistant payload"
		)
		await expect(invoke("importChunk", event(), MODEL, "m.gguf", 0, "bytes", false)).rejects.toThrow("invalid assistant payload")
		await expect(invoke("importChunk", event(), MODEL, "m.gguf", -1, new Uint8Array(8), false)).rejects.toThrow(
			"invalid assistant payload"
		)
	})

	it("downloads from https (or a loopback dev server) only", async () => {
		const { invoke, event, service } = wired()

		await expect(invoke("download", event(), MODEL, "http://cdn.example/gguf/")).rejects.toThrow("invalid assistant payload")
		await expect(invoke("download", event(), MODEL, "file:///etc/")).rejects.toThrow("invalid assistant payload")
		await invoke("download", event(), MODEL, "http://localhost:5173/__assistant-model/")
		expect(service.download).toHaveBeenCalledTimes(1)
	})

	it("passes a generation request on only in the loop's shape", async () => {
		const { invoke, event, service } = wired()
		const request = {
			slot: "main",
			maxTokens: 64,
			toolChoice: "required",
			messages: [
				{ role: "system", content: "s" },
				{ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "list", arguments: "{}" }] },
				{ role: "tool", content: "[]", toolCallId: "c1" }
			],
			tools: [{ name: "list", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false } }]
		}

		await invoke("generate", event(), 7, request, true)
		expect(service.generate).toHaveBeenCalledWith(expect.anything(), 7, request, true)

		await expect(invoke("generate", event(), 7, { ...request, slot: "other" }, true)).rejects.toThrow("invalid assistant payload")
		await expect(invoke("generate", event(), 7, { ...request, path: "/etc/passwd" }, true)).rejects.toThrow("invalid assistant payload")
		await expect(invoke("generate", event(), -1, request, true)).rejects.toThrow("invalid assistant payload")
		await expect(invoke("generate", event(), 7, request)).rejects.toThrow("invalid assistant payload")
	})
})
