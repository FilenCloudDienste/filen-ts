import { type, type Type } from "arktype"
import path from "node:path"
import type {
	DesktopMountsError,
	DesktopMountsErrorCode,
	DesktopMountsRole,
	DesktopMountsRoleState,
	DesktopMountsStats,
	DesktopSdkRef,
	DesktopServeProtocol,
	DesktopSyncActivity,
	DesktopSyncActivityKind,
	DesktopSyncConflict,
	DesktopSyncConflictResolved,
	DesktopSyncError,
	DesktopSyncErrorCode,
	DesktopSyncHeldDeletions,
	DesktopSyncHeldReason,
	DesktopSyncIgnored,
	DesktopSyncIssueCounts,
	DesktopSyncMode,
	DesktopSyncPlanAction,
	DesktopSyncPlanList,
	DesktopSyncPlanPage,
	DesktopSyncPlanSummary,
	DesktopSyncResolution,
	DesktopSyncScanGap,
	DesktopSyncStage,
	DesktopSyncTransfer,
	DesktopSyncUnsyncable,
	DesktopTransferError,
	DesktopVfsTuning
} from "@filen/shared/desktop"
import { SESSION_BLOB_MAX_LENGTH } from "./channels.ts"

// The messages between main and the native host (the utility process that owns the sync engine), validated on both
// ends. Plain JSON-safe values only: pair ids travel as decimal strings, bigints exist only inside the host.

type Equal<X, Y> = (<V>() => V extends X ? 1 : 2) extends <V>() => V extends Y ? 1 : 2 ? true : false

// Ties a schema to the bridge type it validates, both ways: a field or literal added to only one of them fails to
// compile.
export function pinned<T>() {
	return <S extends Type<T>>(schema: S & (Equal<S["infer"], T> extends true ? unknown : never)): S => schema
}

const noNul = (value: string): boolean => !value.includes("\0")

// The engine's u64 pair id.
export const pairIdSchema = type(/^(?:0|[1-9]\d{0,19})$/)

export const countSchema = type("0 <= number.integer <= 9007199254740991")

// A path inside a pair, relative to its root ("" is the root).
const relPathSchema = type("string <= 4096").narrow(noNul)

// A relPath an operation acts on: never the root.
export const relPathArgSchema = type("0 < string <= 4096").narrow(noNul)

// An absolute local path main resolved itself.
export const localPathSchema = type("0 < string <= 32767").narrow(noNul)

const textSchema = type("string <= 4096")

export const syncModeSchema = pinned<DesktopSyncMode>()(
	type("'twoWay' | 'localToRemote' | 'remoteToLocal' | 'localBackup' | 'remoteBackup'")
)

const heldReasonSchema = pinned<DesktopSyncHeldReason>()(
	type("'scanIncomplete' | 'firstSyncWithDeletions' | 'remoteUnconverged' | 'remoteEmptied' | 'exceededThreshold' | 'restoreUnfinished'")
)

export const planListSchema = pinned<DesktopSyncPlanList>()(type("'actions' | 'held' | 'conflicts' | 'unsyncable' | 'ignored'"))

const nodeKindSchema = type("'file' | 'directory'")

const errorCodeSchema = pinned<DesktopSyncErrorCode>()(
	type.enumerated(
		"hostUnavailable",
		"timeout",
		"unauthenticated",
		"pairNotFound",
		"planExpired",
		"rootExpired",
		"rootRefused",
		"localRootMissing",
		"remoteRootMissing",
		"localRootInUse",
		"localRootNested",
		"localRootContains",
		"remoteRootInUse",
		"remoteRootNested",
		"remoteRootContains",
		"modeConflict",
		"invalidIgnore",
		"unknown"
	)
)

const activityKindSchema = pinned<DesktopSyncActivityKind>()(
	type.enumerated(
		"uploaded",
		"downloaded",
		"createdRemoteDirectory",
		"createdLocalDirectory",
		"trashedRemote",
		"deletedLocal",
		"movedRemote",
		"movedLocal",
		"binned",
		"failed",
		"conflict",
		"deletionsHeld",
		"passFailed",
		"passCompleted"
	)
)

export const nativeErrorSchema = pinned<DesktopSyncError>()(
	type({ code: errorCodeSchema, "pairId?": pairIdSchema, "line?": "number.integer >= 1", "message?": textSchema, "+": "reject" })
)

export type NativeError = DesktopSyncError

const pairFields = {
	id: pairIdSchema,
	localRoot: localPathSchema,
	remoteRoot: "string.uuid",
	mode: syncModeSchema,
	paused: "boolean"
} as const

// A pair as the engine holds it. `firstPassCompleted`: a pass of it completed cleanly (persisted by the engine).
const nativePairSchema = type({ ...pairFields, firstPassCompleted: "boolean", "+": "reject" })

export type NativePair = typeof nativePairSchema.infer

// The transfers a pair reports: every one in flight. A pass moves at most the client's concurrency of files at once (16
// chunks by default, the SDK's JsClientConfig.concurrency), so the cap only drops a transfer whose end went unreported.
export const SYNC_TRANSFERS_KEPT = 16

const transferSchema = pinned<DesktopSyncTransfer>()(
	type({ relPath: relPathSchema, direction: "'upload' | 'download'", bytes: countSchema, total: countSchema, "+": "reject" })
)

const issueCountsSchema = pinned<DesktopSyncIssueCounts>()(
	type({ conflicts: countSchema, heldDeletions: countSchema, unsyncable: countSchema, failed: countSchema, "+": "reject" })
)

const stageSchema = pinned<DesktopSyncStage>()(
	type({ kind: "'waitingForCloud'", "+": "reject" }).or({
		kind: "'indexing'",
		entries: countSchema,
		filesToHash: countSchema,
		bytesToHash: countSchema,
		filesHashed: countSchema,
		bytesHashed: countSchema,
		"+": "reject"
	})
)

const refusalSchema = type("'remoteCollision' | 'localCollision'")

// A pair plus what the host knows live about it.
const nativePairRuntimeSchema = type({
	...pairFields,
	syncing: "boolean",
	progress: type({ done: countSchema, total: countSchema, "+": "reject" }).or("null"),
	transfers: transferSchema.array().atMostLength(SYNC_TRANSFERS_KEPT),
	lastSyncedAt: countSchema.or("null"),
	lastError: textSchema.or("null"),
	issues: issueCountsSchema,
	degraded: type({ local: "boolean", remote: "boolean", "+": "reject" }),
	stage: stageSchema.or("null"),
	halted: type("'localStorageFull' | 'remoteStorageFull' | 'offline' | 'certificateUnverified' | null"),
	refused: refusalSchema.or("null"),
	"+": "reject"
})

export type NativePairRuntime = typeof nativePairRuntimeSchema.infer

// Main numbers the entries (`seq`).
export type NativeActivity = Omit<DesktopSyncActivity, "seq">

const nativeActivitySchema = pinned<NativeActivity>()(
	type({
		pairId: pairIdSchema,
		at: countSchema,
		kind: activityKindSchema,
		"relPath?": relPathSchema,
		"to?": relPathSchema,
		"detail?": textSchema,
		"+": "reject"
	})
)

const planSummaryFields = {
	actions: countSchema,
	uploadBytes: countSchema,
	downloadBytes: countSchema,
	heldDeletions: countSchema,
	heldReason: heldReasonSchema.or("null"),
	conflicts: countSchema,
	unsyncable: countSchema,
	ignored: countSchema,
	refused: refusalSchema.or("null")
} as const

// The summary plus the token that approves the deletions the plan holds.
export interface NativePlanSummary extends DesktopSyncPlanSummary {
	passToken: string | null
}

export const passTokenSchema = type("0 < string <= 256")

export const planSummarySchema = pinned<DesktopSyncPlanSummary>()(type({ ...planSummaryFields, "+": "reject" }))

const nativePlanSummarySchema = pinned<NativePlanSummary>()(
	type({ ...planSummaryFields, passToken: passTokenSchema.or("null"), "+": "reject" })
)

const planActionSchema = pinned<DesktopSyncPlanAction>()(
	type({
		relPath: relPathSchema,
		kind: "'upload' | 'download' | 'createRemoteDirectory' | 'createLocalDirectory' | 'moveRemote' | 'moveLocal' | 'trashRemote' | 'deleteLocal' | 'adoptBaseline'",
		to: relPathSchema.or("null"),
		node: nodeKindSchema,
		size: countSchema.or("null"),
		"+": "reject"
	})
)

const conflictSchema = pinned<DesktopSyncConflict>()(
	type({ relPath: relPathSchema, local: nodeKindSchema.or("null"), remote: nodeKindSchema.or("null"), "+": "reject" })
)

const conflictResolvedSchema = pinned<DesktopSyncConflictResolved>()(
	type({ quarantined: relPathSchema.or("null"), keptAs: relPathSchema.or("null"), "+": "reject" })
)

const unsyncableSchema = pinned<DesktopSyncUnsyncable>()(
	type({
		relPath: relPathSchema,
		reason: "'invalidName' | 'repeatedFailure' | 'remoteUndecodable' | 'remoteInvalidName' | 'remoteNameNotStorable' | 'remoteBrokenParent' | 'localAlias' | 'localNameCollision' | 'remoteNameCollision' | 'remoteContentHashMismatch'",
		detail: textSchema.or("null"),
		"+": "reject"
	})
)

const ignoredSchema = pinned<DesktopSyncIgnored>()(
	type({
		relPath: relPathSchema,
		level: "'default' | 'user' | 'file'",
		dir: relPathSchema.or("null"),
		pattern: textSchema,
		tracked: "boolean",
		"+": "reject"
	})
)

const planPageSchema = pinned<DesktopSyncPlanPage>()(
	type({ list: "'actions' | 'held'", total: countSchema, entries: planActionSchema.array(), "+": "reject" })
		.or({ list: "'conflicts'", total: countSchema, entries: conflictSchema.array(), "+": "reject" })
		.or({ list: "'unsyncable'", total: countSchema, entries: unsyncableSchema.array(), "+": "reject" })
		.or({ list: "'ignored'", total: countSchema, entries: ignoredSchema.array(), "+": "reject" })
)

const scanGapSchema = pinned<DesktopSyncScanGap>()(
	type({
		relPath: relPathSchema,
		cause: "'unreadable' | 'changedDuringScan' | 'nonUtf8Name'",
		kind: textSchema.or("null"),
		"+": "reject"
	})
)

const heldDeletionsSchema = pinned<DesktopSyncHeldDeletions>()(
	type({
		passToken: passTokenSchema.or("null"),
		reason: heldReasonSchema.or("null"),
		total: countSchema,
		entries: planActionSchema.array(),
		gaps: scanGapSchema.array().atMostLength(100),
		gapsTotal: countSchema,
		"+": "reject"
	})
)

export const planIdSchema = type("0 < string <= 64")

// The engine pages at most 1000 entries at a time.
const pageLimitSchema = type("1 <= number.integer <= 1000")

// An ignore text: the engine allows 1 MiB per rule file.
export const ignoreTextSchema = type("string <= 1048576")

export const resolutionSchema = pinned<DesktopSyncResolution>()(type("'keepLocal' | 'keepRemote' | 'keepBoth'"))

const noArgs = type({ "+": "reject" })
const pairArgs = type({ pairId: pairIdSchema, "+": "reject" })
const pageArgs = type({ pairId: pairIdSchema, offset: countSchema, limit: pageLimitSchema, "+": "reject" })
const done = type("null")

// What evaluatePlan found. `check` (only when asked for): the first-run guard's scan of the plan's actions. The summary's
// action count includes the adoptions that transfer nothing, so the scan counts the uploads and downloads, and
// `overwrites` the transfers that replace a file their destination holds.
const evaluationSchema = type({ status: "'unconverged'", "+": "reject" }).or({
	status: "'ok'",
	planId: planIdSchema,
	summary: nativePlanSummarySchema,
	check: type({
		uploads: countSchema,
		downloads: countSchema,
		overwrites: type({ files: countSchema, bytes: countSchema, "+": "reject" }),
		"+": "reject"
	}).or("null"),
	"+": "reject"
})

// Every engine call main can make, with its arguments and result.
export const SYNC_OPS = {
	listPairs: { args: noArgs, result: nativePairSchema.array() },
	addPair: {
		args: type({ localRoot: localPathSchema, remoteRoot: "string.uuid", mode: syncModeSchema, "+": "reject" }),
		result: type({ pairId: pairIdSchema, "+": "reject" })
	},
	removePair: { args: pairArgs, result: done },
	pause: { args: pairArgs, result: done },
	resume: { args: pairArgs, result: done },
	// `backlog`: what happens to the changes a backup mode kept from the destination; null when leaving no backup mode.
	setMode: {
		args: type({ pairId: pairIdSchema, mode: syncModeSchema, backlog: "'propagate' | 'adoptDestination' | null", "+": "reject" }),
		result: done
	},
	requestPass: { args: pairArgs, result: done },
	// Whether the cache has read the pair's cloud directory, waiting a while for it.
	awaitConverged: { args: pairArgs, result: type("boolean") },
	evaluatePlan: {
		args: type({ pairId: pairIdSchema, "check?": "boolean", "+": "reject" }),
		result: evaluationSchema
	},
	planPage: {
		args: type({ planId: planIdSchema, list: planListSchema, offset: countSchema, limit: pageLimitSchema, "+": "reject" }),
		result: planPageSchema
	},
	releasePlan: { args: type({ planId: planIdSchema, "+": "reject" }), result: done },
	conflicts: { args: pageArgs, result: type({ total: countSchema, entries: conflictSchema.array(), "+": "reject" }) },
	// The result is where the copy that lost went: keepRemote's bin path, or the path keepBoth kept it at.
	resolveConflict: {
		args: type({
			pairId: pairIdSchema,
			relPath: relPathArgSchema,
			resolution: resolutionSchema,
			"+": "reject"
		}),
		result: conflictResolvedSchema
	},
	// Resolves the given conflicts one after another, a path that fails left in place.
	resolveConflicts: {
		args: type({
			pairId: pairIdSchema,
			resolution: resolutionSchema,
			relPaths: relPathArgSchema.array().moreThanLength(0).atMostLength(1000),
			"+": "reject"
		}),
		result: type({ resolved: countSchema, failed: countSchema, "+": "reject" })
	},
	heldDeletions: { args: pairArgs, result: heldDeletionsSchema },
	approveDeletions: { args: type({ pairId: pairIdSchema, passToken: passTokenSchema, "+": "reject" }), result: done },
	restoreDeletions: { args: type({ pairId: pairIdSchema, passToken: passTokenSchema, "+": "reject" }), result: done },
	retryPath: { args: type({ pairId: pairIdSchema, relPath: relPathArgSchema, "+": "reject" }), result: done },
	// Clears every failure streak, then asks for a pass.
	retryAll: { args: pairArgs, result: done },
	// From the last pass's report (the first 1000); null before this host saw one.
	unsyncablePaths: {
		args: pageArgs,
		result: type({ total: countSchema, entries: unsyncableSchema.array(), "+": "reject" }).or("null")
	},
	// Holds every deletion until a clean pass of the pair applied or held none; then the engine's default comes back.
	setMigratedGuard: { args: pairArgs, result: done },
	ignoredPaths: { args: pageArgs, result: type({ total: countSchema, entries: ignoredSchema.array(), "+": "reject" }) },
	userIgnore: { args: noArgs, result: ignoreTextSchema },
	setUserIgnore: { args: type({ text: ignoreTextSchema, "+": "reject" }), result: done },
	defaultIgnore: { args: noArgs, result: textSchema.array() }
} as const

// Mounts. Every role serves the whole drive; the host runs one rclone for all of them and reconciles it to the last
// desired state main sent.

export const SERVE_PROTOCOLS = ["webdav", "s3", "ftp", "sftp", "http", "restic", "nfs"] as const satisfies readonly DesktopServeProtocol[]

export const serveProtocolSchema = pinned<DesktopServeProtocol>()(type.enumerated(...SERVE_PROTOCOLS))

const roleSchema = pinned<DesktopMountsRole>()(type.enumerated("drive", ...SERVE_PROTOCOLS))

const roleStateSchema = pinned<DesktopMountsRoleState>()(type("'off' | 'starting' | 'running' | 'stopping' | 'error'"))

// The protocols that can serve over https: the HTTP-based ones.
export const HTTPS_PROTOCOLS: ReadonlySet<DesktopServeProtocol> = new Set(["webdav", "s3", "http", "restic"])

const mountsErrorCodeSchema = pinned<DesktopMountsErrorCode>()(
	type.enumerated(
		"hostUnavailable",
		"fuseMissing",
		"mountPointInvalid",
		"mountPointNotEmpty",
		"mountPointInUse",
		"driveLetterInUse",
		"portInUse",
		"addressUnavailable",
		"authRequired",
		"uploadsPending",
		"unsupportedProtocol",
		"binaryInvalid",
		"unauthenticated",
		"timeout",
		"mountPointExpired",
		"credentialsInvalid",
		"credentialsWeak",
		"acknowledgementRequired",
		"unknown"
	)
)

export const mountsErrorSchema = pinned<DesktopMountsError>()(type({ code: mountsErrorCodeSchema, "message?": textSchema, "+": "reject" }))

export type NativeMountsError = DesktopMountsError

export const vfsTuningSchema = pinned<DesktopVfsTuning>()(
	type({
		cacheMaxGiB: "1 <= number.integer <= 65536",
		cacheMinFreeGiB: "0 <= number.integer <= 65536",
		cacheMaxAgeHours: "1 <= number.integer <= 87600",
		dirCacheSeconds: "1 <= number.integer <= 86400",
		"+": "reject"
	})
)

// The old client's tuning.
export const DEFAULT_TUNING: DesktopVfsTuning = { cacheMaxGiB: 32, cacheMinFreeGiB: 16, cacheMaxAgeHours: 720, dirCacheSeconds: 15 }

// An explicit listen address: an IP literal or "localhost", never empty (rclone would bind every interface).
export const listenHostSchema = type("string.ip").or("'localhost'")

export function isLoopbackHost(host: string): boolean {
	return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

export const portSchema = type("1 <= number.integer <= 65535")

// rclone splits basic credentials at ":" and its s3 key pair at ",".
const credentialTextSchema = type("0 < string <= 256").narrow(value => !/[:\p{Cc}]/u.test(value))

export const basicAuthSchema = type({ kind: "'basic'", user: credentialTextSchema, password: credentialTextSchema, "+": "reject" })

export const s3AuthSchema = type({
	kind: "'s3'",
	accessKeyId: /^[A-Za-z0-9]{16,128}$/,
	secretAccessKey: /^[A-Za-z0-9+/=_-]{16,128}$/,
	"+": "reject"
})

const serveAuthSchema = basicAuthSchema.or(s3AuthSchema).or({ kind: "'none'", "+": "reject" })

export type NativeServeAuth = typeof serveAuthSchema.infer

// The credentials a protocol takes: none for nfs, which has no authentication and only ever listens on loopback.
export function authKindOf(protocol: DesktopServeProtocol): NativeServeAuth["kind"] {
	return protocol === "nfs" ? "none" : protocol === "s3" ? "s3" : "basic"
}

const serveSchema = type({
	protocol: serveProtocolSchema,
	host: listenHostSchema,
	port: portSchema,
	auth: serveAuthSchema,
	tls: type({ cert: localPathSchema, key: localPathSchema, "+": "reject" }).or("null"),
	readOnly: "boolean",
	"+": "reject"
}).narrow(
	(serve, ctx) =>
		(serve.auth.kind === authKindOf(serve.protocol) || ctx.mustBe(`${serve.protocol} credentials`)) &&
		(serve.auth.kind !== "none" || isLoopbackHost(serve.host) || ctx.mustBe("a loopback address")) &&
		(serve.tls === null || HTTPS_PROTOCOLS.has(serve.protocol) || ctx.mustBe("served without tls"))
)

export type NativeServe = typeof serveSchema.infer

// The bundled rclone; `sha256` is checked where nothing re-signs the binary (Linux).
const binarySchema = type({ path: localPathSchema, sha256: type(/^[0-9a-f]{64}$/).or("null"), "+": "reject" })

const desiredSchema = type({
	binary: binarySchema,
	stateDir: localPathSchema,
	cacheDir: localPathSchema,
	logFile: localPathSchema.or("null"),
	tuning: vfsTuningSchema,
	drive: type({ mountPoint: localPathSchema, readOnly: "boolean", "+": "reject" }).or("null"),
	serves: serveSchema
		.array()
		.narrow(
			(serves, ctx) => new Set(serves.map(serve => serve.protocol)).size === serves.length || ctx.mustBe("one entry per protocol")
		),
	"+": "reject"
})

// Everything the host should run; anything running that this does not name is stopped.
export type NativeMountsDesired = typeof desiredSchema.infer

const nativeMountsStatusSchema = type({
	roles: type({ role: roleSchema, state: roleStateSchema, error: mountsErrorSchema.or("null"), "+": "reject" }).array(),
	// null while no rclone runs.
	uploads: type({ pending: countSchema, errored: countSchema, "+": "reject" }).or("null"),
	"+": "reject"
})

export type NativeMountsStatus = typeof nativeMountsStatusSchema.infer

const mountsStatsSchema = pinned<DesktopMountsStats>()(
	type({
		transfers: type({ name: textSchema, bytes: countSchema, total: countSchema, speed: countSchema, "+": "reject" }).array(),
		uploadsInProgress: countSchema,
		uploadsQueued: countSchema,
		"+": "reject"
	})
)

// A Windows drive letter the drive may take; A-C are never offered.
export const driveLetterSchema = type(/^[D-Z]$/)

const dirArgs = type({ dir: localPathSchema, "+": "reject" })

// rclone refuses to clear a cache the daemon on `stateDir` runs on.
const clearCacheArgs = type({ stateDir: localPathSchema, dir: localPathSchema, "+": "reject" })

// The calls that drive rclone. `quiesceLegacy` stops the old client's rclone and unmounts its stale mount; `drainCache`
// runs a temporary rclone on an old cache until its uploads finished or the timeout passed.
export const MOUNTS_OPS = {
	mountsApply: { args: type({ desired: desiredSchema, "+": "reject" }), result: nativeMountsStatusSchema },
	mountsStatus: { args: noArgs, result: nativeMountsStatusSchema },
	mountsStats: { args: noArgs, result: mountsStatsSchema },
	driveLetters: { args: noArgs, result: driveLetterSchema.array() },
	cacheUsage: { args: dirArgs, result: type({ usedBytes: countSchema, freeBytes: countSchema, "+": "reject" }) },
	clearCache: { args: clearCacheArgs, result: done },
	quiesceLegacy: {
		args: type({ binDir: localPathSchema, mountPoints: localPathSchema.array().atMostLength(16), "+": "reject" }),
		result: type({ stopped: countSchema, unmounted: localPathSchema.array(), "+": "reject" })
	},
	drainCache: {
		args: type({
			binary: binarySchema,
			stateDir: localPathSchema,
			dir: localPathSchema,
			timeoutMs: "1000 <= number.integer <= 7200000",
			"+": "reject"
		}),
		result: type({ pending: countSchema, errored: countSchema, "+": "reject" })
	}
} as const

export const transferIdSchema = type("string.uuid")

export const listingIdSchema = type("string.uuid")

const transferIdsArgs = type({ ids: transferIdSchema.array().moreThanLength(0).atMostLength(10_000), "+": "reject" })

const transferFilesSchema = type({ total: countSchema, done: countSchema, failed: countSchema, failedBytes: countSchema, "+": "reject" })

// An absolute local path on the host's platform.
export const absolutePathSchema = localPathSchema.narrow(value => path.isAbsolute(value))

// A stringifyEnvelope of a wasm-shaped SDK value (a File or Dir is under 2 KiB). It carries file keys: never logged.
export const SDK_VALUE_MAX_LENGTH = 8192

const sdkWireSchema = type("string > 0").atMostLength(SDK_VALUE_MAX_LENGTH)

export const sdkRefSchema = pinned<DesktopSdkRef>()(
	type({
		variant: type.enumerated(
			"AnyFile.File",
			"AnyFile.Shared",
			"AnyFile.Linked",
			"AnyNormalDir.Dir",
			"AnyNormalDir.Root",
			"AnyDirWithContext.Normal.Dir",
			"AnyDirWithContext.Normal.Root",
			"AnyDirWithContext.Shared.Dir",
			"AnyDirWithContext.Shared.Root",
			"AnyDirWithContext.Linked.Dir",
			"AnyDirWithContext.Linked.Root"
		),
		value: sdkWireSchema,
		"+": "reject"
	})
)

export const transferErrorSchema = pinned<DesktopTransferError>()(
	type({
		code: type.enumerated(
			"hostUnavailable",
			"timeout",
			"unauthenticated",
			"interrupted",
			"invalidItem",
			"localMissing",
			"localDenied",
			"localFull",
			"localInUse",
			"storageFull",
			"unknown"
		),
		"kind?": "string <= 64",
		"message?": textSchema,
		"+": "reject"
	})
)

const transferConflictSchema = type("'replace' | 'keepBoth'")

// downloadDirectory: the host creates a free name (keep both). downloadListed: a file of a held listing, written over
// what is there (temp directories only).
const transferSpecSchema = type({
	id: transferIdSchema,
	t: "'downloadFile'",
	file: sdkRefSchema,
	path: absolutePathSchema,
	conflict: transferConflictSchema,
	"+": "reject"
})
	.or({ id: transferIdSchema, t: "'downloadDirectory'", dir: sdkRefSchema, path: absolutePathSchema, "+": "reject" })
	.or({
		id: transferIdSchema,
		t: "'downloadListed'",
		listingId: listingIdSchema,
		index: countSchema,
		path: absolutePathSchema,
		"+": "reject"
	})
	.or({ id: transferIdSchema, t: "'uploadFile'", path: absolutePathSchema, parent: sdkRefSchema, "+": "reject" })
	.or({
		id: transferIdSchema,
		t: "'uploadDirectory'",
		path: absolutePathSchema,
		parent: sdkRefSchema,
		name: "0 < string <= 255",
		"+": "reject"
	})

export type NativeTransferSpec = typeof transferSpecSchema.infer

const TRANSFER_SDK_MAX_LENGTH = 16 * 1024 ** 2

function sdkLength(spec: NativeTransferSpec): number {
	switch (spec.t) {
		case "downloadFile":
			return spec.file.value.length
		case "downloadDirectory":
			return spec.dir.value.length
		case "downloadListed":
			return 0
		case "uploadFile":
		case "uploadDirectory":
			return spec.parent.value.length
	}
}

// One call's SDK values together, from the lengths already checked: no second walk.
function sdkValuesFit(specs: NativeTransferSpec[]): boolean {
	let total = 0

	for (const spec of specs) {
		total += sdkLength(spec)
	}

	return total <= TRANSFER_SDK_MAX_LENGTH
}

// segments: raw remote names, the dragged item's name first. listIndex: the file's index in the held listing, null
// for directories and for top-level file items (downloaded by ref). source: the index of the dragged item.
export const treeEntrySchema = type({
	segments: "string[] > 0",
	directory: "boolean",
	size: countSchema,
	mtimeMs: countSchema.or("null"),
	listIndex: countSchema.or("null"),
	source: countSchema,
	"+": "reject"
})

export type NativeTreeEntry = typeof treeEntrySchema.infer

// The calls that run drive transfers on real paths. transfersListTree lists each directory item once
// (listDirRecursiveWithPaths); the host keeps the files under `listingId` until released, restarted or 30 min unused.
export const TRANSFER_OPS = {
	transfersStart: {
		args: type({ specs: transferSpecSchema.array().moreThanLength(0).atMostLength(10_000), "+": "reject" }).narrow(
			(args, ctx) => sdkValuesFit(args.specs) || ctx.mustBe("SDK values of at most 16 MiB together")
		),
		result: done
	},
	transfersCancel: { args: transferIdsArgs, result: done },
	transfersPause: { args: transferIdsArgs.merge({ paused: "boolean" }), result: done },
	transfersListTree: {
		args: type({
			listingId: listingIdSchema,
			items: type({ ref: sdkRefSchema, name: "0 < string <= 1024", "+": "reject" }).array().moreThanLength(0).atMostLength(10_000),
			maxEntries: "1 <= number.integer <= 10000",
			"+": "reject"
		}),
		result: type({ entries: treeEntrySchema.array().atMostLength(10_000), "+": "reject" }).or({ tooMany: countSchema, "+": "reject" })
	},
	transfersReleaseTree: { args: type({ listingId: listingIdSchema, "+": "reject" }), result: done }
} as const

export const NATIVE_OPS = { ...SYNC_OPS, ...MOUNTS_OPS, ...TRANSFER_OPS } as const

export type SyncOp = keyof typeof SYNC_OPS

export type MountsOp = keyof typeof MOUNTS_OPS

export type TransfersOp = keyof typeof TRANSFER_OPS

export type NativeOp = keyof typeof NATIVE_OPS

export function isMountsOp(op: NativeOp): op is MountsOp {
	return Object.hasOwn(MOUNTS_OPS, op)
}

export function isTransfersOp(op: NativeOp): op is TransfersOp {
	return Object.hasOwn(TRANSFER_OPS, op)
}

const transferEventSchema = type({
	k: "'progress'",
	id: transferIdSchema,
	size: countSchema,
	bytes: countSchema,
	files: transferFilesSchema.or("null"),
	"+": "reject"
}).or({
	k: "'settled'",
	id: transferIdSchema,
	outcome: "'done' | 'completedWithErrors' | 'error' | 'cancelled'",
	"error?": transferErrorSchema,
	// The created File or Dir of an upload, wasm-shaped.
	"uploaded?": sdkWireSchema,
	// Where a download landed when the host picked the name.
	"savedPath?": absolutePathSchema,
	"+": "reject"
})

export type NativeTransferEvent = typeof transferEventSchema.infer

// One host message per feed round.
export const TRANSFER_EVENTS_MAX = 20_000

export type NativeOpArgs<K extends NativeOp> = (typeof NATIVE_OPS)[K]["args"]["infer"]

export type NativeOpResult<K extends NativeOp> = (typeof NATIVE_OPS)[K]["result"]["infer"]

export function opArgs<K extends NativeOp>(op: K): (typeof NATIVE_OPS)[K]["args"] {
	return NATIVE_OPS[op].args
}

export function opResult<K extends NativeOp>(op: K): (typeof NATIVE_OPS)[K]["result"] {
	return NATIVE_OPS[op].result
}

// What a failed call may report: a mounts or transfers call its own codes, an engine call the sync ones.
export function opError(op: NativeOp): Type<DesktopSyncError> | Type<DesktopMountsError> | Type<DesktopTransferError> {
	if (isMountsOp(op)) {
		return mountsErrorSchema
	}

	return isTransfersOp(op) ? transferErrorSchema : nativeErrorSchema
}

const opSchema = type.enumerated(...(Object.keys(NATIVE_OPS) as NativeOp[]))

const callIdSchema = countSchema

export interface NativeInit {
	t: "init"
	addonPath: string
	// The user's engine directory: baseline.db and cache.db.
	dir: string
	// The vault's session blob; it never travels in the environment or argv.
	session: string
	logLevel: "Info" | "Debug"
	// The remote roots of the pairs main holds back (preparing or in review): paused before any watch starts.
	holdRemotes: string[]
}

export type NativeCall = { [K in NativeOp]: { t: "call"; id: number; op: K; args: NativeOpArgs<K> } }[NativeOp]

// `overview`: the sync runtime; `mounts`: mounts stats at 1 Hz. `reconnectSocket`: the network may be back, so the
// client's socket cuts a reconnect backoff short; no reply.
export type ToNative =
	NativeInit | NativeCall | { t: "subscribe"; overview: boolean; mounts: boolean } | { t: "reconnectSocket" } | { t: "shutdown" }

const initSchema = pinned<NativeInit>()(
	type({
		t: "'init'",
		addonPath: localPathSchema,
		dir: localPathSchema,
		session: type("string > 0").atMostLength(SESSION_BLOB_MAX_LENGTH),
		logLevel: "'Info' | 'Debug'",
		holdRemotes: type("string.uuid").array(),
		"+": "reject"
	})
)

const callSchema = type({ t: "'call'", id: callIdSchema, op: opSchema, args: "unknown", "+": "reject" }).narrow((call, ctx) => {
	const args: Type<unknown> = NATIVE_OPS[call.op].args

	return !(args(call.args) instanceof type.errors) || ctx.mustBe(`valid ${call.op} arguments`)
})

export const toNativeSchema = initSchema
	.or(callSchema)
	.or({ t: "'subscribe'", overview: "boolean", mounts: "boolean", "+": "reject" })
	.or({ t: "'reconnectSocket'", "+": "reject" })
	.or({ t: "'shutdown'", "+": "reject" })
	.as<ToNative>()

export type NativeAggregate = "idle" | "syncing" | "attention"

// Why the host gave up before it was ready.
export type NativeFatalReason = "addonLoad" | "session" | "baselineInUse" | "open"

// A reply's `value` is checked against `opResult` of the call it answers.
export type FromNative =
	| { t: "ready"; pairs: NativePair[]; reset: boolean }
	| { t: "reply"; id: number; ok: true; value: unknown }
	| { t: "reply"; id: number; ok: false; error: NativeError | NativeMountsError | DesktopTransferError }
	| { t: "overview"; pairs: NativePairRuntime[] }
	| { t: "aggregate"; state: NativeAggregate }
	| { t: "activity"; entries: NativeActivity[] }
	| { t: "passEnded"; pairId: string }
	| { t: "mounts"; status: NativeMountsStatus }
	| { t: "mountsStats"; stats: DesktopMountsStats }
	| { t: "transfers"; events: NativeTransferEvent[] }
	| { t: "authRevoked" }
	| { t: "fatal"; reason: NativeFatalReason }
	| { t: "stopped" }

export const fromNativeSchema = pinned<FromNative>()(
	type({ t: "'ready'", pairs: nativePairSchema.array(), reset: "boolean", "+": "reject" })
		.or({ t: "'reply'", id: callIdSchema, ok: "true", value: "unknown", "+": "reject" })
		.or({
			t: "'reply'",
			id: callIdSchema,
			ok: "false",
			error: nativeErrorSchema.or(mountsErrorSchema).or(transferErrorSchema),
			"+": "reject"
		})
		.or({ t: "'overview'", pairs: nativePairRuntimeSchema.array(), "+": "reject" })
		.or({ t: "'aggregate'", state: "'idle' | 'syncing' | 'attention'", "+": "reject" })
		.or({ t: "'activity'", entries: nativeActivitySchema.array(), "+": "reject" })
		.or({ t: "'passEnded'", pairId: pairIdSchema, "+": "reject" })
		.or({ t: "'mounts'", status: nativeMountsStatusSchema, "+": "reject" })
		.or({ t: "'mountsStats'", stats: mountsStatsSchema, "+": "reject" })
		.or({ t: "'transfers'", events: transferEventSchema.array().atMostLength(TRANSFER_EVENTS_MAX), "+": "reject" })
		.or({ t: "'authRevoked'", "+": "reject" })
		.or({ t: "'fatal'", reason: "'addonLoad' | 'session' | 'baselineInUse' | 'open'", "+": "reject" })
		.or({ t: "'stopped'", "+": "reject" })
)
