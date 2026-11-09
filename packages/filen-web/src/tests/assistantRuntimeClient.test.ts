import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { QUARANTINE_CONTEXT_TOKENS, ROUTER_CONTEXT_TOKENS, ROUTER_SYSTEM_PROMPT } from "@filen/shared/assistant"
import type { ModelDownloadProgress } from "@/features/assistant/runtime/download"
import type { GenerationUpdate } from "@/features/assistant/runtime/engineMessages"
import type { ModelInspection } from "@/features/assistant/runtime/modelStore"
import type { AssistantModelState } from "@/features/assistant/types"

// The page side of the runtime against a scripted worker: the states the panel sees across a download, an
// explicit load, a start that finds a damaged shard, and the idle unload that frees the worker again.
const { remote, inspections, releaseProxy, workers, locks, prune, device, storage, stale, order, appUpdate } = vi.hoisted(() => ({
	releaseProxy: Symbol("releaseProxy"),
	remote: {
		download: vi.fn<(manifest: unknown, baseUrl: string, onProgress: (progress: ModelDownloadProgress) => void) => Promise<void>>(),
		load: vi.fn<
			(manifest: unknown, options: unknown, onVerifying: () => void) => Promise<{ specialTokens: string[]; promptBatchMs?: number }>
		>(),
		cancelDownload: vi.fn(),
		cancel: vi.fn(() => Promise.resolve()),
		unload: vi.fn<() => Promise<void>>(),
		reprime: vi.fn(() => Promise.resolve()),
		generate: vi.fn<
			(id: number, request: unknown, onUpdate?: (update: GenerationUpdate) => void) => Promise<{ content: string; toolCalls: [] }>
		>(() => Promise.resolve({ content: "", toolCalls: [] }))
	},
	// An Error fails that inspection.
	inspections: [] as (ModelInspection | Error)[],
	workers: [] as { terminate: Mock<() => void>; released: Mock<() => void>; fire: (type: string) => void }[],
	// Model locks currently held by this "tab", how often it was granted one, and whether another tab holds it;
	// `queued` lets the requests waiting behind that tab through once it lets go.
	locks: { held: 0, granted: 0, elsewhere: false, queued: [] as (() => void)[] },
	// The pruning of older model versions, when a test holds it open.
	prune: { pending: null as Promise<void> | null },
	// Whether WebGPU is offered, and whether the CPU path is.
	device: { gpu: true, cpu: true },
	// Whether the origin's storage is persistent, whether the rest of the model fits, the usage the room was
	// judged on, and localStorage.
	storage: { persisted: true, fits: true, judgedUsage: null as number | null, local: new Map<string, string>() },
	// Bytes of another model version on disk.
	stale: { bytes: 0 },
	// The order pruning, removal and the storage estimate ran in.
	order: [] as string[],
	// Whether the server still deploys this build, and how often it was asked.
	appUpdate: {
		recover: vi.fn(),
		prompt: vi.fn(),
		update: vi.fn(),
		deployment: "unknown",
		probes: 0
	}
}))

vi.mock("@/workers/assistant.worker.ts?worker", () => ({
	default: class {
		private readonly listeners = new Map<string, (() => void)[]>()
		readonly addEventListener = vi.fn((type: string, listener: () => void) => {
			this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
		})
		readonly terminate = vi.fn<() => void>()
		readonly released = vi.fn<() => void>()

		constructor() {
			workers.push(this)
		}

		fire(type: string): void {
			for (const listener of this.listeners.get(type) ?? []) {
				listener()
			}
		}
	}
}))

vi.mock("comlink", () => ({
	wrap: () => {
		const worker = workers.at(-1)

		return Object.assign({ [releaseProxy]: () => worker?.released() }, remote)
	},
	proxy: <T>(value: T) => value,
	releaseProxy
}))

vi.mock("@/lib/appUpdate", () => ({
	recoverIfNewerBuild: appUpdate.recover,
	showUpdateReadyToast: appUpdate.prompt,
	updateToNewerBuild: appUpdate.update,
	buildDeployment: () => {
		appUpdate.probes++

		return Promise.resolve(appUpdate.deployment)
	}
}))

// The signed-in account a download's opt-in is recorded for.
const account = vi.hoisted((): { id: bigint | undefined } => ({ id: 7n }))

vi.mock("@/queries/account", () => ({
	ACCOUNT_QUERY_KEY: ["account"],
	accountQueryGet: () => (account.id === undefined ? undefined : { id: account.id }),
	fetchAccount: () => Promise.reject(new Error("not signed in"))
}))

vi.mock("@/queries/client", () => ({
	queryClient: { query: ({ queryFn }: { queryFn: () => Promise<unknown> }) => queryFn() }
}))

vi.mock("@/features/assistant/runtime/deviceCheck", () => ({
	probeDevice: ({ gpu }: { gpu: boolean }) => Promise.resolve({ gpu }),
	recommendRuntime: ({ gpu }: { gpu: boolean }) =>
		gpu && device.gpu
			? { supported: true, backend: "webgpu", threads: 4, estimatedSpeed: "fast" }
			: device.cpu
				? { supported: true, backend: "cpu", threads: 4, estimatedSpeed: "moderate" }
				: { supported: false, reason: "unsupported-browser", detail: "", gpuCouldHelp: true },
	storageVerdict: ({ usage }: { usage: number }) => {
		storage.judgedUsage = usage

		return storage.fits ? { ok: true } : { ok: false, missingBytes: 1 }
	}
}))

vi.mock("@/features/assistant/runtime/modelStore", () => ({
	MODEL_LOCK: "filen-assistant-model",
	inspectModel: () => {
		const next = inspections.shift() ?? { presentBytes: 0, verifiedBytes: 0, complete: false }

		return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
	},
	deleteModels: () => {
		order.push("prune")
		stale.bytes = 0

		return prune.pending ?? Promise.resolve()
	},
	deleteModelDirectory: (id: string) => {
		order.push(`remove ${id}`)

		return Promise.resolve()
	},
	otherModels: () => Promise.resolve({ present: stale.bytes > 0, bytes: stale.bytes })
}))

const { ASSISTANT_CONTEXT_TOKENS, AssistantRuntime, IDLE_UNLOAD_MS } = await import("@/features/assistant/runtime/client")
const { QWEN35_4B } = await import("@/features/assistant/runtime/models")
const { manifestBytes } = await import("@/features/assistant/runtime/manifest")
const { readDownloadIntent, writeDownloadIntent, MAX_FRUITLESS_AUTO_STARTS } = await import("@/features/assistant/runtime/downloadIntent")

type Runtime = InstanceType<typeof AssistantRuntime>

const TOTAL = manifestBytes(QWEN35_4B)
const COMPLETE: ModelInspection = { presentBytes: TOTAL, verifiedBytes: TOTAL, complete: true }
const MINUTE = 60_000

// Whether the server still deploys this build ("unknown": unreachable).
function deployment(kind: "deployed" | "replaced" | "unknown"): void {
	appUpdate.deployment = kind
}

function stubBrowser(): void {
	vi.stubGlobal("navigator", {
		locks: {
			query: () => Promise.resolve({ held: locks.elsewhere ? [{ name: "filen-assistant-model" }] : [] }),
			request: (
				_name: string,
				options: { ifAvailable?: boolean } | ((lock: unknown) => unknown),
				maybeCallback?: (lock: unknown) => unknown
			) => {
				const callback = typeof options === "function" ? options : maybeCallback
				const ifAvailable = typeof options === "object" && options.ifAvailable === true

				if (callback === undefined) {
					return Promise.reject(new Error("no callback"))
				}

				if (locks.elsewhere) {
					// Queued behind the other tab until a test lets it go.
					return ifAvailable
						? Promise.resolve(callback(null))
						: new Promise(resolve => {
								locks.queued.push(() => {
									resolve(callback({}))
								})
							})
				}

				locks.held++
				locks.granted++
				void Promise.resolve(callback({})).then(() => {
					locks.held--
				})

				return Promise.resolve()
			}
		},
		storage: {
			persist: () => Promise.resolve(true),
			persisted: () => Promise.resolve(storage.persisted),
			estimate: () => {
				order.push("estimate")

				return Promise.resolve({ quota: 100 * TOTAL, usage: 0 })
			}
		}
	})
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.local.get(key) ?? null,
		setItem: (key: string, value: string) => storage.local.set(key, value),
		removeItem: (key: string) => storage.local.delete(key)
	})
}

function settled(runtime: Runtime, kind: AssistantModelState["kind"]): Promise<void> {
	return vi.waitFor(() => {
		expect(runtime.getState().kind).toBe(kind)
	})
}

// Under fake timers: lets the promise chains run without moving the clock.
async function until(check: () => boolean): Promise<void> {
	for (let i = 0; i < 50 && !check(); i++) {
		await vi.advanceTimersByTimeAsync(0)
	}

	expect(check()).toBe(true)
}

beforeEach(() => {
	stubBrowser()
	inspections.length = 0
	workers.length = 0
	locks.held = 0
	locks.granted = 0
	locks.elsewhere = false
	locks.queued.length = 0
	prune.pending = null
	stale.bytes = 0
	order.length = 0
	storage.persisted = true
	storage.fits = true
	storage.judgedUsage = null
	storage.local.clear()
	appUpdate.recover.mockClear()
	appUpdate.prompt.mockClear()
	appUpdate.update.mockClear()
	appUpdate.deployment = "unknown"
	appUpdate.probes = 0
	account.id = 7n
	device.gpu = true
	device.cpu = true
	remote.download.mockReset()
	remote.load.mockReset()
	remote.unload.mockReset()
	remote.unload.mockResolvedValue(undefined)
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe("AssistantRuntime download", () => {
	it("shows exact progress, never past the total, and stops at downloaded without loading", async () => {
		const states: AssistantModelState[] = []

		remote.download.mockImplementation((_manifest, _baseUrl, onProgress) => {
			onProgress({ receivedBytes: 1000, waiting: false })
			onProgress({ receivedBytes: 1000, waiting: true })
			// Never sent by the worker; the page holds the line anyway.
			onProgress({ receivedBytes: TOTAL + 50_000_000, waiting: false })

			return Promise.resolve()
		})

		const runtime = new AssistantRuntime()

		runtime.subscribe(state => states.push(state))
		runtime.setPanelOpen(true)
		runtime.download()
		await settled(runtime, "downloaded")
		await vi.waitFor(() => {
			expect(workers[0]?.terminate).toHaveBeenCalled()
		})

		const downloading = states.flatMap(state => (state.kind === "downloading" ? [state] : []))

		expect(downloading.map(state => state.receivedBytes)).toEqual([0, 1000, 1000, TOTAL])
		expect(downloading.map(state => state.waiting)).toEqual([false, false, true, false])
		expect(states.at(-1)).toMatchObject({ kind: "downloaded", idleUnloaded: false })
		expect(remote.load).not.toHaveBeenCalled()
		expect(locks.held).toBe(0)
	})

	it("reports a start that checks the files, and downloads again just the shards found damaged", async () => {
		const states: AssistantModelState[] = []

		inspections.push(
			COMPLETE,
			// after the failed start: one shard dropped, the rest still verified
			{ presentBytes: TOTAL - 500, verifiedBytes: TOTAL - 500, complete: false },
			// the download that follows
			{ presentBytes: TOTAL - 500, verifiedBytes: TOTAL - 500, complete: false }
		)
		remote.load
			.mockImplementationOnce((_manifest, _options, onVerifying) => {
				onVerifying()

				return Promise.reject(Object.assign(new Error("damaged"), { name: "ModelLoadError:missing" }))
			})
			.mockResolvedValue({ specialTokens: [] })
		remote.download.mockImplementation((_manifest, _baseUrl, onProgress) => {
			onProgress({ receivedBytes: TOTAL, waiting: false })

			return Promise.resolve()
		})

		const runtime = new AssistantRuntime()

		runtime.subscribe(state => states.push(state))
		await runtime.init()
		await runtime.load()
		await vi.waitFor(() => {
			expect(remote.download).toHaveBeenCalledTimes(1)
		})
		await settled(runtime, "downloaded")

		expect(states).toContainEqual(expect.objectContaining({ kind: "loading", verifying: true }))
		expect(states.find(state => state.kind === "downloading")).toMatchObject({ receivedBytes: TOTAL - 500 })

		await runtime.load()

		expect(runtime.getState().kind).toBe("ready")
	})

	it("shows downloaded only once its worker and lock are gone, so a load right after starts a fresh worker", async () => {
		let finishPrune: () => void = () => undefined
		let finishDownload: () => void = () => undefined

		prune.pending = new Promise(resolve => {
			finishPrune = () => {
				resolve()
			}
		})
		remote.download.mockImplementation(
			(_manifest, _baseUrl, onProgress) =>
				new Promise(resolve => {
					onProgress({ receivedBytes: TOTAL - 1, waiting: true })
					finishDownload = () => {
						resolve()
					}
				})
		)
		remote.load.mockResolvedValue({ specialTokens: [] })
		deployment("deployed")
		stale.bytes = 2_700_000_000

		const runtime = new AssistantRuntime()

		runtime.download()
		await vi.waitFor(() => {
			expect(order).toEqual(["estimate", "prune"])
		})
		await new Promise(resolve => setTimeout(resolve, 10))

		// An earlier version is removed before anything is fetched.
		expect(remote.download).not.toHaveBeenCalled()

		finishPrune()
		await vi.waitFor(() => {
			expect(remote.download).toHaveBeenCalledTimes(1)
		})
		await runtime.load()

		expect(remote.load).not.toHaveBeenCalled()

		finishDownload()
		await settled(runtime, "downloaded")

		expect(workers[0]?.terminate).toHaveBeenCalled()

		await runtime.load()

		expect(runtime.getState().kind).toBe("ready")
		expect(workers).toHaveLength(2)
		expect(workers[1]?.terminate).not.toHaveBeenCalled()
		await vi.waitFor(() => {
			expect(locks.held).toBe(1)
		})
	})

	it("downloads from a click made before the startup check has settled", async () => {
		const persist = vi.spyOn(navigator.storage, "persist")

		remote.download.mockResolvedValue(undefined)

		const runtime = new AssistantRuntime()

		runtime.retry()

		expect(persist).toHaveBeenCalledTimes(1)

		await settled(runtime, "downloaded")

		expect(remote.download).toHaveBeenCalledTimes(1)
	})

	it("retries a failed startup check by running the check again, not by downloading", async () => {
		inspections.push(new Error("storage unreadable"), COMPLETE)

		const runtime = new AssistantRuntime()

		await runtime.init()

		expect(runtime.getState()).toMatchObject({ kind: "error", error: "load-failed" })

		runtime.retry()
		await settled(runtime, "downloaded")

		expect(remote.download).not.toHaveBeenCalled()
		expect(remote.load).not.toHaveBeenCalled()
	})
})

describe("AssistantRuntime explicit load", () => {
	it("never loads on the startup check or a panel restored open after a reload", async () => {
		inspections.push(COMPLETE)

		const runtime = new AssistantRuntime()

		runtime.setPanelOpen(true)
		await runtime.init()
		runtime.setPanelOpen(false)
		runtime.setPanelOpen(true)
		await new Promise(resolve => setTimeout(resolve, 10))

		expect(runtime.getState()).toMatchObject({ kind: "downloaded", idleUnloaded: false })
		expect(remote.load).not.toHaveBeenCalled()
		expect(workers).toHaveLength(0)
		expect(locks.held).toBe(0)
	})

	it("loads on request, once for concurrent requests, holding the lock while loaded", async () => {
		inspections.push(COMPLETE)
		remote.load.mockResolvedValue({ specialTokens: ["<|im_end|>"] })

		const runtime = new AssistantRuntime()

		await runtime.init()
		await Promise.all([runtime.load(), runtime.load()])

		expect(runtime.getState().kind).toBe("ready")
		expect(runtime.specialTokens).toEqual(["<|im_end|>"])
		expect(remote.load).toHaveBeenCalledTimes(1)
		// The worker reads the router's fixed system turn ahead, so each router request reads only its user turn.
		// The engine's cache holds the router's and the extraction's prompts beside the main loop's.
		expect(remote.load.mock.calls[0]?.[1]).toMatchObject({
			primeSystem: ROUTER_SYSTEM_PROMPT,
			contextTokens: ASSISTANT_CONTEXT_TOKENS + ROUTER_CONTEXT_TOKENS + QUARANTINE_CONTEXT_TOKENS
		})
		expect(workers).toHaveLength(1)
		expect(locks.held).toBe(1)
	})

	it("ignores a download asked for while the model is loaded, leaving it running", async () => {
		inspections.push(COMPLETE)
		remote.load.mockResolvedValue({ specialTokens: [] })

		const runtime = new AssistantRuntime()

		await runtime.init()
		await runtime.load()
		runtime.download()
		await new Promise(resolve => setTimeout(resolve, 10))

		expect(runtime.getState().kind).toBe("ready")
		expect(workers).toHaveLength(1)
		expect(workers[0]?.terminate).not.toHaveBeenCalled()
		expect(locks.held).toBe(1)
	})

	it("reads as in use elsewhere once the panel opens after another tab loaded the model", async () => {
		inspections.push(COMPLETE)

		const runtime = new AssistantRuntime()

		await runtime.init()

		expect(runtime.getState().kind).toBe("downloaded")

		locks.elsewhere = true
		runtime.setPanelOpen(true)
		await settled(runtime, "unavailable")

		expect(runtime.getState()).toMatchObject({ reason: "in-use-elsewhere" })
		expect(remote.load).not.toHaveBeenCalled()
	})

	it("re-checks the other tabs when the page with the panel open becomes visible again", async () => {
		const page = Object.assign(new EventTarget(), { visibilityState: "visible" })

		vi.stubGlobal("document", page)
		inspections.push(COMPLETE)

		const runtime = new AssistantRuntime()

		runtime.setPanelOpen(true)
		await settled(runtime, "downloaded")
		locks.elsewhere = true
		page.dispatchEvent(new Event("visibilitychange"))
		await settled(runtime, "unavailable")

		expect(runtime.getState()).toMatchObject({ reason: "in-use-elsewhere" })
	})

	it("loads nothing before the model is on disk, and claims nothing before its check answered", async () => {
		const runtime = new AssistantRuntime()

		expect(runtime.getState().kind).toBe("checking")

		await runtime.init()
		await runtime.load()

		expect(runtime.getState().kind).toBe("not-downloaded")
		expect(workers).toHaveLength(0)
		expect(locks.held).toBe(0)
	})
})

describe("AssistantRuntime idle unload", () => {
	async function loaded(): Promise<Runtime> {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		inspections.push(COMPLETE)
		remote.load.mockResolvedValue({ specialTokens: [] })

		const runtime = new AssistantRuntime()

		void runtime.init()
		await until(() => runtime.getState().kind === "downloaded")
		void runtime.load()
		await until(() => runtime.getState().kind === "ready")

		return runtime
	}

	it("unloads after the idle period with the panel open, freeing the worker and the lock", async () => {
		const runtime = await loaded()
		const worker = workers[0]

		runtime.setPanelOpen(true)
		await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS - 1)

		expect(runtime.getState().kind).toBe("ready")

		await vi.advanceTimersByTimeAsync(1)
		await until(() => locks.held === 0)

		expect(runtime.getState()).toMatchObject({ kind: "downloaded", idleUnloaded: true })
		expect(remote.unload).toHaveBeenCalledTimes(1)
		expect(worker?.released).toHaveBeenCalled()
		expect(worker?.terminate).toHaveBeenCalled()
		expect(runtime.specialTokens).toEqual([])
		await expect(
			runtime.generate({ messages: [], slot: "main", maxTokens: 1 }, { signal: new AbortController().signal })
		).rejects.toThrow("not loaded")
	})

	it("terminates the worker even when the engine never answers the unload", async () => {
		const runtime = await loaded()

		remote.unload.mockReturnValue(new Promise(() => undefined))
		await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS)

		expect(runtime.getState().kind).toBe("downloaded")

		await vi.advanceTimersByTimeAsync(1000)
		await until(() => locks.held === 0)

		expect(workers[0]?.terminate).toHaveBeenCalled()
	})

	it("postpones the unload while the user keeps typing", async () => {
		const runtime = await loaded()

		await vi.advanceTimersByTimeAsync(9 * MINUTE)
		runtime.touch()
		await vi.advanceTimersByTimeAsync(9 * MINUTE)
		runtime.touch()
		await vi.advanceTimersByTimeAsync(9 * MINUTE)

		expect(runtime.getState().kind).toBe("ready")

		await vi.advanceTimersByTimeAsync(MINUTE)

		expect(runtime.getState().kind).toBe("downloaded")
	})

	it("never unloads while a turn, a waiting card or a confirmed action holds it, and counts from the release", async () => {
		const runtime = await loaded()
		const turn = runtime.hold()
		const action = runtime.hold()

		await vi.advanceTimersByTimeAsync(3 * IDLE_UNLOAD_MS)
		turn()
		turn()
		await vi.advanceTimersByTimeAsync(3 * IDLE_UNLOAD_MS)

		expect(runtime.getState().kind).toBe("ready")

		action()
		await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS - 1)

		expect(runtime.getState().kind).toBe("ready")

		await vi.advanceTimersByTimeAsync(1)

		expect(runtime.getState().kind).toBe("downloaded")
	})

	it("unloads on time after a release no user activity caused, without priming the router for it", async () => {
		const runtime = await loaded()
		const turn = runtime.hold()

		remote.reprime.mockClear()
		await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS + 1)
		turn({ activity: false })
		await vi.advanceTimersByTimeAsync(0)

		expect(remote.reprime).not.toHaveBeenCalled()
		expect(runtime.getState()).toMatchObject({ kind: "downloaded", idleUnloaded: true })
	})

	it("has no countdown during a download, so a long one is never cut off", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		remote.download.mockReturnValue(new Promise(() => undefined))

		const runtime = new AssistantRuntime()

		runtime.download()
		await until(() => runtime.getState().kind === "downloading")
		await vi.advanceTimersByTimeAsync(3 * IDLE_UNLOAD_MS)

		expect(runtime.getState().kind).toBe("downloading")
		expect(workers[0]?.terminate).not.toHaveBeenCalled()
		expect(remote.unload).not.toHaveBeenCalled()
	})

	it("checks the deadline when the page becomes visible again, as after a sleep that held the timer back", async () => {
		const page = new EventTarget()

		vi.stubGlobal("document", page)

		const runtime = await loaded()

		vi.setSystemTime(Date.now() + IDLE_UNLOAD_MS + MINUTE)
		page.dispatchEvent(new Event("visibilitychange"))
		await until(() => runtime.getState().kind === "downloaded")

		expect(workers[0]?.terminate).toHaveBeenCalled()

		// The listener left with the model.
		const remove = vi.spyOn(page, "removeEventListener")

		void runtime.load()
		await until(() => runtime.getState().kind === "ready")
		await runtime.unload()

		expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function))
	})

	it("loads a fresh worker only after an unload in flight has let the old one go", async () => {
		const runtime = await loaded()
		let finishUnload: () => void = () => undefined

		remote.unload.mockReturnValue(
			new Promise(resolve => {
				finishUnload = () => {
					resolve()
				}
			})
		)
		await vi.advanceTimersByTimeAsync(IDLE_UNLOAD_MS)
		void runtime.load()
		await vi.advanceTimersByTimeAsync(0)

		expect(workers).toHaveLength(1)

		finishUnload()
		await until(() => runtime.getState().kind === "ready")

		expect(workers[0]?.terminate).toHaveBeenCalled()
		expect(workers).toHaveLength(2)
		// The lock passed straight from the old worker to the new one: never let go, so never taken again.
		expect(locks.held).toBe(1)
		expect(locks.granted).toBe(1)
	})

	it("an explicit unload does not read as an idle one", async () => {
		const runtime = await loaded()

		await runtime.unload()

		expect(runtime.getState()).toMatchObject({ kind: "downloaded", idleUnloaded: false })
	})
	it("hands the worker one update callback that routes text, progress and calls, and none when nobody listens", async () => {
		const runtime = await loaded()
		const seen: string[] = []

		remote.generate.mockImplementationOnce((_id, _request, onUpdate) => {
			onUpdate?.({ type: "progress", processed: 4, total: 8 })
			onUpdate?.({ type: "text", text: "Hi" })
			onUpdate?.({ type: "call", index: 0, name: "list_notes" })

			return Promise.resolve({ content: "Hi", toolCalls: [] })
		})

		await runtime.generate(
			{ messages: [], slot: "main", maxTokens: 1 },
			{
				signal: new AbortController().signal,
				onText: text => {
					seen.push(`text ${text}`)
				},
				onProgress: ({ processed, total }) => {
					seen.push(`progress ${String(processed)}/${String(total)}`)
				},
				onToolCall: ({ index, name }) => {
					seen.push(`call ${String(index)} ${name}`)
				}
			}
		)

		expect(seen).toEqual(["progress 4/8", "text Hi", "call 0 list_notes"])

		await runtime.generate({ messages: [], slot: "main", maxTokens: 1 }, { signal: new AbortController().signal })

		expect(remote.generate.mock.lastCall?.[2]).toBeUndefined()
	})

	it("drops an update that arrives after the generation settled", async () => {
		const runtime = await loaded()
		const seen: string[] = []
		let late: ((update: GenerationUpdate) => void) | undefined

		remote.generate.mockImplementationOnce((_id, _request, onUpdate) => {
			late = onUpdate

			return Promise.resolve({ content: "Hi", toolCalls: [] })
		})

		await runtime.generate(
			{ messages: [], slot: "main", maxTokens: 1 },
			{
				signal: new AbortController().signal,
				onText: text => {
					seen.push(text)
				},
				onToolCall: ({ name }) => {
					seen.push(name)
				}
			}
		)

		late?.({ type: "text", text: "Hi" })
		late?.({ type: "call", index: 0, name: "list_notes" })

		expect(late).toBeDefined()
		expect(seen).toEqual([])
	})

	it("ends a stopped generation at once, and replaces a worker that never winds it down", async () => {
		const runtime = await loaded()

		remote.generate.mockImplementationOnce(() => new Promise(() => undefined))

		const controller = new AbortController()
		const running = runtime.generate({ messages: [], slot: "main", maxTokens: 1 }, { signal: controller.signal })

		controller.abort()
		await expect(running).rejects.toMatchObject({ name: "AbortError" })
		expect(remote.cancel).toHaveBeenCalled()
		expect(runtime.getState().kind).toBe("ready")

		await vi.advanceTimersByTimeAsync(10_000)

		expect(runtime.getState().kind).toBe("downloaded")
		expect(workers[0]?.terminate).toHaveBeenCalled()
		expect(locks.held).toBe(0)
	})

	it("gives a stopped generation on the CPU path, whose prompt batches take seconds, longer to wind down", async () => {
		device.gpu = false

		const runtime = await loaded()

		remote.generate.mockImplementationOnce(() => new Promise(() => undefined))

		const controller = new AbortController()
		const running = runtime.generate({ messages: [], slot: "main", maxTokens: 1 }, { signal: controller.signal })

		controller.abort()
		await expect(running).rejects.toMatchObject({ name: "AbortError" })
		await vi.advanceTimersByTimeAsync(30_000)

		expect(runtime.getState().kind).toBe("ready")

		await vi.advanceTimersByTimeAsync(30_000)

		expect(runtime.getState().kind).toBe("downloaded")
	})

	it("asks the worker to prime the router again once the last turn let go, and not while one runs", async () => {
		const runtime = await loaded()
		const first = runtime.hold()
		const second = runtime.hold()

		remote.reprime.mockClear()
		first()

		expect(remote.reprime).not.toHaveBeenCalled()

		second()

		expect(remote.reprime).toHaveBeenCalledTimes(1)
	})

	it("leaves ready when the engine crashed while priming the router between turns", async () => {
		const runtime = await loaded()

		remote.reprime.mockRejectedValueOnce(Object.assign(new Error("crashed"), { name: "ModelRuntimeError:crashed" }))
		runtime.hold()()
		await until(() => runtime.getState().kind === "downloaded")

		expect(workers[0]?.terminate).toHaveBeenCalled()
		expect(locks.held).toBe(0)
	})

	it("waits for a stop as long as this engine's slowest prompt batch took, three times over", async () => {
		const runtime = await loaded()
		let gate: () => void = () => undefined

		vi.spyOn(performance, "now").mockImplementation(() => Date.now())
		remote.generate.mockImplementationOnce(
			(_id, _request, onUpdate) =>
				new Promise(resolve => {
					onUpdate?.({ type: "progress", processed: 0, total: 2048 })
					gate = () => {
						onUpdate?.({ type: "progress", processed: 512, total: 2048 })
						resolve({ content: "", toolCalls: [] })
					}
				})
		)
		const first = runtime.generate(
			{ messages: [], slot: "main", maxTokens: 1 },
			{ signal: new AbortController().signal, onProgress: () => undefined }
		)

		await vi.advanceTimersByTimeAsync(6_000)
		gate()
		await first

		remote.generate.mockImplementationOnce(() => new Promise(() => undefined))

		const controller = new AbortController()
		const stopped = runtime.generate({ messages: [], slot: "main", maxTokens: 1 }, { signal: controller.signal })

		controller.abort()
		await expect(stopped).rejects.toMatchObject({ name: "AbortError" })
		await vi.advanceTimersByTimeAsync(17_000)

		expect(runtime.getState().kind).toBe("ready")

		await vi.advanceTimersByTimeAsync(1_000)

		expect(runtime.getState().kind).toBe("downloaded")
		vi.restoreAllMocks()
	})

	it("waits for a stop in the first prompt after a load as long as the load's priming showed a batch takes", async () => {
		const runtime = await loaded()

		await runtime.unload()
		// A slow GPU: the priming read its prompt at 12 s per batch, beyond the plain 10 s wait.
		remote.load.mockResolvedValue({ specialTokens: [], promptBatchMs: 12_000 })
		void runtime.load()
		await until(() => runtime.getState().kind === "ready")
		remote.generate.mockImplementationOnce(() => new Promise(() => undefined))

		const controller = new AbortController()
		const stopped = runtime.generate({ messages: [], slot: "main", maxTokens: 1 }, { signal: controller.signal })

		controller.abort()
		await expect(stopped).rejects.toMatchObject({ name: "AbortError" })
		await vi.advanceTimersByTimeAsync(35_000)

		expect(runtime.getState().kind).toBe("ready")

		await vi.advanceTimersByTimeAsync(1_000)

		expect(runtime.getState().kind).toBe("downloaded")
	})

	it("rejects a generation in flight when its worker is stopped, so no turn waits forever", async () => {
		const runtime = await loaded()

		remote.generate.mockImplementationOnce(() => new Promise(() => undefined))

		const running = runtime
			.generate({ messages: [], slot: "main", maxTokens: 1 }, { signal: new AbortController().signal })
			.catch((e: unknown) => e)
		const unloading = runtime.unload()

		await vi.advanceTimersByTimeAsync(2_000)
		await unloading

		await expect(running).resolves.toMatchObject({ name: "WorkerClosedError" })
	})

	it("leaves ready after the engine crashed, so the next message loads it again", async () => {
		const runtime = await loaded()

		remote.generate.mockRejectedValueOnce(Object.assign(new Error("crashed"), { name: "ModelRuntimeError:crashed" }))

		await expect(
			runtime.generate({ messages: [], slot: "main", maxTokens: 1 }, { signal: new AbortController().signal })
		).rejects.toMatchObject({
			name: "ModelRuntimeError:crashed"
		})
		expect(runtime.getState().kind).toBe("downloaded")
		expect(workers[0]?.terminate).toHaveBeenCalled()
		expect(locks.held).toBe(0)
	})
})

describe("AssistantRuntime failures", () => {
	it("fails a load whose worker never started, releasing the lock", async () => {
		inspections.push(COMPLETE)
		remote.load.mockImplementation(() => new Promise(() => undefined))

		const runtime = new AssistantRuntime()

		await runtime.init()

		const loading = runtime.load()

		await vi.waitFor(() => {
			expect(workers).toHaveLength(1)
		})
		workers[0]?.fire("error")
		await loading

		expect(runtime.getState()).toMatchObject({ kind: "error", error: "load-failed" })
		expect(locks.held).toBe(0)
	})

	it("falls back to the CPU path once when WebGPU cannot load the model, and stays there", async () => {
		inspections.push(COMPLETE)
		remote.load.mockImplementationOnce(() => Promise.reject(Object.assign(new Error("gpu"), { name: "ModelLoadError:load-failed" })))
		remote.load.mockResolvedValue({ specialTokens: [] })

		const runtime = new AssistantRuntime()

		await runtime.init()
		await runtime.load()

		expect(runtime.getState().kind).toBe("ready")
		expect(remote.load.mock.calls.map(([, options]) => (options as { backend: string }).backend)).toEqual(["webgpu", "cpu"])
		expect(workers[0]?.terminate).toHaveBeenCalled()

		await runtime.unload()
		await runtime.load()

		expect((remote.load.mock.lastCall?.[1] as { backend: string }).backend).toBe("cpu")
	})

	it("offers an earlier model version's files for removal, counts them as room for this one, and prunes them as the download starts", async () => {
		deployment("deployed")
		stale.bytes = 2_700_000_000

		const runtime = new AssistantRuntime()

		await runtime.init()

		expect(runtime.getState()).toMatchObject({ kind: "not-downloaded", staleBytes: 2_700_000_000 })
		expect(runtime.getState()).not.toHaveProperty("partialBytes")

		remote.download.mockResolvedValue(undefined)
		runtime.download()
		await settled(runtime, "downloaded")

		expect(order).toEqual(["estimate", "prune"])
		// The estimate's usage (none here) less the earlier version's bytes, never below zero.
		expect(storage.judgedUsage).toBe(0)
		expect(appUpdate.update).not.toHaveBeenCalled()
	})

	it("keeps an earlier model version when the download does not start for want of room", async () => {
		deployment("deployed")
		stale.bytes = 2_700_000_000
		storage.fits = false

		const runtime = new AssistantRuntime()

		await runtime.init()
		runtime.download()
		await vi.waitFor(() => {
			expect(runtime.getState()).toMatchObject({ kind: "unavailable", reason: "insufficient-storage" })
		})

		expect(order).toEqual(["estimate"])
		expect(stale.bytes).toBe(2_700_000_000)
		expect(workers).toHaveLength(0)
	})

	it("from a replaced build, neither offers nor removes the newer build's model, and asks to update instead of downloading", async () => {
		deployment("replaced")
		stale.bytes = 2_700_000_000

		const runtime = new AssistantRuntime()

		await runtime.init()

		expect(runtime.getState()).toEqual({ kind: "not-downloaded", model: expect.anything() as unknown })
		// The server was asked once, and the tab updates on that answer.
		expect(appUpdate.update).toHaveBeenCalledTimes(1)
		expect(appUpdate.probes).toBe(1)

		runtime.download()
		await vi.waitFor(() => {
			expect(appUpdate.prompt).toHaveBeenCalledTimes(1)
		})

		expect(runtime.getState().kind).toBe("not-downloaded")
		expect(remote.download).not.toHaveBeenCalled()
		expect(workers).toHaveLength(0)
		expect(locks.held).toBe(0)

		await runtime.deleteModel()

		expect(order).toEqual([`remove ${QWEN35_4B.id}`])
		expect(stale.bytes).toBe(2_700_000_000)
	})

	it("keeps another model on disk while this build's deployment cannot be known", async () => {
		deployment("unknown")
		stale.bytes = 2_700_000_000

		const runtime = new AssistantRuntime()

		await runtime.init()

		expect(runtime.getState()).not.toHaveProperty("staleBytes")

		remote.download.mockResolvedValue(undefined)
		runtime.download()
		await settled(runtime, "downloaded")

		expect(order).toEqual(["estimate"])
		expect(stale.bytes).toBe(2_700_000_000)
		expect(storage.judgedUsage).toBe(0)
	})

	it("removes an earlier version kept at the download's start once the server answers as the download ends", async () => {
		stale.bytes = 2_700_000_000
		remote.download.mockImplementation(() => {
			deployment("deployed")

			return Promise.resolve()
		})

		const runtime = new AssistantRuntime()

		await runtime.init()
		runtime.download()
		await settled(runtime, "downloaded")

		expect(order).toEqual(["estimate", "prune"])
		expect(stale.bytes).toBe(0)
		expect(locks.held).toBe(0)
	})

	it("removes an earlier version left beside a complete model at the next start, under the lock", async () => {
		deployment("deployed")
		stale.bytes = 2_700_000_000
		inspections.push(COMPLETE)

		const runtime = new AssistantRuntime()

		await runtime.init()

		expect(runtime.getState().kind).toBe("downloaded")
		expect(order).toEqual(["prune"])
		expect(locks.granted).toBe(1)
		expect(locks.held).toBe(0)
	})

	it("keeps another model beside a complete one unless the server deploys this build, and asks nothing without one", async () => {
		inspections.push(COMPLETE)

		const runtime = new AssistantRuntime()

		await runtime.init()

		expect(appUpdate.probes).toBe(0)

		for (const kind of ["unknown", "replaced"] as const) {
			deployment(kind)
			stale.bytes = 2_700_000_000
			inspections.push(COMPLETE)

			const other = new AssistantRuntime()

			await other.init()

			expect(other.getState().kind).toBe("downloaded")
			expect(stale.bytes).toBe(2_700_000_000)
		}

		expect(order).toEqual([])
		expect(appUpdate.update).not.toHaveBeenCalled()
	})

	it("from a replaced build with no model on disk, asks to update instead of downloading the model it would use", async () => {
		deployment("replaced")

		const runtime = new AssistantRuntime()

		await runtime.init()

		// Nothing on disk at all: the startup check asks the server nothing.
		expect(appUpdate.probes).toBe(0)

		runtime.download()
		await vi.waitFor(() => {
			expect(appUpdate.prompt).toHaveBeenCalledTimes(1)
		})

		expect(runtime.getState()).toEqual({ kind: "not-downloaded", model: expect.anything() as unknown })
		expect(remote.download).not.toHaveBeenCalled()
		expect(workers).toHaveLength(0)
		expect(locks.held).toBe(0)
	})

	it("continues a part on disk without asking the server when no other model is there", async () => {
		deployment("replaced")
		inspections.push(
			{ presentBytes: 1000, verifiedBytes: 1000, complete: false },
			{ presentBytes: 1000, verifiedBytes: 1000, complete: false }
		)
		remote.download.mockResolvedValue(undefined)

		const runtime = new AssistantRuntime()

		await runtime.init()
		runtime.download()
		await settled(runtime, "downloaded")

		expect(appUpdate.probes).toBe(0)
		expect(remote.download).toHaveBeenCalledTimes(1)
	})

	it("removes every model from a deployed build, its own and earlier versions", async () => {
		deployment("deployed")
		stale.bytes = 2_700_000_000

		const runtime = new AssistantRuntime()

		await runtime.init()
		await runtime.deleteModel()

		expect(order).toEqual(["prune"])
		expect(runtime.getState().kind).toBe("not-downloaded")
	})

	it("tries WebGPU again on the next load when the CPU path failed too, as it was not shown to be the GPU's fault", async () => {
		inspections.push(COMPLETE)
		remote.load.mockRejectedValueOnce(Object.assign(new Error("gpu"), { name: "ModelLoadError:load-failed" }))
		remote.load.mockRejectedValueOnce(Object.assign(new Error("cpu"), { name: "ModelLoadError:out-of-memory" }))
		remote.load.mockResolvedValue({ specialTokens: [] })

		const runtime = new AssistantRuntime()

		await runtime.init()
		await runtime.load()

		expect(runtime.getState()).toMatchObject({ kind: "error", error: "out-of-memory" })

		await runtime.load()

		expect(remote.load.mock.calls.map(([, options]) => (options as { backend: string }).backend)).toEqual(["webgpu", "cpu", "webgpu"])
		expect(runtime.getState().kind).toBe("ready")
	})

	it("says how much a stopped download left on disk, so it can be removed", async () => {
		const partial: ModelInspection = { presentBytes: 1000, verifiedBytes: 0, complete: false }

		inspections.push(
			{ presentBytes: 0, verifiedBytes: 0, complete: false },
			{ presentBytes: 0, verifiedBytes: 0, complete: false },
			partial
		)
		remote.download.mockRejectedValue(Object.assign(new Error("stopped"), { name: "AbortError" }))

		const runtime = new AssistantRuntime()

		await runtime.init()
		runtime.download()
		await vi.waitFor(() => {
			expect(runtime.getState()).toMatchObject({ kind: "not-downloaded", partialBytes: 1000 })
		})
	})

	it("frees the worker and the lock at sign-out, and starts nothing afterwards", async () => {
		inspections.push(COMPLETE)
		remote.load.mockResolvedValue({ specialTokens: [] })

		const runtime = new AssistantRuntime()

		await runtime.init()
		await runtime.load()
		runtime.shutdown()

		expect(workers[0]?.terminate).toHaveBeenCalled()
		await vi.waitFor(() => {
			expect(locks.held).toBe(0)
		})

		runtime.download()
		await runtime.load()

		expect(workers).toHaveLength(1)
	})
})

// A download the user started and a reload, crash or closed tab cut off continues at the next start, only
// with its opt-in still recorded, part of it on disk, persistent storage and room for the rest.
describe("AssistantRuntime interrupted download", () => {
	const PARTIAL: ModelInspection = { presentBytes: 1000, verifiedBytes: 0, complete: false }

	function downloadingStates(states: readonly AssistantModelState[]) {
		return states.flatMap(state => (state.kind === "downloading" ? [state] : []))
	}

	// What a click on this account recorded before the page went away.
	function optedIn(overrides: Partial<{ modelId: string; account: string; autoStarts: number; presentBytes: number }> = {}): void {
		writeDownloadIntent({ modelId: QWEN35_4B.id, account: "7", autoStarts: 0, presentBytes: 0, ...overrides })
	}

	it("records the opt-in, for this account, only while its download runs", async () => {
		let finish: () => void = () => undefined

		remote.download.mockImplementation(
			() =>
				new Promise<void>(resolve => {
					finish = resolve
				})
		)

		const runtime = new AssistantRuntime()

		await runtime.init()

		expect(readDownloadIntent()).toBeNull()

		runtime.download()
		await settled(runtime, "downloading")

		expect(readDownloadIntent()).toEqual({ modelId: QWEN35_4B.id, account: "7", autoStarts: 0, presentBytes: 0 })

		finish()
		await settled(runtime, "downloaded")

		expect(readDownloadIntent()).toBeNull()
	})

	it.each([
		["cancelled", Object.assign(new Error("stopped"), { name: "AbortError" }), "not-downloaded"],
		["failed", new Error("network"), "error"]
	] as const)("forgets the opt-in once its download is %s", async (_label, failure, kind) => {
		inspections.push(PARTIAL, PARTIAL, PARTIAL)
		remote.download.mockRejectedValue(failure)

		const runtime = new AssistantRuntime()

		await runtime.init()
		runtime.download()
		await settled(runtime, kind)

		expect(readDownloadIntent()).toBeNull()
	})

	it("continues the download on the next start without a click, says so, and asks the browser nothing", async () => {
		const states: AssistantModelState[] = []
		const persist = vi.spyOn(navigator.storage, "persist")

		optedIn()
		inspections.push(PARTIAL, PARTIAL)
		remote.download.mockResolvedValue(undefined)

		const runtime = new AssistantRuntime()

		runtime.subscribe(state => states.push(state))
		runtime.resumeInterruptedDownload()
		await settled(runtime, "downloaded")

		expect(remote.download).toHaveBeenCalledTimes(1)
		expect(downloadingStates(states)[0]).toMatchObject({ receivedBytes: 1000, resumed: true })
		expect(downloadingStates(states).every(state => state.resumed)).toBe(true)
		expect(persist).not.toHaveBeenCalled()
		expect(readDownloadIntent()).toBeNull()
		expect(locks.held).toBe(0)
	})

	// The click's download runs in best-effort storage too; the room for the rest is what decides.
	it("continues into storage the browser did not make persistent", async () => {
		storage.persisted = false
		optedIn()
		inspections.push(PARTIAL, PARTIAL)
		remote.download.mockResolvedValue(undefined)

		const runtime = new AssistantRuntime()

		runtime.resumeInterruptedDownload()
		await settled(runtime, "downloaded")

		expect(remote.download).toHaveBeenCalledTimes(1)
	})

	it("marks a download started by a click as not resumed", async () => {
		const states: AssistantModelState[] = []

		remote.download.mockResolvedValue(undefined)

		const runtime = new AssistantRuntime()

		runtime.subscribe(state => states.push(state))
		runtime.download()
		await settled(runtime, "downloaded")

		expect(downloadingStates(states).length).toBeGreaterThan(0)
		expect(downloadingStates(states).some(state => state.resumed)).toBe(false)
	})

	it("touches neither the model's lock nor its files when no download was ever asked for", () => {
		const query = vi.spyOn(navigator.locks, "query")
		const request = vi.spyOn(navigator.locks, "request")

		inspections.push(PARTIAL)

		const runtime = new AssistantRuntime()

		runtime.resumeInterruptedDownload()

		expect(query).not.toHaveBeenCalled()
		expect(request).not.toHaveBeenCalled()
		// The startup check's inspection is still queued: nothing listed the files.
		expect(inspections).toHaveLength(1)
	})

	const notAsked: [string, () => void, ModelInspection][] = [
		["the user never started one", () => undefined, PARTIAL],
		[
			"it belongs to another model",
			() => {
				optedIn({ modelId: "another-model" })
			},
			PARTIAL
		],
		[
			"nothing of it is on disk",
			() => {
				optedIn()
			},
			{ presentBytes: 0, verifiedBytes: 0, complete: false }
		],
		[
			"another account asked for it",
			() => {
				optedIn({ account: "8" })
			},
			PARTIAL
		],
		[
			"the signed-in account is unknown",
			() => {
				optedIn()
				account.id = undefined
			},
			PARTIAL
		]
	]

	it.each(notAsked)("starts nothing when %s", async (_label, arrange, inspection) => {
		arrange()
		// The startup check, and what a download would find as it started.
		inspections.push(inspection, inspection)

		const runtime = new AssistantRuntime()

		runtime.resumeInterruptedDownload()
		await runtime.init()
		// Past a download's start, had there been one.
		await new Promise(resolve => setTimeout(resolve, 20))

		expect(runtime.getState().kind).toBe("not-downloaded")
		expect(remote.download).not.toHaveBeenCalled()
		expect(workers).toHaveLength(0)
		expect(locks.held).toBe(0)
	})

	it("keeps the opt-in for the next start when the account cannot be read", async () => {
		optedIn()
		account.id = undefined
		inspections.push(PARTIAL, PARTIAL)

		const runtime = new AssistantRuntime()

		runtime.resumeInterruptedDownload()
		await vi.waitFor(() => {
			expect(locks.granted).toBe(1)
			expect(locks.held).toBe(0)
		})

		expect(remote.download).not.toHaveBeenCalled()
		expect(readDownloadIntent()).toMatchObject({ modelId: QWEN35_4B.id, account: "7" })
	})

	it("forgets another account's opt-in instead of keeping it for later", async () => {
		optedIn({ account: "8" })
		inspections.push(PARTIAL, PARTIAL)

		const runtime = new AssistantRuntime()

		runtime.resumeInterruptedDownload()
		await vi.waitFor(() => {
			expect(locks.granted).toBe(1)
			expect(locks.held).toBe(0)
		})

		expect(readDownloadIntent()).toBeNull()
	})

	it("waits for a click when the rest no longer fits, without reading as unavailable", async () => {
		optedIn()
		storage.fits = false
		inspections.push(PARTIAL, PARTIAL)

		const runtime = new AssistantRuntime()

		runtime.resumeInterruptedDownload()
		await vi.waitFor(() => {
			expect(locks.granted).toBe(1)
			expect(locks.held).toBe(0)
		})

		expect(runtime.getState()).toMatchObject({ kind: "not-downloaded", partialBytes: 1000 })
		expect(remote.download).not.toHaveBeenCalled()
		expect(workers).toHaveLength(0)
		// Kept: the next start, with room again, still continues it.
		expect(readDownloadIntent()).toMatchObject({ modelId: QWEN35_4B.id, autoStarts: 0 })
	})

	// Each start is a new page; the download "takes the page down" by never settling before the next one.
	async function autoStart(inspection: ModelInspection): Promise<boolean> {
		const calls = remote.download.mock.calls.length

		inspections.push(inspection, inspection)

		const runtime = new AssistantRuntime()

		runtime.resumeInterruptedDownload()
		await runtime.init()
		await new Promise(resolve => setTimeout(resolve, 20))
		// The page dies with its download: its lock goes, the opt-in stays.
		locks.held = 0

		return remote.download.mock.calls.length > calls
	}

	it("stops continuing by itself after starts that found no progress, until a click", async () => {
		remote.download.mockImplementation(() => new Promise<void>(() => undefined))
		optedIn({ presentBytes: PARTIAL.presentBytes })

		for (let start = 0; start < MAX_FRUITLESS_AUTO_STARTS; start++) {
			expect(await autoStart(PARTIAL)).toBe(true)
		}

		expect(await autoStart(PARTIAL)).toBe(false)
		expect(readDownloadIntent()).toBeNull()
	})

	it("keeps continuing while each start finds more on disk", async () => {
		remote.download.mockImplementation(() => new Promise<void>(() => undefined))
		optedIn({ presentBytes: 0 })

		for (let start = 1; start <= MAX_FRUITLESS_AUTO_STARTS + 2; start++) {
			expect(await autoStart({ presentBytes: start * 1000, verifiedBytes: 0, complete: false })).toBe(true)
		}

		expect(readDownloadIntent()).toMatchObject({ autoStarts: 1, presentBytes: (MAX_FRUITLESS_AUTO_STARTS + 2) * 1000 })
	})

	// The tab holding the lock with an opt-in recorded is the one downloading: reloading or closing it must not
	// hand the download to this one, whose start has passed.
	it("leaves another tab's download there, and does not take it over once that tab lets go", async () => {
		optedIn()
		locks.elsewhere = true
		inspections.push(PARTIAL, PARTIAL)
		remote.download.mockResolvedValue(undefined)

		const runtime = new AssistantRuntime()

		runtime.resumeInterruptedDownload()
		await vi.waitFor(() => {
			expect(runtime.getState()).toMatchObject({ kind: "unavailable", reason: "in-use-elsewhere" })
		})

		locks.elsewhere = false

		for (const release of locks.queued.splice(0)) {
			release()
		}

		await vi.waitFor(() => {
			expect(runtime.getState()).toMatchObject({ kind: "not-downloaded", partialBytes: 1000 })
		})
		await new Promise(resolve => setTimeout(resolve, 20))

		expect(remote.download).not.toHaveBeenCalled()
		expect(workers).toHaveLength(0)
		// Asking again on this page changes nothing: the decision was made at its start.
		runtime.resumeInterruptedDownload()
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(remote.download).not.toHaveBeenCalled()
	})

	it("only shows the other tab's download when that tab won the race to continue it", async () => {
		optedIn()
		inspections.push(PARTIAL)

		const runtime = new AssistantRuntime()

		await runtime.init()
		// The other restored tab took the lock between this one's check and its start.
		locks.elsewhere = true
		runtime.resumeInterruptedDownload()
		await vi.waitFor(() => {
			expect(runtime.getState()).toMatchObject({ kind: "unavailable", reason: "in-use-elsewhere" })
		})

		locks.elsewhere = false
		inspections.push(PARTIAL)

		for (const release of locks.queued.splice(0)) {
			release()
		}

		await vi.waitFor(() => {
			expect(runtime.getState()).toMatchObject({ kind: "not-downloaded", partialBytes: 1000 })
		})
		await new Promise(resolve => setTimeout(resolve, 20))

		expect(remote.download).not.toHaveBeenCalled()
	})

	it("forgets the opt-in at sign-out and when the model is removed", async () => {
		const runtime = new AssistantRuntime()

		optedIn()
		await runtime.deleteModel()

		expect(readDownloadIntent()).toBeNull()

		optedIn()
		runtime.shutdown()

		expect(readDownloadIntent()).toBeNull()

		runtime.resumeInterruptedDownload()
		await runtime.init()

		expect(remote.download).not.toHaveBeenCalled()
	})
})
