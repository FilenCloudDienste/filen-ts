import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopAssistant, DesktopAssistantEvent } from "@filen/shared/desktop"
import type { ModelInspection } from "@/features/assistant/runtime/modelStore"

// The client in the desktop app: the model lives and runs in the native engine, the page's own engine (its worker,
// its OPFS copy) only when the native one runs on no backend here; that switch happens within the load that found
// it, and the model loads from the page's copy when there is one.

const { remote, opfs, bridge, listeners } = vi.hoisted(() => {
	const listeners = new Set<(event: DesktopAssistantEvent) => void>()

	return {
		listeners,
		remote: {
			load: vi.fn(() => Promise.resolve({ specialTokens: ["<|worker|>"] })),
			unload: vi.fn(() => Promise.resolve()),
			download: vi.fn(() => Promise.resolve()),
			cancelDownload: vi.fn(),
			cancel: vi.fn(() => Promise.resolve()),
			reprime: vi.fn(() => Promise.resolve()),
			generate: vi.fn(() => Promise.resolve({ content: "", toolCalls: [] }))
		},
		opfs: { inspection: null as ModelInspection | null },
		bridge: {
			available: vi.fn(() => Promise.resolve(true)),
			inspect: vi.fn(() => Promise.resolve({ presentBytes: 10, verifiedBytes: 10, complete: true })),
			otherModels: vi.fn(() => Promise.resolve({ present: false, bytes: 0 })),
			deleteModels: vi.fn(() => Promise.resolve()),
			download: vi.fn(() => Promise.resolve({ ok: true as const, value: null })),
			cancelDownload: vi.fn(),
			importChunk: vi.fn(() => Promise.resolve({ ok: true as const, value: "present" as const })),
			load: vi.fn<DesktopAssistant["load"]>(() =>
				Promise.resolve({ ok: true, value: { specialTokens: ["<|native|>"], backend: "metal" } })
			),
			generate: vi.fn(() => Promise.resolve({ ok: true as const, value: { content: "", toolCalls: [] } })),
			cancel: vi.fn(),
			unload: vi.fn(() => Promise.resolve()),
			release: vi.fn(),
			onEvent: vi.fn((callback: (event: DesktopAssistantEvent) => void) => {
				listeners.add(callback)

				return () => {
					listeners.delete(callback)
				}
			})
		} satisfies DesktopAssistant
	}
})

vi.mock("@/lib/desktop", () => ({ desktopAssistant: () => bridge }))
vi.mock("@/workers/assistant.worker.ts?worker", () => ({
	default: class {
		addEventListener = vi.fn()
		terminate = vi.fn()
	}
}))
vi.mock("comlink", () => ({
	wrap: () => Object.assign({ [Symbol.for("release")]: () => undefined }, remote),
	proxy: <T>(value: T) => value,
	releaseProxy: Symbol.for("release")
}))
vi.mock("@/lib/appUpdate", () => ({
	recoverIfNewerBuild: vi.fn(),
	showUpdateReadyToast: vi.fn(),
	updateToNewerBuild: vi.fn(),
	buildDeployment: () => Promise.resolve("deployed")
}))
vi.mock("@/queries/account", () => ({
	ACCOUNT_QUERY_KEY: ["account"],
	accountQueryGet: () => ({ id: 7n }),
	fetchAccount: () => Promise.reject(new Error("not signed in"))
}))
vi.mock("@/queries/client", () => ({ queryClient: { query: () => Promise.reject(new Error("unused")) } }))
vi.mock("@/features/assistant/runtime/deviceCheck", () => ({
	probeDevice: ({ gpu }: { gpu: boolean }) => Promise.resolve({ gpu }),
	recommendRuntime: ({ gpu }: { gpu: boolean }) =>
		gpu
			? { supported: true, backend: "webgpu", threads: 4, estimatedSpeed: "fast" }
			: { supported: true, backend: "cpu", threads: 4, estimatedSpeed: "moderate" }
}))
vi.mock("@/features/assistant/runtime/modelStore", () => ({
	MODEL_LOCK: "filen-assistant-model",
	inspectModel: () => Promise.resolve(opfs.inspection ?? { presentBytes: 0, verifiedBytes: 0, complete: false }),
	deleteModels: () => Promise.resolve(),
	deleteModelDirectory: () => Promise.resolve(),
	otherModels: () => Promise.resolve({ present: false, bytes: 0 })
}))

function stubBrowser(): void {
	vi.stubGlobal("navigator", {
		locks: {
			query: () => Promise.resolve({ held: [] }),
			request: (_name: string, options: unknown, maybeCallback?: (lock: unknown) => unknown) => {
				const callback = typeof options === "function" ? (options as (lock: unknown) => unknown) : maybeCallback

				void Promise.resolve(callback?.({}))

				return Promise.resolve()
			}
		},
		storage: { persist: () => Promise.resolve(true), persisted: () => Promise.resolve(true) }
	})
	vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined, removeItem: () => undefined })
}

beforeEach(() => {
	vi.resetModules()
	stubBrowser()
	opfs.inspection = null
	listeners.clear()
	bridge.load.mockClear()
	bridge.release.mockClear()
	remote.load.mockClear()
})

async function runtime() {
	const { AssistantRuntime } = await import("@/features/assistant/runtime/client")

	return new AssistantRuntime()
}

describe("assistant runtime in the desktop app", () => {
	it("reads the native model and loads it in the native engine, never the page's worker", async () => {
		const assistant = await runtime()

		await assistant.init()
		expect(assistant.getState().kind).toBe("downloaded")
		await assistant.load()

		expect(assistant.getState().kind).toBe("ready")
		expect(assistant.specialTokens).toEqual(["<|native|>"])
		expect(bridge.load).toHaveBeenCalledOnce()
		expect(remote.load).not.toHaveBeenCalled()
	})

	it("falls back to the page's own engine and its copy of the model when no native backend runs", async () => {
		bridge.load.mockResolvedValueOnce({ ok: false, error: "unavailable", message: "no backend" })
		opfs.inspection = { presentBytes: 10, verifiedBytes: 10, complete: true }

		const assistant = await runtime()

		await assistant.init()
		await assistant.load()

		expect(bridge.release).toHaveBeenCalled()
		expect(remote.load).toHaveBeenCalledOnce()
		expect(assistant.getState().kind).toBe("ready")
		expect(assistant.specialTokens).toEqual(["<|worker|>"])
	})

	it("offers the page's own download after the fallback when the page has no copy", async () => {
		bridge.load.mockResolvedValueOnce({ ok: false, error: "unavailable", message: "no backend" })

		const assistant = await runtime()

		await assistant.init()
		await assistant.load()

		expect(remote.load).not.toHaveBeenCalled()
		expect(assistant.getState().kind).toBe("not-downloaded")
	})

	it("keeps the native engine for an out-of-memory load: the page's engine would not have more", async () => {
		bridge.load.mockResolvedValueOnce({ ok: false, error: "out-of-memory", message: "oom" })
		opfs.inspection = { presentBytes: 10, verifiedBytes: 10, complete: true }

		const assistant = await runtime()

		await assistant.init()
		await assistant.load()

		expect(remote.load).not.toHaveBeenCalled()
		expect(assistant.getState()).toMatchObject({ kind: "error", error: "out-of-memory" })
	})
})
