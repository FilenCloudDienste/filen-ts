import { describe, expect, it } from "vitest"
import { type } from "arktype"
import type { DesktopMountsError, DesktopMountsStats, DesktopVfsTuning } from "@filen/shared/desktop"
import {
	fromNativeSchema,
	mountsErrorSchema,
	NATIVE_OPS,
	type NativeMountsDesired,
	type NativeOp,
	opArgs,
	opError,
	opResult,
	SYNC_TRANSFERS_KEPT,
	toNativeSchema,
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
	degraded: { local: false, remote: false }
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

// One valid call per op.
const ARGS: { [K in NativeOp]: unknown } = {
	listPairs: {},
	addPair: { localRoot: "/Users/u/Documents", remoteRoot: UUID, mode: "localBackup" },
	removePair: { pairId: "1" },
	pause: { pairId: "1" },
	resume: { pairId: "1" },
	setMode: { pairId: "1", mode: "twoWay", backlog: "adoptDestination" },
	requestPass: { pairId: "1" },
	evaluatePlan: { pairId: "1", check: { legacy: { excludeDotFiles: true } } },
	planPage: { planId: "p1", list: "held", offset: 0, limit: 1000 },
	releasePlan: { planId: "p1" },
	conflicts: { pairId: "1", offset: 0, limit: 200 },
	resolveConflict: { pairId: "1", relPath: "d/a.txt", resolution: "keepBoth" },
	heldDeletions: { pairId: "1" },
	approveDeletions: { pairId: "1", passToken: "token" },
	retryPath: { pairId: "1", relPath: "d/a.txt" },
	ignoredPaths: { pairId: "1", offset: 0, limit: 1 },
	userIgnore: {},
	setUserIgnore: { text: ".*\n!/.filenignore\n" },
	defaultIgnore: {},
	seedLegacy: { pairId: "18446744073709551615", stateDir: "/old/sync/state/v2/u" },
	...MOUNTS_ARGS
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
				logLevel: "Info"
			})
		).toBe(true)
		expect(accepts(toNativeSchema, { t: "subscribe", overview: true, mounts: false })).toBe(true)
		expect(accepts(toNativeSchema, { t: "shutdown" })).toBe(true)

		for (const op of Object.keys(NATIVE_OPS) as NativeOp[]) {
			expect(accepts(toNativeSchema, call(op, ARGS[op])), op).toBe(true)
			expect(accepts(opArgs(op), ARGS[op]), op).toBe(true)
		}
	})

	it("rejects unknown op / extra keys / numeric pairId", () => {
		expect(accepts(toNativeSchema, call("deleteEverything", {}))).toBe(false)
		expect(accepts(toNativeSchema, { ...call("pause", { pairId: "1" }), extra: 1 })).toBe(false)
		expect(accepts(toNativeSchema, call("pause", { pairId: "1", extra: 1 }))).toBe(false)
		expect(accepts(toNativeSchema, call("evaluatePlan", { pairId: "1", check: { legacy: { excludeDotFiles: true }, more: 1 } }))).toBe(
			false
		)
		expect(accepts(toNativeSchema, { t: "shutdown", now: true })).toBe(false)
		expect(accepts(toNativeSchema, call("pause", { pairId: 1 }))).toBe(false)
		expect(accepts(toNativeSchema, call("pause", { pairId: "1n" }))).toBe(false)
		expect(accepts(toNativeSchema, call("pause", { pairId: "-1" }))).toBe(false)
		expect(accepts(toNativeSchema, call("pause", { pairId: "123456789012345678901" }))).toBe(false)
		expect(accepts(toNativeSchema, call("addPair", { localRoot: "/x", remoteRoot: "not-a-uuid", mode: "twoWay" }))).toBe(false)
		expect(accepts(toNativeSchema, call("addPair", { localRoot: "/x", remoteRoot: UUID, mode: "mirror" }))).toBe(false)
		expect(accepts(toNativeSchema, call("planPage", { planId: "p1", list: "held", offset: 0, limit: 1001 }))).toBe(false)
		expect(accepts(toNativeSchema, { ...call("pause", { pairId: "1" }), id: 1.5 })).toBe(false)
		expect(accepts(toNativeSchema, { t: "init", addonPath: "/a", dir: "/d", session: "", logLevel: "Info" })).toBe(false)
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
				pairs: [{ id: "1", localRoot: "/Users/u/Documents", remoteRoot: UUID, mode: "twoWay", paused: true }],
				reset: false
			},
			{ t: "reply", id: 1, ok: true, value: null },
			{ t: "reply", id: 1, ok: false, error: { code: "invalidIgnore", line: 3 } },
			{ t: "reply", id: 1, ok: false, error: { code: "localRootNested", pairId: "2", message: "nested" } },
			{ t: "overview", pairs: [runtime] },
			{ t: "aggregate", state: "attention" },
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
		expect(accepts(opResult("seedLegacy"), { imported: 3, skipped: 0 })).toBe(true)
		expect(accepts(opResult("seedLegacy"), null)).toBe(true)
		expect(accepts(opResult("seedLegacy"), "unsupported")).toBe(false)
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
				check: { uploads: 1, downloads: 0, legacyHits: { count: 1, sample: [".hidden"] } }
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
