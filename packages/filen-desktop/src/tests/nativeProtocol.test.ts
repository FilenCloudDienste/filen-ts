import { describe, expect, it } from "vitest"
import { type } from "arktype"
import type { DesktopMountsError, DesktopMountsStats, DesktopTransferError, DesktopVfsTuning } from "@filen/shared/desktop"
import {
	fromNativeSchema,
	isTransfersOp,
	mountsErrorSchema,
	NATIVE_OPS,
	type NativeMountsDesired,
	type NativeOp,
	opArgs,
	opError,
	opResult,
	SYNC_TRANSFERS_KEPT,
	toNativeSchema,
	transferErrorSchema,
	vfsTuningSchema
} from "../shared/nativeProtocol.ts"

const UUID = "3f2b8c1e-6a4d-4e2f-9b7a-1c5d8e9f0a2b"

function accepts(schema: (value: unknown) => unknown, value: unknown): boolean {
	return !(schema(value) instanceof type.errors)
}

const runtime = {
	id: "1",
	localRoot: "/Users/u/Documents",
	remoteRoot: UUID,
	mode: "twoWay",
	paused: false,
	syncing: true,
	progress: { done: 1, total: 4 },
	transfers: [{ relPath: "a.txt", direction: "upload", bytes: 10, total: 20 }],
	lastSyncedAt: null,
	lastError: null,
	issues: { conflicts: 0, heldDeletions: 2, unsyncable: 0, failed: 0 },
	degraded: { local: false, remote: false },
	stage: null,
	halted: null,
	refused: null
}

const TUNING: DesktopVfsTuning = { cacheMaxGiB: 32, cacheMinFreeGiB: 16, cacheMaxAgeHours: 720, dirCacheSeconds: 15 }

const BASIC = { kind: "basic", user: "filen-0a1b2c3d", password: "Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0" } as const

const DESIRED: NativeMountsDesired = {
	binary: { path: "/app/rclone/rclone", sha256: "a".repeat(64) },
	stateDir: "/data/mounts/1/state",
	cacheDir: "/data/mounts/1/cache",
	logFile: null,
	tuning: TUNING,
	drive: { mountPoint: "/Users/u/Filen", readOnly: false },
	serves: [
		{ protocol: "webdav", host: "127.0.0.1", port: 1900, auth: BASIC, tls: null, readOnly: false },
		{
			protocol: "s3",
			host: "192.168.1.20",
			port: 1800,
			auth: { kind: "s3", accessKeyId: "AKIA0123456789ABCDEF", secretAccessKey: "a".repeat(40) },
			tls: { cert: "/data/mounts/1/tls/s3.crt", key: "/data/mounts/1/tls/s3.key" },
			readOnly: true
		},
		{ protocol: "sftp", host: "::1", port: 2022, auth: BASIC, tls: null, readOnly: false },
		{ protocol: "nfs", host: "localhost", port: 2049, auth: { kind: "none" }, tls: null, readOnly: false }
	]
}

const STATUS = {
	roles: [
		{ role: "drive", state: "running", error: null },
		{ role: "webdav", state: "error", error: { code: "portInUse" } }
	],
	uploads: { pending: 2, errored: 0 }
}

const STATS: DesktopMountsStats = {
	transfers: [{ name: "Documents/a.pdf", bytes: 10, total: 20, speed: 5 }],
	uploadsInProgress: 1,
	uploadsQueued: 3
}

const MOUNTS_ARGS = {
	mountsApply: { desired: DESIRED },
	mountsStatus: {},
	mountsStats: {},
	driveLetters: {},
	cacheUsage: { dir: "/data/mounts/1/cache" },
	clearCache: { stateDir: "/data/mounts/1/state", dir: "/data/mounts/1/cache" },
	quiesceLegacy: { binDir: "/data/rclone/bin", mountPoints: ["/tmp/filen"] },
	drainCache: { binary: DESIRED.binary, stateDir: "/data/mounts/1/drain", dir: "/data/rclone-cache/webdav", timeoutMs: 1_800_000 }
}

const TRANSFER_ID = "6b1e9d2c-4a3f-4e5b-8c7d-0f1a2b3c4d5e"
const LISTING_ID = "8c2f0e3d-5b4a-4f6c-9d8e-1a2b3c4d5e6f"
const FILE_REF = { variant: "AnyFile.File", value: '{"uuid":"x"}' }
const DIR_REF = { variant: "AnyNormalDir.Dir", value: '{"uuid":"y"}' }

const SPECS = {
	downloadFile: { id: TRANSFER_ID, t: "downloadFile", file: FILE_REF, path: "/Users/u/Downloads/a.txt", conflict: "keepBoth" },
	downloadDirectory: { id: TRANSFER_ID, t: "downloadDirectory", dir: DIR_REF, path: "/Users/u/Downloads/d" },
	downloadListed: { id: TRANSFER_ID, t: "downloadListed", listingId: LISTING_ID, index: 3, path: "/tmp/drag/a.txt" },
	uploadFile: { id: TRANSFER_ID, t: "uploadFile", path: "/Users/u/a.txt", parent: DIR_REF },
	uploadDirectory: { id: TRANSFER_ID, t: "uploadDirectory", path: "/Users/u/d", parent: DIR_REF, name: "d" }
}

const TRANSFER_ARGS = {
	transfersStart: { specs: Object.values(SPECS) },
	transfersCancel: { ids: [TRANSFER_ID] },
	transfersPause: { ids: [TRANSFER_ID], paused: true },
	transfersListTree: { listingId: LISTING_ID, items: [{ ref: DIR_REF, name: "d" }], maxEntries: 2000 },
	transfersReleaseTree: { listingId: LISTING_ID }
}

// One valid call per op.
const ARGS: { [K in NativeOp]: unknown } = {
	listPairs: {},
	addPair: { localRoot: "/Users/u/Documents", remoteRoot: UUID, mode: "localBackup" },
	removePair: { pairId: "1" },
	pause: { pairId: "1" },
	resume: { pairId: "1" },
	setMode: { pairId: "1", mode: "twoWay", backlog: "adoptDestination" },
	requestPass: { pairId: "1" },
	awaitConverged: { pairId: "1" },
	evaluatePlan: { pairId: "1", check: true },
	planPage: { planId: "p1", list: "held", offset: 0, limit: 1000 },
	releasePlan: { planId: "p1" },
	conflicts: { pairId: "1", offset: 0, limit: 200 },
	resolveConflict: { pairId: "1", relPath: "d/a.txt", resolution: "keepBoth" },
	resolveConflicts: { pairId: "1", resolution: "keepLocal", relPaths: ["a.txt"] },
	heldDeletions: { pairId: "1" },
	approveDeletions: { pairId: "1", passToken: "token" },
	restoreDeletions: { pairId: "1", passToken: "token" },
	retryPath: { pairId: "1", relPath: "d/a.txt" },
	retryAll: { pairId: "1" },
	unsyncablePaths: { pairId: "1", offset: 0, limit: 1000 },
	setMigratedGuard: { pairId: "1" },
	ignoredPaths: { pairId: "1", offset: 0, limit: 1 },
	userIgnore: {},
	setUserIgnore: { text: ".*\n!/.filenignore\n" },
	defaultIgnore: {},
	...MOUNTS_ARGS,
	...TRANSFER_ARGS
}

const call = (op: string, args: unknown) => ({ t: "call", id: 7, op, args })

describe("toNativeSchema", () => {
	it("accepts every message kind", () => {
		expect(
			accepts(toNativeSchema, {
				t: "init",
				addonPath: "/app/native/sdk-rs.node",
				dir: "/data/sync-engine/1",
				session: "{}",
				logLevel: "Info",
				holdRemotes: [UUID]
			})
		).toBe(true)
		expect(accepts(toNativeSchema, { t: "subscribe", overview: true, mounts: false })).toBe(true)
		expect(accepts(toNativeSchema, { t: "shutdown" })).toBe(true)
		expect(accepts(toNativeSchema, { t: "reconnectSocket" })).toBe(true)
		expect(accepts(toNativeSchema, { t: "reconnectSocket", force: true })).toBe(false)

		for (const op of Object.keys(NATIVE_OPS) as NativeOp[]) {
			expect(accepts(toNativeSchema, call(op, ARGS[op])), op).toBe(true)
			expect(accepts(opArgs(op), ARGS[op]), op).toBe(true)
		}
	})

	it("rejects unknown op / extra keys / numeric pairId", () => {
		expect(accepts(toNativeSchema, call("deleteEverything", {}))).toBe(false)
		expect(accepts(toNativeSchema, { ...call("pause", { pairId: "1" }), extra: 1 })).toBe(false)
		expect(accepts(toNativeSchema, call("pause", { pairId: "1", extra: 1 }))).toBe(false)
		expect(accepts(toNativeSchema, call("evaluatePlan", { pairId: "1", check: { overwrites: true } }))).toBe(false)
		expect(accepts(toNativeSchema, { t: "shutdown", now: true })).toBe(false)
		expect(accepts(toNativeSchema, call("pause", { pairId: 1 }))).toBe(false)
		expect(accepts(toNativeSchema, call("pause", { pairId: "1n" }))).toBe(false)
		expect(accepts(toNativeSchema, call("pause", { pairId: "-1" }))).toBe(false)
		expect(accepts(toNativeSchema, call("pause", { pairId: "123456789012345678901" }))).toBe(false)
		expect(accepts(toNativeSchema, call("addPair", { localRoot: "/x", remoteRoot: "not-a-uuid", mode: "twoWay" }))).toBe(false)
		expect(accepts(toNativeSchema, call("addPair", { localRoot: "/x", remoteRoot: UUID, mode: "mirror" }))).toBe(false)
		expect(accepts(toNativeSchema, call("planPage", { planId: "p1", list: "held", offset: 0, limit: 1001 }))).toBe(false)
		expect(accepts(toNativeSchema, { ...call("pause", { pairId: "1" }), id: 1.5 })).toBe(false)
		expect(accepts(toNativeSchema, { t: "init", addonPath: "/a", dir: "/d", session: "", logLevel: "Info", holdRemotes: [] })).toBe(
			false
		)
		expect(
			accepts(toNativeSchema, { t: "init", addonPath: "/a", dir: "/d", session: "{}", logLevel: "Info", holdRemotes: ["/x"] })
		).toBe(false)
		expect(accepts(toNativeSchema, { t: "init", addonPath: "/a", dir: "/d", session: "{}", logLevel: "Trace" })).toBe(false)
	})

	it("relPath rejects NUL and > 4096", () => {
		const retry = (relPath: string) => accepts(toNativeSchema, call("retryPath", { pairId: "1", relPath }))

		expect(retry("d/a.txt")).toBe(true)
		expect(retry("a".repeat(4096))).toBe(true)
		expect(retry("a".repeat(4097))).toBe(false)
		expect(retry("d/a\0.txt")).toBe(false)
		expect(retry("")).toBe(false)
		expect(accepts(toNativeSchema, call("resolveConflict", { pairId: "1", relPath: "a\0", resolution: "keepLocal" }))).toBe(false)
	})
})

describe("fromNativeSchema", () => {
	it("accepts every message kind", () => {
		const messages = [
			{
				t: "ready",
				pairs: [
					{ id: "1", localRoot: "/Users/u/Documents", remoteRoot: UUID, mode: "twoWay", paused: true, firstPassCompleted: false }
				],
				reset: false
			},
			{ t: "reply", id: 1, ok: true, value: null },
			{ t: "reply", id: 1, ok: false, error: { code: "invalidIgnore", line: 3 } },
			{ t: "reply", id: 1, ok: false, error: { code: "localRootNested", pairId: "2", message: "nested" } },
			{ t: "overview", pairs: [runtime] },
			{ t: "overview", pairs: [{ ...runtime, stage: { kind: "waitingForCloud" }, halted: "offline", refused: "localCollision" }] },
			{
				t: "overview",
				pairs: [
					{
						...runtime,
						stage: { kind: "indexing", entries: 9, filesToHash: 3, bytesToHash: 30, filesHashed: 1, bytesHashed: 10 }
					}
				]
			},
			{ t: "aggregate", state: "attention" },
			{ t: "passEnded", pairId: "1" },
			{
				t: "activity",
				entries: [
					{ pairId: "1", at: 1, kind: "movedLocal", relPath: "a", to: "b" },
					{ pairId: "1", at: 2, kind: "passCompleted" }
				]
			},
			{ t: "authRevoked" },
			{ t: "fatal", reason: "baselineInUse" },
			{ t: "stopped" }
		]

		for (const message of messages) {
			expect(accepts(fromNativeSchema, message), message.t).toBe(true)
		}
	})

	it("rejects unknown kinds, codes and extra keys", () => {
		expect(accepts(fromNativeSchema, { t: "progress" })).toBe(false)
		expect(accepts(fromNativeSchema, { t: "stopped", code: 0 })).toBe(false)
		expect(accepts(fromNativeSchema, { t: "reply", id: 1, ok: false, error: { code: "boom" } })).toBe(false)
		expect(accepts(fromNativeSchema, { t: "reply", id: 1, ok: true, value: null, error: { code: "unknown" } })).toBe(false)
		expect(accepts(fromNativeSchema, { t: "overview", pairs: [{ ...runtime, id: 1 }] })).toBe(false)
		expect(accepts(fromNativeSchema, { t: "overview", pairs: [{ ...runtime, secret: "x" }] })).toBe(false)
		expect(accepts(fromNativeSchema, { t: "activity", entries: [{ pairId: "1", at: 1, kind: "passCompleted", relPath: "a\0" }] })).toBe(
			false
		)
	})
})

describe("overview transfers", () => {
	it("carries at most the transfers a pass can run at once", () => {
		const transfers = (count: number) =>
			Array.from({ length: count }, (_, index) => ({ relPath: `f${String(index)}`, direction: "download", bytes: 0, total: 1 }))

		expect(accepts(fromNativeSchema, { t: "overview", pairs: [{ ...runtime, transfers: transfers(SYNC_TRANSFERS_KEPT) }] })).toBe(true)
		expect(accepts(fromNativeSchema, { t: "overview", pairs: [{ ...runtime, transfers: transfers(SYNC_TRANSFERS_KEPT + 1) }] })).toBe(
			false
		)
	})
})

describe("opResult", () => {
	it("checks a reply's value against the op it answers", () => {
		expect(accepts(opResult("addPair"), { pairId: "5" })).toBe(true)
		expect(accepts(opResult("addPair"), { pairId: 5 })).toBe(false)
		expect(accepts(opResult("pause"), null)).toBe(true)
		expect(accepts(opResult("awaitConverged"), false)).toBe(true)
		expect(accepts(opResult("awaitConverged"), null)).toBe(false)
		expect(accepts(opResult("evaluatePlan"), { status: "unconverged" })).toBe(true)
		expect(
			accepts(opResult("evaluatePlan"), {
				status: "ok",
				planId: "p1",
				summary: {
					actions: 3,
					uploadBytes: 10,
					downloadBytes: 0,
					heldDeletions: 1,
					heldReason: "firstSyncWithDeletions",
					conflicts: 0,
					unsyncable: 0,
					ignored: 2,
					refused: null,
					passToken: "token"
				},
				check: { uploads: 1, downloads: 0, overwrites: { files: 1, bytes: 10 } }
			})
		).toBe(true)
		expect(
			accepts(opResult("planPage"), { list: "conflicts", total: 1, entries: [{ relPath: "a", local: "file", remote: null }] })
		).toBe(true)
		expect(
			accepts(opResult("planPage"), {
				list: "held",
				total: 1,
				entries: [{ relPath: "a", local: "file", remote: null }]
			})
		).toBe(false)
	})
})

describe("mounts", () => {
	const apply = (desired: unknown) => accepts(toNativeSchema, call("mountsApply", { desired }))
	const withServe = (patch: Record<string, unknown>, index = 0) =>
		apply({ ...DESIRED, serves: DESIRED.serves.map((serve, at) => (at === index ? { ...serve, ...patch } : serve)) })

	it("accepts every mounts message", () => {
		expect(apply({ ...DESIRED, drive: null, serves: [] })).toBe(true)
		expect(withServe({ host: "0.0.0.0" })).toBe(true)
		expect(withServe({ host: "fd00::5" })).toBe(true)

		for (const message of [
			{ t: "mounts", status: STATUS },
			{ t: "mounts", status: { roles: [], uploads: null } },
			{ t: "mountsStats", stats: STATS },
			{ t: "reply", id: 1, ok: false, error: { code: "fuseMissing" } },
			{ t: "reply", id: 1, ok: false, error: { code: "unknown", message: "rclone exited" } }
		]) {
			expect(accepts(fromNativeSchema, message), message.t).toBe(true)
		}

		expect(accepts(opResult("mountsApply"), STATUS)).toBe(true)
		expect(accepts(opResult("driveLetters"), ["D", "X", "Z"])).toBe(true)
		expect(accepts(opResult("quiesceLegacy"), { stopped: 1, unmounted: ["/tmp/filen"] })).toBe(true)
		expect(accepts(opResult("drainCache"), { pending: 0, errored: 0 })).toBe(true)
	})

	it("rejects an implicit address / port 0 / credentials with ':'", () => {
		expect(withServe({ host: "" })).toBe(false)
		expect(withServe({ host: ":1900" })).toBe(false)
		expect(withServe({ host: "my-mac.local" })).toBe(false)
		expect(withServe({ port: 0 })).toBe(false)
		expect(withServe({ port: 65536 })).toBe(false)
		expect(withServe({ auth: { ...BASIC, user: "a:b" } })).toBe(false)
		expect(withServe({ auth: { ...BASIC, password: "pa:ss" } })).toBe(false)
		expect(withServe({ auth: { ...BASIC, password: "pass\nword" } })).toBe(false)
		expect(withServe({ auth: { ...BASIC, password: "" } })).toBe(false)
		// Every protocol but nfs needs its own kind of credentials.
		expect(withServe({ auth: { kind: "none" } })).toBe(false)
		expect(withServe({ auth: BASIC }, 1)).toBe(false)
		expect(withServe({ auth: { kind: "s3", accessKeyId: "short", secretAccessKey: "a".repeat(40) } }, 1)).toBe(false)
		expect(withServe({ auth: { kind: "s3", accessKeyId: "AKIA0123456789ABCDEF", secretAccessKey: "a,b".repeat(8) } }, 1)).toBe(false)
		// nfs has no authentication, so it listens on loopback only.
		expect(withServe({ host: "192.168.1.20" }, 3)).toBe(false)
		expect(withServe({ auth: BASIC }, 3)).toBe(false)
		// TLS only where the protocol is HTTP.
		expect(withServe({ tls: { cert: "/c", key: "/k" } }, 2)).toBe(false)
		expect(apply({ ...DESIRED, serves: [DESIRED.serves[0], DESIRED.serves[0]] })).toBe(false)
		expect(apply({ ...DESIRED, binary: { path: "/r", sha256: "XYZ" } })).toBe(false)
		expect(apply({ ...DESIRED, tuning: { ...TUNING, cacheMaxGiB: 0 } })).toBe(false)
		expect(apply({ ...DESIRED, extra: true })).toBe(false)
		expect(accepts(toNativeSchema, call("quiesceLegacy", { binDir: "", mountPoints: [] }))).toBe(false)
		expect(
			accepts(fromNativeSchema, { t: "mounts", status: { ...STATUS, roles: [{ role: "dlna", state: "off", error: null }] } })
		).toBe(false)
		expect(accepts(opResult("driveLetters"), ["C"])).toBe(false)
		expect(accepts(toNativeSchema, { t: "subscribe", overview: true })).toBe(false)
	})

	it("an op's errors are its family's", () => {
		expect(accepts(opError("mountsApply"), { code: "portInUse" })).toBe(true)
		expect(accepts(opError("mountsApply"), { code: "pairNotFound" })).toBe(false)
		expect(accepts(opError("pause"), { code: "portInUse" })).toBe(false)
		expect(accepts(opError("pause"), { code: "hostUnavailable" })).toBe(true)
	})

	it("pinned types match the bridge", () => {
		const error: DesktopMountsError = { code: "driveLetterInUse", message: "X:" }

		expect(accepts(mountsErrorSchema, error)).toBe(true)
		expect(accepts(vfsTuningSchema, TUNING)).toBe(true)
		expect(accepts(opResult("mountsStats"), STATS)).toBe(true)
	})
})

describe("transfers", () => {
	const start = (specs: unknown[]) => accepts(toNativeSchema, call("transfersStart", { specs }))
	const spec = (kind: keyof typeof SPECS, patch: Record<string, unknown>) => start([{ ...SPECS[kind], ...patch }])
	const TREE_ENTRY = { segments: ["d", "a.txt"], directory: false, size: 10, mtimeMs: 1762819200000, listIndex: 0, source: 0 }

	it("accepts each transfer spec kind", () => {
		for (const value of Object.values(SPECS)) {
			expect(start([value]), value.t).toBe(true)
		}

		for (const op of Object.keys(TRANSFER_ARGS) as (keyof typeof TRANSFER_ARGS)[]) {
			expect(isTransfersOp(op), op).toBe(true)
		}

		expect(isTransfersOp("pause")).toBe(false)
		expect(isTransfersOp("mountsApply")).toBe(false)
	})

	it("rejects a relative path, a NUL in a path, an unknown key, a non-uuid id", () => {
		expect(spec("downloadFile", { path: "Downloads/a.txt" })).toBe(false)
		expect(spec("uploadDirectory", { path: "./d" })).toBe(false)
		expect(spec("downloadFile", { path: "/Users/u/a\0.txt" })).toBe(false)
		expect(spec("uploadFile", { extra: true })).toBe(false)
		expect(spec("downloadFile", { id: "1" })).toBe(false)
		expect(spec("downloadListed", { listingId: "l1" })).toBe(false)
		expect(spec("downloadFile", { conflict: "skip" })).toBe(false)
		expect(spec("uploadDirectory", { name: "" })).toBe(false)
		expect(start([])).toBe(false)
		expect(accepts(toNativeSchema, call("transfersCancel", { ids: [] }))).toBe(false)
		expect(accepts(toNativeSchema, call("transfersCancel", { ids: ["x"] }))).toBe(false)
		expect(accepts(toNativeSchema, call("transfersPause", { ids: [TRANSFER_ID] }))).toBe(false)
	})

	it("rejects more than 10000 specs", () => {
		const specs = Array.from({ length: 10_000 }, () => SPECS.downloadListed)

		expect(start(specs)).toBe(true)
		expect(start([...specs, SPECS.downloadListed])).toBe(false)
	})

	it("rejects an SDK value over 8 KiB", () => {
		expect(spec("downloadFile", { file: { ...FILE_REF, value: "x".repeat(8192) } })).toBe(true)
		expect(spec("downloadFile", { file: { ...FILE_REF, value: "x".repeat(8193) } })).toBe(false)
		expect(spec("downloadFile", { file: { ...FILE_REF, value: "" } })).toBe(false)
	})

	it("rejects specs whose SDK values sum past 16 MiB", () => {
		const big = { ...SPECS.downloadFile, file: { ...FILE_REF, value: "x".repeat(8192) } }
		const fits = Array.from({ length: 2048 }, () => big)

		expect(start(fits)).toBe(true)
		expect(start([...fits, SPECS.uploadFile])).toBe(false)
	})

	it("rejects an unknown SDK variant", () => {
		expect(spec("downloadFile", { file: { ...FILE_REF, variant: "AnyFile.Folder" } })).toBe(false)
		expect(spec("uploadFile", { parent: { ...DIR_REF, extra: 1 } })).toBe(false)
	})

	it("opError routes transfer ops to the transfer error schema", () => {
		expect(accepts(opError("transfersStart"), { code: "localFull", kind: "Io", message: "disk full" })).toBe(true)
		expect(accepts(opError("transfersStart"), { code: "pairNotFound" })).toBe(false)
		expect(accepts(opError("transfersStart"), { code: "unknown", kind: "x".repeat(65) })).toBe(false)
		expect(accepts(opError("pause"), { code: "localFull" })).toBe(false)
		expect(accepts(opError("mountsApply"), { code: "storageFull" })).toBe(false)
	})

	it("a transfers reply error parses with the transfer error schema", () => {
		const error: DesktopTransferError = { code: "storageFull", kind: "StorageFull" }

		expect(accepts(transferErrorSchema, error)).toBe(true)
		expect(accepts(fromNativeSchema, { t: "reply", id: 1, ok: false, error })).toBe(true)
		expect(accepts(fromNativeSchema, { t: "reply", id: 1, ok: false, error: { code: "interrupted" } })).toBe(true)
	})

	it("fromNativeSchema accepts a transfers batch with a progress and a settled event", () => {
		expect(
			accepts(fromNativeSchema, {
				t: "transfers",
				events: [
					{ k: "progress", id: TRANSFER_ID, size: 20, bytes: 10, files: { total: 3, done: 1, failed: 0, failedBytes: 0 } },
					{ k: "progress", id: TRANSFER_ID, size: 20, bytes: 20, files: null },
					{ k: "settled", id: TRANSFER_ID, outcome: "done", savedPath: "/Users/u/Downloads/a (1).txt" },
					{ k: "settled", id: TRANSFER_ID, outcome: "done", uploaded: '{"uuid":"x"}' },
					{ k: "settled", id: TRANSFER_ID, outcome: "error", error: { code: "localDenied" } }
				]
			})
		).toBe(true)
		expect(accepts(fromNativeSchema, { t: "transfers", events: [] })).toBe(true)
		expect(
			accepts(fromNativeSchema, { t: "transfers", events: [{ k: "settled", id: TRANSFER_ID, outcome: "done", savedPath: "a.txt" }] })
		).toBe(false)
	})

	it('rejects outcome "paused"', () => {
		expect(accepts(fromNativeSchema, { t: "transfers", events: [{ k: "settled", id: TRANSFER_ID, outcome: "paused" }] })).toBe(false)
	})

	it("rejects an uploaded value over 8 KiB", () => {
		const settled = (uploaded: string) => ({ t: "transfers", events: [{ k: "settled", id: TRANSFER_ID, outcome: "done", uploaded }] })

		expect(accepts(fromNativeSchema, settled("x".repeat(8192)))).toBe(true)
		expect(accepts(fromNativeSchema, settled("x".repeat(8193)))).toBe(false)
	})

	it("transfersListTree accepts entries or tooMany and rejects both", () => {
		const result = opResult("transfersListTree")

		expect(
			accepts(result, { entries: [TREE_ENTRY, { ...TREE_ENTRY, segments: ["d"], directory: true, mtimeMs: null, listIndex: null }] })
		).toBe(true)
		expect(accepts(result, { tooMany: 12_000 })).toBe(true)
		expect(accepts(result, { entries: [], tooMany: 1 })).toBe(false)
		expect(accepts(result, { entries: [{ ...TREE_ENTRY, segments: [] }] })).toBe(false)
		expect(accepts(toNativeSchema, call("transfersListTree", { ...TRANSFER_ARGS.transfersListTree, maxEntries: 10_001 }))).toBe(false)
		expect(accepts(toNativeSchema, call("transfersListTree", { ...TRANSFER_ARGS.transfersListTree, items: [] }))).toBe(false)
	})

	it("a tree entry needs listIndex", () => {
		const { listIndex: _listIndex, ...entry } = TREE_ENTRY

		expect(accepts(opResult("transfersListTree"), { entries: [entry] })).toBe(false)
	})
})
