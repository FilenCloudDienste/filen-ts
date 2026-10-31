import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopSyncHostState } from "@filen/shared/desktop"
import { atomicFile, type AtomicFile } from "../main/atomicFile.ts"
import { reconcileMirror, shellPairId } from "../main/sync/mirror.ts"
import { mergeOverview } from "../main/sync/overview.ts"
import { heldRemotes, loadSyncStore, parseSyncState, type ShellPair } from "../main/sync/store.ts"
import type { NativePair, NativePairRuntime } from "../shared/nativeProtocol.ts"
import { shellPair as baseShellPair } from "./syncFakes.ts"

const REMOTE_A = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b"
const REMOTE_B = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
const REMOTE_C = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const LEGACY = "11111111-2222-4333-8444-555555555555"

function shellPair(overrides: Partial<ShellPair> = {}): ShellPair {
	return baseShellPair({ pairId: "1", name: "Work", localRoot: "/Users/u/Work", remoteRoot: REMOTE_A, createdAt: 1, ...overrides })
}

function enginePair(overrides: Partial<NativePair> = {}): NativePair {
	return {
		id: "1",
		localRoot: "/Users/u/Work",
		remoteRoot: REMOTE_A,
		mode: "twoWay",
		paused: false,
		firstPassCompleted: true,
		...overrides
	}
}

function runtimeOf(pair: NativePair, overrides: Partial<NativePairRuntime> = {}): NativePairRuntime {
	return {
		...pair,
		syncing: false,
		progress: null,
		transfers: [],
		lastSyncedAt: null,
		lastError: null,
		issues: { conflicts: 0, heldDeletions: 0, unsyncable: 0, failed: 0 },
		degraded: { local: false, remote: false },
		stage: null,
		halted: null,
		refused: null,
		...overrides
	}
}

describe("reconcileMirror", () => {
	it("engine is source of truth on ready", () => {
		const mirror = [
			shellPair({ pairId: "9", mode: "localBackup", paused: true }),
			shellPair({ pairId: "2", name: "Gone", localRoot: "/Users/u/Gone", remoteRoot: REMOTE_B })
		]
		const engine = [
			enginePair({ id: "1", mode: "twoWay", paused: false }),
			enginePair({ id: "3", localRoot: "/Volumes/Disk/Photos", remoteRoot: REMOTE_C })
		]

		const { pairs, readd } = reconcileMirror(mirror, engine, { reset: false, now: 50 })

		expect(readd).toEqual([])
		expect(pairs).toEqual([
			shellPair({ pairId: "1", mode: "twoWay", paused: false }),
			shellPair({ pairId: "3", name: "Photos", localRoot: "/Volumes/Disk/Photos", remoteRoot: REMOTE_C, createdAt: 50 })
		])
	})

	it("matches a verbatim Windows root and keeps the shell's fields", () => {
		const mirror = [shellPair({ localRoot: "C:\\Users\\u\\Work", name: "Mine", state: "review", notices: ["refusedLocalOverlap"] })]
		const engine = [enginePair({ id: "4", localRoot: "\\\\?\\C:\\Users\\u\\work" })]

		const { pairs } = reconcileMirror(mirror, engine, { reset: false, now: 0 })

		expect(pairs).toEqual([
			shellPair({
				pairId: "4",
				localRoot: "\\\\?\\C:\\Users\\u\\work",
				name: "Mine",
				state: "review",
				notices: ["refusedLocalOverlap"]
			})
		])
	})

	it("keeps a preparing pair preparing with the user's paused flag", () => {
		const mirror = [shellPair({ pairId: "1", legacyUuid: LEGACY, state: "preparing", paused: false })]

		const { pairs } = reconcileMirror(mirror, [enginePair({ id: "1", paused: true })], { reset: false, now: 0 })

		expect(pairs).toEqual(mirror)
	})

	it("reset re-adds paused with names kept", () => {
		const mirror = [
			shellPair({ pairId: "1", name: "Work", paused: true }),
			shellPair({ pairId: "2", name: "Review me", localRoot: "/Users/u/R", remoteRoot: REMOTE_B, state: "review" }),
			shellPair({ pairId: "3", name: "Already back", localRoot: "/Users/u/B", remoteRoot: REMOTE_C })
		]
		// A crash after re-adding one of them: it is matched, not re-added twice.
		const engine = [enginePair({ id: "1", localRoot: "/Users/u/B", remoteRoot: REMOTE_C, paused: true })]

		const { pairs, readd } = reconcileMirror(mirror, engine, { reset: true, now: 0 })

		expect(readd).toEqual([
			shellPair({ pairId: null, name: "Work", paused: true }),
			shellPair({ pairId: null, name: "Review me", localRoot: "/Users/u/R", remoteRoot: REMOTE_B, state: "review" })
		])
		expect(pairs.map(pair => [pair.name, pair.pairId])).toEqual([
			["Work", null],
			["Review me", null],
			["Already back", "1"]
		])
	})

	it("waiting and refused pairs survive", () => {
		const waiting = shellPair({ pairId: null, state: "waitingForRoot", legacyUuid: LEGACY, localRoot: "/Volumes/USB/Docs" })
		const unsupported = shellPair({ pairId: null, state: "unsupported", legacyUuid: REMOTE_B, notices: ["refusedRemoteMissing"] })

		expect(reconcileMirror([waiting, unsupported], [], { reset: false, now: 0 })).toEqual({ pairs: [waiting, unsupported], readd: [] })
		expect(reconcileMirror([waiting, unsupported], [], { reset: true, now: 0 })).toEqual({ pairs: [waiting, unsupported], readd: [] })

		// Once the engine holds it, it is an ordinary pair.
		const { pairs } = reconcileMirror([waiting], [enginePair({ id: "8", localRoot: "/Volumes/USB/Docs", paused: true })], {
			reset: false,
			now: 0
		})

		expect(pairs).toEqual([{ ...waiting, pairId: "8", state: "active", paused: true }])
	})
})

describe("shellPairId", () => {
	it("stands in for a missing engine id", () => {
		expect(shellPairId(shellPair())).toBe("1")
		expect(shellPairId(shellPair({ pairId: null, legacyUuid: LEGACY }))).toBe(`legacy:${LEGACY}`)
		expect(shellPairId(shellPair({ pairId: null }))).toBe(`remote:${REMOTE_A}`)
	})
})

describe("mergeOverview", () => {
	const host: DesktopSyncHostState = { state: "running" }

	it("phase precedence review > error > syncing > paused > idle", () => {
		const phase = (pair: ShellPair, live: Partial<NativePairRuntime> | null) =>
			mergeOverview(host, live === null ? [] : [runtimeOf(enginePair(), live)], [pair], null).pairs[0]?.phase

		expect(phase(shellPair({ state: "review" }), { lastError: "boom", syncing: true, paused: true })).toBe("review")
		expect(phase(shellPair(), { lastError: "boom", syncing: true, paused: true })).toBe("error")
		// An unreachable server is no error; paused, the pause is what shows.
		expect(phase(shellPair(), { lastError: "connect", halted: "offline" })).toBe("offline")
		expect(phase(shellPair(), { lastError: "connect", halted: "offline", paused: true })).toBe("paused")
		expect(phase(shellPair(), { lastError: "connect", halted: "offline", syncing: true })).toBe("syncing")
		expect(phase(shellPair(), { stage: { kind: "waitingForCloud" } })).toBe("waitingForCloud")
		expect(
			phase(shellPair(), { stage: { kind: "indexing", entries: 1, filesToHash: 1, bytesToHash: 1, filesHashed: 0, bytesHashed: 0 } })
		).toBe("indexing")
		expect(phase(shellPair(), { syncing: true, paused: true })).toBe("syncing")
		expect(phase(shellPair(), { paused: true })).toBe("paused")
		expect(phase(shellPair(), {})).toBe("idle")
		expect(phase(shellPair({ paused: true }), null)).toBe("paused")
		expect(phase(shellPair({ pairId: null, state: "waitingForRoot", legacyUuid: LEGACY }), null)).toBe("waitingForRoot")
		expect(phase(shellPair({ pairId: null, state: "unsupported", legacyUuid: LEGACY }), null)).toBe("unsupported")
	})

	it("merges live state over the stored pair", () => {
		const live = runtimeOf(enginePair({ mode: "localToRemote", paused: false }), {
			syncing: true,
			progress: { done: 2, total: 5 },
			transfers: [{ relPath: "a.bin", direction: "upload", bytes: 1, total: 2 }],
			lastSyncedAt: 99,
			issues: { conflicts: 1, heldDeletions: 0, unsyncable: 2, failed: 0 },
			degraded: { local: true, remote: false }
		})
		const overview = mergeOverview(host, [live], [shellPair({ paused: true, notices: ["refusedLocalOverlap"] })], {
			dropped: 1,
			merged: 0
		})

		expect(overview).toEqual({
			host,
			importNote: { dropped: 1, merged: 0 },
			pairs: [
				{
					id: "1",
					name: "Work",
					localRoot: "/Users/u/Work",
					remoteRoot: REMOTE_A,
					mode: "localToRemote",
					paused: false,
					phase: "syncing",
					progress: { done: 2, total: 5 },
					transfers: [{ relPath: "a.bin", direction: "upload", bytes: 1, total: 2 }],
					lastSyncedAt: 99,
					lastError: null,
					issues: { conflicts: 1, heldDeletions: 0, unsyncable: 2, failed: 0 },
					degraded: { local: true, remote: false },
					stage: null,
					halted: null,
					refused: null,
					review: null,
					notices: ["refusedLocalOverlap"],
					rootProblem: null,
					holds: [],
					info: []
				}
			]
		})
	})
})

describe("a crash between adding a pair to the engine and pausing it", () => {
	it("holds the pair back at the next start and gives it its engine id", () => {
		// What attach stored before addPair: the engine adds pairs unpaused.
		const stored = shellPair({ pairId: null, legacyUuid: LEGACY, state: "preparing" })
		const state = {
			version: 1,
			pairs: [stored, shellPair({ pairId: "2", remoteRoot: REMOTE_B })],
			legacyApplied: true,
			importNote: null
		} as const

		expect(heldRemotes({ ...state, pairs: [...state.pairs] })).toEqual([REMOTE_A])

		const { pairs } = reconcileMirror([stored], [enginePair({ id: "5", paused: false })], { reset: false, now: 0 })

		expect(pairs).toEqual([{ ...stored, pairId: "5" }])
	})
})

describe("sync store", () => {
	let dir: string
	let file: AtomicFile

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "filen-sync-store-"))
		file = atomicFile(path.join(dir, "shell.json"))
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	it("drops an invalid pair alone and starts empty on a damaged file", () => {
		const warn = vi.fn()
		const state = parseSyncState(
			JSON.stringify({ version: 1, pairs: [shellPair(), { ...shellPair(), pairId: 5 }], legacyApplied: true, importNote: null }),
			warn
		)

		expect(state).toEqual({ version: 1, pairs: [shellPair()], legacyApplied: true, importNote: null })
		expect(warn).toHaveBeenCalledTimes(1)

		const empty = { version: 1, pairs: [], legacyApplied: false, importNote: null }

		expect(parseSyncState("{", warn)).toEqual(empty)
		expect(parseSyncState(JSON.stringify({ version: 2, pairs: [] }), warn)).toEqual(empty)
		expect(parseSyncState(null, warn)).toEqual(empty)
	})

	it("writes updates in order and reads them back", async () => {
		const store = await loadSyncStore(file, vi.fn())

		expect(store.hasPairs()).toBe(false)

		const first = store.update(state => ({ ...state, pairs: [...state.pairs, shellPair()] }))
		const second = store.update(state => ({
			...state,
			pairs: [...state.pairs, shellPair({ pairId: "2", remoteRoot: REMOTE_B })],
			legacyApplied: true
		}))

		await Promise.all([first, second])
		expect(store.hasPairs()).toBe(true)
		expect(JSON.parse(await readFile(path.join(dir, "shell.json"), "utf8"))).toEqual(store.get())
		expect((await loadSyncStore(file, vi.fn())).get()).toEqual(store.get())
	})

	it("keeps the state when a write fails", async () => {
		await writeFile(
			path.join(dir, "shell.json"),
			JSON.stringify({ version: 1, pairs: [shellPair()], legacyApplied: false, importNote: null })
		)

		const store = await loadSyncStore(file, vi.fn())
		const failing: AtomicFile = { ...file, write: () => Promise.reject(new Error("EIO")) }
		const broken = await loadSyncStore(failing, vi.fn())

		await expect(broken.update(state => ({ ...state, pairs: [] }))).rejects.toThrow("EIO")
		expect(broken.get().pairs).toHaveLength(1)
		expect(store.get().pairs).toHaveLength(1)
	})
})
