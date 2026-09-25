import { vi, describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))
vi.mock("@filen/sdk-rs", async () => await import("@/tests/mocks/sdkCopy"))
vi.mock("@/lib/i18n", () => ({ default: { t: (key: string) => key } }))
vi.mock("@/lib/sdkUnwrap", () => ({
	unwrapDirMeta: (dir: { uuid: string }) => dir,
	unwrapFileMeta: (file: { uuid: string }) => file,
	unwrappedDirIntoDriveItem: (dir: { uuid: string }) => ({ type: "directory", data: dir }),
	unwrappedFileIntoDriveItem: (file: { uuid: string }) => ({ type: "file", data: file })
}))

import * as sdkCopy from "@/tests/mocks/sdkCopy"
import {
	CopyEvent_Tags,
	CopyPhase,
	CopyStage,
	ErrorKind,
	NonRootNormalItem_Tags,
	RunState,
	SkipReason,
	sdkError
} from "@/tests/mocks/sdkCopy"
import {
	collectCopyEvents,
	copyJobError,
	copyJobErrorToHumanReadable,
	copyJobPhase,
	copyReportInput,
	copyUpdateInput,
	createdDriveItem,
	emptyCopyEvents,
	retryEntries,
	versionTargets
} from "@/features/copy/copyAdapter"
import { applyCopyUpdate, settleCopyJob, isQuotaPreflightFailure } from "@filen/shared"
import { createCopyJob } from "@/features/copy/copyAdapter"
import type { CopyEvent, CopyFailure, CopyReport, CopyUpdate } from "@filen/sdk-rs"

function error(kind: ErrorKind, serverMessage?: string) {
	return sdkError(kind, `inner ${ErrorKind[kind]}`, serverMessage)
}

type Stage = InstanceType<(typeof CopyStage)[keyof typeof CopyStage]>

function info(stage: Stage, overrides: Record<string, unknown> = {}) {
	return {
		sourceUuid: "src",
		sourcePath: "/a/b",
		destParent: "dest-parent",
		destParentDir: { tag: "Dir", inner: [{ uuid: "dest-parent" }] },
		destName: "b",
		stage,
		error: error(ErrorKind.Server, "Server said no"),
		affectedFiles: 3n,
		affectedBytes: 300n,
		...overrides
	}
}

function asVersionOf(existingFile: string): Stage {
	return new CopyStage.RegisteredAsVersion({ existingFile })
}

function event(tag: CopyEvent_Tags, inner: unknown): CopyEvent {
	return { tag, inner: [inner] } as unknown as CopyEvent
}

const ZERO = {
	dirsCreated: 0n,
	dirsFailed: 0n,
	filesDone: 0n,
	filesFailed: 0n,
	bytesDone: 0n,
	bytesFailed: 0n,
	dirsNotAttempted: 0n,
	filesNotAttempted: 0n,
	bytesNotAttempted: 0n,
	entriesSkipped: 0n,
	bytesSkipped: 0n
}

function report(overrides: Partial<Record<keyof CopyReport, unknown>> = {}): CopyReport {
	return {
		topLevel: [],
		failures: [],
		skipped: [],
		renamed: [],
		totals: { dirs: 0n, files: 0n, bytes: 0n },
		counts: ZERO,
		error: undefined,
		...overrides
	} as unknown as CopyReport
}

// The generated bindings' own enum members, in declaration order.
function generatedEnumMembers(name: string): string[] {
	const source = readFileSync(new URL("../../node_modules/@filen/sdk-rs/src/generated/filen_sdk_rs.ts", import.meta.url), "utf8")
	const start = source.indexOf(`export enum ${name} {`)
	const body = source.slice(start, source.indexOf("\n}", start))

	return [...body.matchAll(/^\t([A-Z][A-Za-z0-9]*)\b/gm)].map(match => match[1] as string)
}

function stubEnumMembers(stub: Record<string, string | number>): string[] {
	return Object.keys(stub).filter(key => Number.isNaN(Number(key)))
}

describe("SDK enum stubs match the installed bindings", () => {
	it.each([
		"CopyPhase",
		"CopyStage_Tags",
		"CopyEvent_Tags",
		"ErrorKind",
		"NonRootNormalItem_Tags",
		"AnyItemWithContext_Tags",
		"RunState",
		"SkipReason_Tags"
	] as const)("%s", name => {
		expect(stubEnumMembers(sdkCopy[name] as unknown as Record<string, string | number>)).toEqual(generatedEnumMembers(name))
	})
})

describe("copyJobPhase", () => {
	it.each([
		[CopyPhase.Scanning, "scanning"],
		[CopyPhase.CreatingDirectories, "creatingDirectories"],
		[CopyPhase.CopyingFiles, "copyingFiles"],
		[CopyPhase.Finishing, "finishing"],
		[CopyPhase.Done, "done"],
		[CopyPhase.Cancelled, "cancelled"],
		[CopyPhase.Failed, "failed"]
	])("%s → %s", (phase, expected) => {
		expect(copyJobPhase(phase as never)).toBe(expected)
	})
})

describe("copyJobError", () => {
	it("carries the ErrorKind NAME the shared job logic compares against", () => {
		expect(copyJobError(error(ErrorKind.Cancelled) as never).kind).toBe("Cancelled")
		expect(copyJobError(error(ErrorKind.MaxStorageReached) as never).kind).toBe("MaxStorageReached")
	})

	it("humanises with the usual priority: the server's own message first", () => {
		expect(copyJobErrorToHumanReadable(copyJobError(error(ErrorKind.Server, "Quota exhausted") as never))).toBe("Quota exhausted")
		expect(copyJobErrorToHumanReadable(copyJobError(error(ErrorKind.MaxStorageReached) as never))).toBe("max_remote_storage_reached")
	})

	it("reads the SDK error's inner message, not its developer-facing wrapper", () => {
		expect(copyJobError(sdkError(ErrorKind.Io, "disk gone") as never)).toEqual({ kind: "Io", message: "disk gone", serverMessage: undefined })
		expect(copyJobError(sdkError(ErrorKind.Io) as never).message).toBe("")
	})
})

describe("copyUpdateInput", () => {
	const update = (runState: RunState) =>
		({
			phase: CopyPhase.CopyingFiles,
			runState,
			scan: { sourcesDone: 1n, sourcesTotal: 1n },
			totals: { dirs: 0n, files: 1n, bytes: 10n },
			counts: ZERO,
			active: [],
			events: [],
			bytesPerSecond: undefined,
			etaMs: undefined
		}) as unknown as CopyUpdate

	it.each([
		[RunState.Running, { pausing: false, paused: false, cancelling: false }],
		[RunState.Pausing, { pausing: true, paused: false, cancelling: false }],
		[RunState.Paused, { pausing: false, paused: true, cancelling: false }],
		[RunState.Cancelling, { pausing: false, paused: false, cancelling: true }]
	])("run state %s → at most one flag", (runState, flags) => {
		const input = copyUpdateInput(update(runState), emptyCopyEvents())

		expect({ pausing: input.pausing, paused: input.paused, cancelling: input.cancelling }).toEqual(flags)

		const job = applyCopyUpdate(
			createCopyJob({ id: "j", destination: { uuid: null, name: "" }, itemCount: 1, glyph: "file", rowName: "", startedAt: 0 }),
			input
		)

		expect({ pausing: job.pausing, paused: job.paused, cancelling: job.cancelling }).toEqual(flags)
	})
})

describe("collectCopyEvents", () => {
	it("keeps failures, counts renames and propagation failures, sets saved-as-version apart, ignores the rest", () => {
		const into = emptyCopyEvents()

		collectCopyEvents(
			[
				event(CopyEvent_Tags.DirCreated, {}),
				event(CopyEvent_Tags.FileStarted, {}),
				event(CopyEvent_Tags.FileDone, {}),
				event(CopyEvent_Tags.FileFailed, info(new CopyStage.Upload())),
				event(CopyEvent_Tags.DirFailed, info(new CopyStage.CreateDirectory())),
				event(CopyEvent_Tags.FileFailed, info(asVersionOf("old-uuid"))),
				event(CopyEvent_Tags.Skipped, { sourcePath: "/a/c", bytes: 5n, reason: new SkipReason.UndecryptableFile({ uuid: "c" }) }),
				event(CopyEvent_Tags.Renamed, {}),
				event(CopyEvent_Tags.PropagationFailed, {}),
				event(CopyEvent_Tags.ColorFailed, {})
			],
			into
		)

		expect(into.failures).toHaveLength(2)
		expect(into.failures[0]).toEqual({
			sourceUuid: "src",
			sourcePath: "/a/b",
			destName: "b",
			error: { kind: "Server", message: "inner Server", serverMessage: "Server said no" },
			affectedFiles: 3,
			affectedBytes: 300
		})
		expect(into.savedAsVersion).toBe(1)
		expect(into.renamed).toBe(1)
		expect(into.propagationFailed).toBe(1)
	})

	it("accumulates across calls into the same buffer (the runner folds skipped windows)", () => {
		const into = emptyCopyEvents()

		collectCopyEvents([event(CopyEvent_Tags.Renamed, {})], into)
		collectCopyEvents([event(CopyEvent_Tags.Renamed, {})], into)

		expect(into.renamed).toBe(2)
	})
})

describe("copyReportInput", () => {
	it("splits saved-as-version files off the retryable failures", () => {
		const failed = { item: { tag: "File" }, info: info(new CopyStage.Download()) }
		const version = { item: { tag: "File" }, info: info(asVersionOf("old-uuid")) }
		const input = copyReportInput(report({ failures: [failed, version], renamed: [{}, {}], topLevel: [{}] }))

		expect(input.failures).toHaveLength(1)
		expect(input.failures[0]?.retryable).toBe(failed)
		expect(input.savedAsVersionCount).toBe(1)
		expect(input.renamedCount).toBe(2)
		expect(input.createdCount).toBe(1)
		expect(input.error).toBeUndefined()
	})

	it("a MaxStorageReached before anything was created is the quota pre-flight refusal", () => {
		const input = copyReportInput(report({ error: error(ErrorKind.MaxStorageReached) }))

		expect(isQuotaPreflightFailure(input)).toBe(true)

		const settled = settleCopyJob(
			createCopyJob({ id: "j", destination: { uuid: null, name: "" }, itemCount: 1, glyph: "file", rowName: "", startedAt: 0 }),
			{ report: input, maxBytes: 42 }
		)

		expect(settled.outcome).toEqual({ status: "quotaExceeded", freeBytes: 42 })
	})

	it("takes skipped entries from the counts, whatever their reason carries", () => {
		const skipped = [
			{ sourcePath: "/a/c", bytes: 5n, reason: new SkipReason.UndecryptableFile({ uuid: "c" }) },
			{ sourcePath: "/a/d", bytes: 0n, reason: new SkipReason.Unreachable({ count: 4n }) }
		]
		const input = copyReportInput(report({ skipped, counts: { ...ZERO, entriesSkipped: 5n, bytesSkipped: 5n } }))

		expect(input.failures).toEqual([])
		expect([input.counts.entriesSkipped, input.counts.bytesSkipped]).toEqual([5n, 5n])
	})

	it("a Cancelled report settles as cancelled", () => {
		const settled = settleCopyJob(
			createCopyJob({ id: "j", destination: { uuid: null, name: "" }, itemCount: 1, glyph: "file", rowName: "", startedAt: 0 }),
			{
				report: copyReportInput(report({ error: error(ErrorKind.Cancelled) })),
				maxBytes: undefined
			}
		)

		expect(settled.outcome).toEqual({ status: "cancelled" })
	})
})

describe("versionTargets / createdDriveItem / retryEntries", () => {
	it("names only the existing files a copy became a version of", () => {
		const targets = versionTargets(
			report({
				failures: [
					{ item: {}, info: info(asVersionOf("old-uuid")) },
					{ item: {}, info: info(new CopyStage.Upload()) }
				]
			})
		)

		expect([...targets]).toEqual(["old-uuid"])
	})

	it("maps a created directory and file to drive items", () => {
		expect(createdDriveItem({ tag: NonRootNormalItem_Tags.Dir, inner: [{ uuid: "d" }] } as never)).toEqual({ type: "directory", data: { uuid: "d" } })
		expect(createdDriveItem({ tag: NonRootNormalItem_Tags.File, inner: [{ uuid: "f" }] } as never)).toEqual({ type: "file", data: { uuid: "f" } })
	})

	it("sends each failure back to its planned directory under its planned name", () => {
		const failure = { item: { tag: "File" }, info: info(new CopyStage.Upload()) } as unknown as CopyFailure

		expect(retryEntries([failure])).toEqual([{ item: failure.item, destination: failure.info.destParentDir, name: "b" }])
	})
})
