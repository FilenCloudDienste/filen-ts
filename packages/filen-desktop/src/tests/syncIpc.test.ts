import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopSyncHostState, DesktopSyncPlanSummary } from "@filen/shared/desktop"
import { CHANNELS, syncChannel, type SyncCall } from "../shared/channels.ts"
import type { NativeOp, NativeOpArgs, NativePlanSummary } from "../shared/nativeProtocol.ts"
import { createActivityLog } from "../main/sync/activity.ts"
import { registerSyncIpc, type SyncIpcEvent, type SyncIpcMain } from "../main/sync/ipc.ts"
import { createRootTokens, ROOT_TOKEN_TTL_MS } from "../main/sync/localRoot.ts"
import { createSyncService, OVERVIEW_PUSH_INTERVAL_MS, type SyncServiceDeps } from "../main/sync/service.ts"
import type { ShellPair } from "../main/sync/store.ts"
import { memoryStore } from "./syncFakes.ts"

const ACCOUNT_ROOT = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b"
const REMOTE = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
const APP = "filen://app/"

const SUMMARY: DesktopSyncPlanSummary = {
	actions: 3,
	uploadBytes: 10,
	downloadBytes: 0,
	heldDeletions: 0,
	heldReason: null,
	conflicts: 0,
	unsyncable: 0,
	ignored: 0,
	refused: null
}

function shellPair(overrides: Partial<ShellPair> = {}): ShellPair {
	return {
		pairId: "7",
		name: "Work",
		localRoot: "/Users/u/Work",
		remoteRoot: REMOTE,
		mode: "twoWay",
		paused: false,
		state: "active",
		review: null,
		legacyUuid: null,
		legacyDotFiles: null,
		notices: [],
		createdAt: 1,
		...overrides
	}
}

type Answers = { [K in NativeOp]?: ((args: NativeOpArgs<K>) => unknown) | undefined }

function setup(options: { pairs?: ShellPair[]; answers?: Answers; senderUrl?: string } = {}) {
	let clock = 1_000
	const store = memoryStore(options.pairs)
	const host: DesktopSyncHostState = { state: "running" }
	const answers: Answers = {
		addPair: () => ({ pairId: "7" }),
		pause: () => null,
		resume: () => null,
		removePair: () => null,
		setMode: () => null,
		requestPass: () => null,
		releasePlan: () => null,
		evaluatePlan: () => ({
			status: "ok",
			planId: "plan-1",
			summary: { ...SUMMARY, passToken: null } satisfies NativePlanSummary,
			check: null
		}),
		...options.answers
	}
	const call = vi.fn((op: NativeOp, args: unknown) => {
		const answer = answers[op] as ((args: unknown) => unknown) | undefined

		return Promise.resolve(answer === undefined ? { ok: false, error: { code: "unknown" } } : { ok: true, value: answer(args) })
	})
	const supervisor = {
		call: call as unknown as SyncServiceDeps["supervisor"]["call"],
		subscribe: vi.fn(),
		ensure: vi.fn(),
		retry: vi.fn(),
		user: () => Promise.resolve({ userId: "1", rootUuid: ACCOUNT_ROOT }),
		state: () => host
	}
	const tokens = createRootTokens(() => clock)
	const service = createSyncService({
		supervisor,
		storeFor: () => Promise.resolve(store),
		tokens,
		dialogs: {
			showOpenDialog: () => Promise.reject(new Error("unused")),
			rootContext: () => ({ platform: process.platform, home: "/nonexistent-home", appData: [], temporary: [], oneDrive: [] })
		},
		shell: { openPath: vi.fn(() => Promise.resolve("")) },
		legacySync: { pending: () => Promise.resolve(undefined), consume: () => Promise.resolve() },
		now: () => clock,
		log: { info: vi.fn(), warn: vi.fn() }
	})
	const handlers = new Map<string, (event: SyncIpcEvent, ...args: unknown[]) => unknown>()
	const listeners = new Map<string, (event: SyncIpcEvent, ...args: unknown[]) => void>()
	const ipc: SyncIpcMain = {
		handle: (channel, listener) => {
			handlers.set(channel, listener)
		},
		on: (channel, listener) => {
			listeners.set(channel, listener)
		}
	}
	const sent: [string, unknown][] = []
	const event: SyncIpcEvent = {
		senderFrame: { url: options.senderUrl ?? APP },
		sender: {
			id: 3,
			send: (channel, payload) => {
				sent.push([channel, payload])
			},
			isDestroyed: () => false
		}
	}

	registerSyncIpc(ipc, service, url => url?.startsWith(APP) === true)

	return {
		service,
		store,
		tokens,
		call,
		supervisor,
		sent,
		advance: (ms: number) => {
			clock += ms
		},
		invoke: async (name: SyncCall, ...args: unknown[]) => {
			const handler = handlers.get(syncChannel(name))

			if (handler === undefined) {
				throw new Error(`no handler for ${name}`)
			}

			return handler(event, ...args)
		},
		subscribe: (on: unknown) => listeners.get(CHANNELS.syncSubscribe)?.(event, on),
		ops: () => call.mock.calls.map(([op]) => op)
	}
}

let directory: string

beforeEach(async () => {
	// Real, as stored pair roots are (macOS tmpdir is under the /var link).
	directory = await realpath(await mkdtemp(path.join(tmpdir(), "filen-sync-ipc-")))
})

afterEach(async () => {
	vi.useRealTimers()
	await rm(directory, { recursive: true, force: true })
})

function newPair(localRootId: string, overrides: Record<string, unknown> = {}) {
	return { localRootId, remoteRoot: REMOTE, mode: "twoWay", name: "Work", ...overrides }
}

describe("registerSyncIpc", () => {
	it("rejects unknown/expired/reused root ids", async () => {
		const { invoke, tokens, advance, ops } = setup()

		expect(await invoke("addPair", newPair("0".repeat(32)))).toEqual({ ok: false, error: { code: "rootExpired" } })

		const expired = tokens.issue(directory)

		advance(ROOT_TOKEN_TTL_MS)
		expect(await invoke("addPair", newPair(expired))).toEqual({ ok: false, error: { code: "rootExpired" } })

		const id = tokens.issue(directory)

		expect(await invoke("addPair", newPair(id))).toMatchObject({ ok: true })
		expect(await invoke("addPair", newPair(id))).toEqual({ ok: false, error: { code: "rootExpired" } })
		expect(ops().filter(op => op === "addPair")).toHaveLength(1)
	})

	it("never takes a path from the page", async () => {
		const { invoke, ops } = setup()

		await expect(invoke("addPair", newPair(directory))).rejects.toThrow("invalid sync payload")
		await expect(invoke("addPair", { ...newPair("0".repeat(32)), localRoot: directory })).rejects.toThrow("invalid sync payload")
		await expect(invoke("reveal", "7", "root", directory)).rejects.toThrow("invalid sync payload")
		await expect(invoke("resolveConflict", "7", "a\0b", "keepBoth")).rejects.toThrow("invalid sync payload")
		expect(ops()).toEqual([])
	})

	it("rejects account root", async () => {
		const { invoke, tokens, ops } = setup()

		expect(await invoke("addPair", newPair(tokens.issue(directory), { remoteRoot: ACCOUNT_ROOT.toUpperCase() }))).toEqual({
			ok: false,
			error: { code: "accountRoot" }
		})
		expect(ops()).toEqual([])
	})

	it("re-checks the root when the pair is added", async () => {
		const { invoke, tokens, store } = setup({ pairs: [shellPair({ localRoot: directory })] })

		expect(await invoke("addPair", newPair(tokens.issue(path.join(directory, "missing"))))).toEqual({
			ok: false,
			error: { code: "rootRefused", message: "notDirectory" }
		})
		expect(await invoke("addPair", newPair(tokens.issue(directory)))).toEqual({
			ok: false,
			error: { code: "rootRefused", message: "insidePair" }
		})
		expect(store.get().pairs).toHaveLength(1)
	})

	it("addPair leaves the pair paused until startPair", async () => {
		const { invoke, tokens, store, ops, call } = setup()

		expect(await invoke("addPair", newPair(tokens.issue(directory), { name: "  Photos " }))).toEqual({
			ok: true,
			value: { pairId: "7", plan: { planId: "plan-1", summary: SUMMARY } }
		})
		expect(ops()).toEqual(["addPair", "pause", "evaluatePlan"])
		expect(call.mock.calls[0]?.[1]).toMatchObject({ remoteRoot: REMOTE, mode: "twoWay" })
		expect(store.get().pairs).toEqual([expect.objectContaining({ pairId: "7", name: "Photos", paused: true, state: "active" })])

		expect(await invoke("startPair", "7")).toEqual({ ok: true, value: null })
		expect(ops().at(-1)).toBe("resume")
		expect(store.get().pairs[0]?.paused).toBe(false)
	})

	it("a pair that cannot be planned is removed again", async () => {
		const { invoke, tokens, store, ops } = setup({ answers: { evaluatePlan: undefined } })

		expect(await invoke("addPair", newPair(tokens.issue(directory)))).toEqual({ ok: false, error: { code: "unknown" } })
		expect(ops()).toEqual(["addPair", "pause", "evaluatePlan", "removePair"])
		expect(store.get().pairs).toEqual([])
	})

	it("an unconverged remote adds the pair without a plan", async () => {
		const { invoke, tokens } = setup({ answers: { evaluatePlan: () => ({ status: "unconverged" }) } })

		expect(await invoke("addPair", newPair(tokens.issue(directory)))).toEqual({ ok: true, value: { pairId: "7", plan: null } })
	})

	it("setMode from backup requires backlog", async () => {
		const { invoke, ops, call, store } = setup({ pairs: [shellPair({ mode: "localBackup" })] })

		expect(await invoke("setMode", "7", "twoWay", null)).toEqual({ ok: false, error: { code: "modeConflict" } })
		expect(ops()).toEqual([])

		expect(await invoke("setMode", "7", "twoWay", "propagate")).toEqual({ ok: true, value: null })
		expect(call.mock.calls.map(([op, args]) => [op, args])).toEqual([
			["setMode", { pairId: "7", mode: "twoWay", backlog: "propagate" }],
			["requestPass", { pairId: "7" }]
		])
		expect(store.get().pairs[0]?.mode).toBe("twoWay")

		// Into a backup mode there is no backlog to decide.
		expect(await invoke("setMode", "7", "remoteBackup", "adoptDestination")).toEqual({ ok: true, value: null })
		expect(call.mock.calls.at(-2)?.[1]).toEqual({ pairId: "7", mode: "remoteBackup", backlog: null })
	})

	it("untrusted sender rejected", async () => {
		const { invoke, subscribe, supervisor, ops } = setup({ senderUrl: "https://example.com/" })

		await expect(invoke("overview")).rejects.toThrow("untrusted sender")
		await expect(invoke("removePair", "7")).rejects.toThrow("untrusted sender")
		subscribe(true)
		expect(supervisor.subscribe).not.toHaveBeenCalled()
		expect(ops()).toEqual([])
	})

	it("plans released on navigation", async () => {
		const { invoke, tokens, service, call } = setup()

		await invoke("addPair", newPair(tokens.issue(directory)))
		service.pageGone(4)
		expect(call).not.toHaveBeenCalledWith("releasePlan", expect.anything())

		service.pageGone(3)
		expect(call).toHaveBeenLastCalledWith("releasePlan", { planId: "plan-1" })
	})

	it("removes a pair the engine never held without asking it", async () => {
		const legacy = "11111111-2222-4333-8444-555555555555"
		const { invoke, store, ops, supervisor } = setup({
			pairs: [shellPair({ pairId: null, legacyUuid: legacy, state: "waitingForRoot" })]
		})

		expect(await invoke("pausePair", `legacy:${legacy}`)).toEqual({ ok: false, error: { code: "pairNotFound" } })
		expect(await invoke("removePair", `legacy:${legacy}`)).toEqual({ ok: true, value: null })
		expect(store.get().pairs).toEqual([])
		expect(ops()).toEqual([])
		expect(supervisor.ensure).toHaveBeenCalled()
	})

	it("a ready after a baseline reset re-adds the lost pairs paused through the guard", async () => {
		const { service, store, ops } = setup({ pairs: [shellPair({ localRoot: directory, name: "Mine" })] })

		await service.nativeEvent({ t: "ready", pairs: [], reset: true }, "1")

		expect(ops()).toEqual(["addPair", "pause", "evaluatePlan", "releasePlan", "resume"])
		expect(store.get().pairs).toEqual([shellPair({ localRoot: directory, name: "Mine" })])
	})

	it("dismissing a refusal removes the pair; other notices only go away", async () => {
		const legacy = "11111111-2222-4333-8444-555555555555"
		const { invoke, store } = setup({
			pairs: [
				shellPair({ notices: ["localTrashDropped"] }),
				shellPair({ pairId: null, legacyUuid: legacy, state: "unsupported", notices: ["refusedRemoteMissing"] })
			]
		})

		await invoke("dismissNotice", "7", "localTrashDropped")
		await invoke("dismissNotice", `legacy:${legacy}`, "refusedRemoteMissing")

		expect(store.get().pairs).toEqual([shellPair()])
	})

	it("reveals the root or the quarantine only", async () => {
		const { invoke, service } = setup({ pairs: [shellPair()] })

		expect(await invoke("reveal", "7", "quarantine")).toEqual({ ok: true, value: null })
		expect(await service.reveal("8", "root")).toEqual({ ok: false, error: { code: "pairNotFound" } })
		await expect(invoke("reveal", "7", "empty")).rejects.toThrow("invalid sync payload")
	})

	it("pushes the overview to subscribed pages at most four times a second", async () => {
		vi.useFakeTimers()

		const { subscribe, service, sent, supervisor } = setup({ pairs: [shellPair()] })

		subscribe(true)
		expect(supervisor.subscribe).toHaveBeenLastCalledWith(true)
		await vi.advanceTimersByTimeAsync(0)
		expect(sent).toHaveLength(1)

		for (let i = 0; i < 10; i++) {
			await service.nativeEvent({ t: "overview", pairs: [] }, "1")
		}

		await vi.advanceTimersByTimeAsync(OVERVIEW_PUSH_INTERVAL_MS)
		expect(sent.filter(([channel]) => channel === CHANNELS.syncOverview)).toHaveLength(2)

		subscribe(false)
		expect(supervisor.subscribe).toHaveBeenLastCalledWith(false)
		await service.nativeEvent({ t: "overview", pairs: [] }, "1")
		await vi.advanceTimersByTimeAsync(OVERVIEW_PUSH_INTERVAL_MS)
		expect(sent).toHaveLength(2)
	})

	it("numbers activity and keeps it per pair", async () => {
		const { invoke, service, subscribe, sent } = setup()

		subscribe(true)
		await service.nativeEvent(
			{
				t: "activity",
				entries: [
					{ pairId: "7", at: 1, kind: "uploaded", relPath: "a" },
					{ pairId: "8", at: 2, kind: "downloaded", relPath: "b" },
					{ pairId: "7", at: 3, kind: "passCompleted" }
				]
			},
			"1"
		)

		expect(await invoke("activity", "7", 10)).toEqual([
			{ seq: 2, pairId: "7", at: 3, kind: "passCompleted" },
			{ seq: 0, pairId: "7", at: 1, kind: "uploaded", relPath: "a" }
		])
		expect(sent.find(([channel]) => channel === CHANNELS.syncActivity)?.[1]).toHaveLength(3)
		await expect(invoke("activity", "7", 201)).rejects.toThrow("invalid sync payload")
	})
})

describe("createActivityLog", () => {
	it("keeps the latest entries per pair", () => {
		const log = createActivityLog(2)

		log.append([1, 2, 3].map(at => ({ pairId: "1", at, kind: "uploaded" as const })))

		expect(log.list("1", 10).map(entry => entry.at)).toEqual([3, 2])
	})
})
