import { type, type Type } from "arktype"
import type {
	DesktopFuseStatus,
	DesktopMountsError,
	DesktopMountsErrorCode,
	DesktopMountsRole,
	DesktopMountsRoleState,
	DesktopMountsStats,
	DesktopServeProtocol,
	DesktopSyncActivity,
	DesktopSyncActivityKind,
	DesktopSyncConflict,
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
	DesktopSyncTransfer,
	DesktopSyncUnsyncable,
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
	type("'scanIncomplete' | 'firstSyncWithDeletions' | 'remoteUnconverged' | 'remoteEmptied' | 'exceededThreshold'")
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
		"accountRoot",
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
		"quarantined",
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

// A pair as the engine holds it.
const nativePairSchema = type({ ...pairFields, "+": "reject" })

export type NativePair = typeof nativePairSchema.infer

const transferSchema = pinned<DesktopSyncTransfer>()(
	type({ relPath: relPathSchema, direction: "'upload' | 'download'", bytes: countSchema, total: countSchema, "+": "reject" })
)

const issueCountsSchema = pinned<DesktopSyncIssueCounts>()(
	type({ conflicts: countSchema, heldDeletions: countSchema, unsyncable: countSchema, failed: countSchema, "+": "reject" })
)

// A pair plus what the host knows live about it.
const nativePairRuntimeSchema = type({
	...pairFields,
	syncing: "boolean",
	progress: type({ done: countSchema, total: countSchema, "+": "reject" }).or("null"),
	transfers: transferSchema.array(),
	lastSyncedAt: countSchema.or("null"),
	lastError: textSchema.or("null"),
	issues: issueCountsSchema,
	degraded: type({ local: "boolean", remote: "boolean", "+": "reject" }),
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
	refused: type("'remoteCollision' | 'localCollision' | null")
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

const unsyncableSchema = pinned<DesktopSyncUnsyncable>()(
	type({
		relPath: relPathSchema,
		reason: "'invalidName' | 'repeatedFailure' | 'remoteUndecodable' | 'remoteInvalidName' | 'remoteBrokenParent' | 'localAlias'",
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

const heldDeletionsSchema = pinned<DesktopSyncHeldDeletions>()(
	type({
		passToken: passTokenSchema.or("null"),
		reason: heldReasonSchema.or("null"),
		total: countSchema,
		entries: planActionSchema.array(),
		"+": "reject"
	})
)

export const planIdSchema = type("0 < string <= 64")

// The engine pages at most 1000 entries at a time.
const pageLimitSchema = type("1 <= number.integer <= 1000")

// An ignore text: the engine allows 1 MiB per rule file.
export const ignoreTextSchema = type("string <= 1048576")

const noArgs = type({ "+": "reject" })
const pairArgs = type({ pairId: pairIdSchema, "+": "reject" })
const pageArgs = type({ pairId: pairIdSchema, offset: countSchema, limit: pageLimitSchema, "+": "reject" })
const done = type("null")

// What evaluatePlan found. `check` (only when asked for): the first-run guard's scan of the plan's actions. The summary's
// action count includes the adoptions that transfer nothing, so the scan counts the uploads and downloads; with `legacy`
// it also finds the paths the plan would sync that the old client's rules hid, with a few of them as a sample.
const evaluationSchema = type({ status: "'unconverged'", "+": "reject" }).or({
	status: "'ok'",
	planId: planIdSchema,
	summary: nativePlanSummarySchema,
	check: type({
		uploads: countSchema,
		downloads: countSchema,
		legacyHits: type({ count: countSchema, sample: relPathSchema.array().atMostLength(20), "+": "reject" }).or("null"),
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
	evaluatePlan: {
		args: type({
			pairId: pairIdSchema,
			"check?": type({ legacy: type({ excludeDotFiles: "boolean", "+": "reject" }).or("null"), "+": "reject" }),
			"+": "reject"
		}),
		result: evaluationSchema
	},
	planPage: {
		args: type({ planId: planIdSchema, list: planListSchema, offset: countSchema, limit: pageLimitSchema, "+": "reject" }),
		result: planPageSchema
	},
	releasePlan: { args: type({ planId: planIdSchema, "+": "reject" }), result: done },
	conflicts: { args: pageArgs, result: type({ total: countSchema, entries: conflictSchema.array(), "+": "reject" }) },
	// The result is where keepBoth put the local copy.
	resolveConflict: {
		args: type({
			pairId: pairIdSchema,
			relPath: relPathArgSchema,
			resolution: "'keepLocal' | 'keepRemote' | 'keepBoth'",
			"+": "reject"
		}),
		result: relPathSchema.or("null")
	},
	heldDeletions: { args: pairArgs, result: heldDeletionsSchema },
	approveDeletions: { args: type({ pairId: pairIdSchema, passToken: passTokenSchema, "+": "reject" }), result: done },
	retryPath: { args: type({ pairId: pairIdSchema, relPath: relPathArgSchema, "+": "reject" }), result: done },
	ignoredPaths: { args: pageArgs, result: type({ total: countSchema, entries: ignoredSchema.array(), "+": "reject" }) },
	userIgnore: { args: noArgs, result: ignoreTextSchema },
	setUserIgnore: { args: type({ text: ignoreTextSchema, "+": "reject" }), result: done },
	defaultIgnore: { args: noArgs, result: textSchema.array() },
	// "unsupported" while the engine has no way to seed a pair from the old client's state.
	seedLegacy: { args: pairArgs, result: type("'seeded' | 'unsupported'") }
} as const

// Mounts. Every role serves the whole drive; the host runs one rclone for all of them and reconciles it to the last
// desired state main sent.

export const SERVE_PROTOCOLS = ["webdav", "s3", "ftp", "sftp", "http", "restic", "nfs"] as const satisfies readonly DesktopServeProtocol[]

const serveProtocolSchema = pinned<DesktopServeProtocol>()(type.enumerated(...SERVE_PROTOCOLS))

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

const fuseStatusSchema = pinned<DesktopFuseStatus>()(
	type({ state: "'ready'", provider: "'macFuse' | 'nfsMount' | 'winFsp' | 'fuse3'", "+": "reject" }).or({
		state: "'missing'",
		installable: "boolean",
		"+": "reject"
	})
)

// A Windows drive letter the drive may take; A-C are never offered.
export const driveLetterSchema = type(/^[D-Z]$/)

const dirArgs = type({ dir: localPathSchema, "+": "reject" })

// The calls that drive rclone. `quiesceLegacy` stops the old client's rclone and unmounts its stale mount; `drainCache`
// runs a temporary rclone on an old cache until its uploads finished or the timeout passed.
export const MOUNTS_OPS = {
	mountsApply: { args: type({ desired: desiredSchema, "+": "reject" }), result: nativeMountsStatusSchema },
	mountsStatus: { args: noArgs, result: nativeMountsStatusSchema },
	mountsStats: { args: noArgs, result: mountsStatsSchema },
	fuseStatus: { args: noArgs, result: fuseStatusSchema },
	driveLetters: { args: noArgs, result: driveLetterSchema.array() },
	cacheUsage: { args: dirArgs, result: type({ usedBytes: countSchema, freeBytes: countSchema, "+": "reject" }) },
	clearCache: { args: dirArgs, result: done },
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

export const NATIVE_OPS = { ...SYNC_OPS, ...MOUNTS_OPS } as const

export type SyncOp = keyof typeof SYNC_OPS

export type MountsOp = keyof typeof MOUNTS_OPS

export type NativeOp = keyof typeof NATIVE_OPS

export function isMountsOp(op: NativeOp): op is MountsOp {
	return Object.hasOwn(MOUNTS_OPS, op)
}

export type NativeOpArgs<K extends NativeOp> = (typeof NATIVE_OPS)[K]["args"]["infer"]

export type NativeOpResult<K extends NativeOp> = (typeof NATIVE_OPS)[K]["result"]["infer"]

export function opArgs<K extends NativeOp>(op: K): (typeof NATIVE_OPS)[K]["args"] {
	return NATIVE_OPS[op].args
}

export function opResult<K extends NativeOp>(op: K): (typeof NATIVE_OPS)[K]["result"] {
	return NATIVE_OPS[op].result
}

// What a failed call may report: a mounts call its own codes, an engine call the sync ones.
export function opError(op: NativeOp): Type<DesktopSyncError> | Type<DesktopMountsError> {
	return isMountsOp(op) ? mountsErrorSchema : nativeErrorSchema
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
}

export type NativeCall = { [K in NativeOp]: { t: "call"; id: number; op: K; args: NativeOpArgs<K> } }[NativeOp]

// `overview`: the sync runtime; `mounts`: mounts stats at 1 Hz.
export type ToNative = NativeInit | NativeCall | { t: "subscribe"; overview: boolean; mounts: boolean } | { t: "shutdown" }

const initSchema = pinned<NativeInit>()(
	type({
		t: "'init'",
		addonPath: localPathSchema,
		dir: localPathSchema,
		session: type("string > 0").atMostLength(SESSION_BLOB_MAX_LENGTH),
		logLevel: "'Info' | 'Debug'",
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
	.or({ t: "'shutdown'", "+": "reject" })
	.as<ToNative>()

export type NativeAggregate = "idle" | "syncing" | "attention"

// Why the host gave up before it was ready.
export type NativeFatalReason = "addonLoad" | "session" | "baselineInUse" | "open"

// A reply's `value` is checked against `opResult` of the call it answers.
export type FromNative =
	| { t: "ready"; pairs: NativePair[]; reset: boolean }
	| { t: "reply"; id: number; ok: true; value: unknown }
	| { t: "reply"; id: number; ok: false; error: NativeError | NativeMountsError }
	| { t: "overview"; pairs: NativePairRuntime[] }
	| { t: "aggregate"; state: NativeAggregate }
	| { t: "activity"; entries: NativeActivity[] }
	| { t: "mounts"; status: NativeMountsStatus }
	| { t: "mountsStats"; stats: DesktopMountsStats }
	| { t: "authRevoked" }
	| { t: "fatal"; reason: NativeFatalReason }
	| { t: "stopped" }

export const fromNativeSchema = pinned<FromNative>()(
	type({ t: "'ready'", pairs: nativePairSchema.array(), reset: "boolean", "+": "reject" })
		.or({ t: "'reply'", id: callIdSchema, ok: "true", value: "unknown", "+": "reject" })
		.or({ t: "'reply'", id: callIdSchema, ok: "false", error: nativeErrorSchema.or(mountsErrorSchema), "+": "reject" })
		.or({ t: "'overview'", pairs: nativePairRuntimeSchema.array(), "+": "reject" })
		.or({ t: "'aggregate'", state: "'idle' | 'syncing' | 'attention'", "+": "reject" })
		.or({ t: "'activity'", entries: nativeActivitySchema.array(), "+": "reject" })
		.or({ t: "'mounts'", status: nativeMountsStatusSchema, "+": "reject" })
		.or({ t: "'mountsStats'", stats: mountsStatsSchema, "+": "reject" })
		.or({ t: "'authRevoked'", "+": "reject" })
		.or({ t: "'fatal'", reason: "'addonLoad' | 'session' | 'baselineInUse' | 'open'", "+": "reject" })
		.or({ t: "'stopped'", "+": "reject" })
)
