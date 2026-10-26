import { describe, expect, it } from "vitest"
import { type } from "arktype"
import { fromNativeSchema, NATIVE_OPS, type NativeOp, opArgs, opResult, toNativeSchema } from "../shared/nativeProtocol.ts"

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
	seedLegacy: { pairId: "18446744073709551615" }
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
		expect(accepts(toNativeSchema, { t: "subscribe", overview: true })).toBe(true)
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

describe("opResult", () => {
	it("checks a reply's value against the op it answers", () => {
		expect(accepts(opResult("addPair"), { pairId: "5" })).toBe(true)
		expect(accepts(opResult("addPair"), { pairId: 5 })).toBe(false)
		expect(accepts(opResult("pause"), null)).toBe(true)
		expect(accepts(opResult("seedLegacy"), "unsupported")).toBe(true)
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
