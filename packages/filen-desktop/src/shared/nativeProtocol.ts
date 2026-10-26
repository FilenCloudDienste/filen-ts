import { type, type Type } from "arktype"
import type {
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
	DesktopSyncUnsyncable
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

// What evaluatePlan found. `legacyHits` (only with a `check`): paths the plan would sync that the old client's rules
// hid, with a few of them as a sample.
const evaluationSchema = type({ status: "'unconverged'", "+": "reject" }).or({
	status: "'ok'",
	planId: planIdSchema,
	summary: nativePlanSummarySchema,
	legacyHits: type({ count: countSchema, sample: relPathSchema.array().atMostLength(20), "+": "reject" }).or("null"),
	"+": "reject"
})

// Every engine call main can make, with its arguments and result.
export const NATIVE_OPS = {
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
		args: type({ pairId: pairIdSchema, "check?": type({ excludeDotFiles: "boolean", "+": "reject" }), "+": "reject" }),
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

export type NativeOp = keyof typeof NATIVE_OPS

export type NativeOpArgs<K extends NativeOp> = (typeof NATIVE_OPS)[K]["args"]["infer"]

export type NativeOpResult<K extends NativeOp> = (typeof NATIVE_OPS)[K]["result"]["infer"]

export function opArgs<K extends NativeOp>(op: K): (typeof NATIVE_OPS)[K]["args"] {
	return NATIVE_OPS[op].args
}

export function opResult<K extends NativeOp>(op: K): (typeof NATIVE_OPS)[K]["result"] {
	return NATIVE_OPS[op].result
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

export type ToNative = NativeInit | NativeCall | { t: "subscribe"; overview: boolean } | { t: "shutdown" }

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
	.or({ t: "'subscribe'", overview: "boolean", "+": "reject" })
	.or({ t: "'shutdown'", "+": "reject" })
	.as<ToNative>()

export type NativeAggregate = "idle" | "syncing" | "attention"

// Why the host gave up before it was ready.
export type NativeFatalReason = "addonLoad" | "session" | "baselineInUse" | "open"

// A reply's `value` is checked against `opResult` of the call it answers.
export type FromNative =
	| { t: "ready"; pairs: NativePair[]; reset: boolean }
	| { t: "reply"; id: number; ok: true; value: unknown }
	| { t: "reply"; id: number; ok: false; error: NativeError }
	| { t: "overview"; pairs: NativePairRuntime[] }
	| { t: "aggregate"; state: NativeAggregate }
	| { t: "activity"; entries: NativeActivity[] }
	| { t: "authRevoked" }
	| { t: "fatal"; reason: NativeFatalReason }
	| { t: "stopped" }

export const fromNativeSchema = pinned<FromNative>()(
	type({ t: "'ready'", pairs: nativePairSchema.array(), reset: "boolean", "+": "reject" })
		.or({ t: "'reply'", id: callIdSchema, ok: "true", value: "unknown", "+": "reject" })
		.or({ t: "'reply'", id: callIdSchema, ok: "false", error: nativeErrorSchema, "+": "reject" })
		.or({ t: "'overview'", pairs: nativePairRuntimeSchema.array(), "+": "reject" })
		.or({ t: "'aggregate'", state: "'idle' | 'syncing' | 'attention'", "+": "reject" })
		.or({ t: "'activity'", entries: nativeActivitySchema.array(), "+": "reject" })
		.or({ t: "'authRevoked'", "+": "reject" })
		.or({ t: "'fatal'", reason: "'addonLoad' | 'session' | 'baselineInUse' | 'open'", "+": "reject" })
		.or({ t: "'stopped'", "+": "reject" })
)
