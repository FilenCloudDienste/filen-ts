import { UniffiEnum } from "uniffi-bindgen-react-native"
import logger from "@/lib/logger"

const uniffiTypeNameSymbol = Symbol.for("typeName")

// The global JSON object and the built-in prototypes are deliberately left untouched —
// plain JSON.stringify/JSON.parse anywhere else in the app behave stock. Values native
// JSON can't represent (BigInt, UniFFI tagged unions, binary views) cross through the
// envelope objects below, produced/consumed only by serialize()/deserialize().

// ─── Encoding (serialize) ───────────────────────────────────────────────────
// Copy-on-write pre-walk: subtrees without envelope-needing values pass through
// by reference (zero allocation, fully-native stringify), and inputs are never
// mutated. A walk beats a JSON.stringify replacer here: a replacer pays a
// native→JS call for every key, the walk only pays for containers.

function encodeBinary(view: ArrayBufferView): {
	__bin: 1
	k: string
	d: string
} {
	const bytes = view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength)

	return {
		__bin: 1,
		k: view.constructor.name,
		d: Buffer.from(bytes).toString("base64")
	}
}

// Structured plain-object form of an Error: name/message/stack/cause are non-enumerable (so a plain
// key-walk emits {}), and a richer error may carry custom own props (Node fs: .code/.path; HTTP:
// .status). Children are encoded so a bigint/typed-array/cause-error nested in props survives.
function encodeError(err: Error): Record<string, unknown> {
	const out: Record<string, unknown> = {
		name: err.name,
		message: err.message,
		stack: err.stack
	}

	for (const key of Object.keys(err)) {
		if (key === "name" || key === "message" || key === "stack" || key === "cause") {
			continue
		}

		out[key] = encodeValue((err as unknown as Record<string, unknown>)[key])
	}

	const cause = (err as { cause?: unknown }).cause

	if (cause !== undefined) {
		out["cause"] = encodeValue(cause)
	}

	return out
}

function encodeValue(value: unknown): unknown {
	if (value === null) {
		return value
	}

	const valueType = typeof value

	if (valueType !== "object") {
		return valueType === "bigint"
			? {
					__bi: 1,
					v: (value as bigint).toString()
				}
			: value
	}

	if (Array.isArray(value)) {
		let copy: unknown[] | null = null

		for (let i = 0; i < value.length; i++) {
			const child: unknown = value[i]
			// Inline primitive fast path: most leaves are strings/numbers/booleans —
			// skip the recursive call entirely for them.
			const childType = typeof child
			const encoded =
				child !== null && childType === "object"
					? encodeValue(child)
					: childType === "bigint"
						? {
								__bi: 1,
								v: (child as bigint).toString()
							}
						: child

			if (copy !== null) {
				copy[i] = encoded
			} else if (encoded !== child) {
				copy = value.slice(0, i)
				copy.length = value.length
				copy[i] = encoded
			}
		}

		return copy ?? value
	}

	// Plain-object fast gate: objects built by literals/spreads/JSON have
	// `constructor === Object`, can't be enum instances or binary views, and only
	// need an own-toJSON probe. Everything else (false negatives like
	// Object.create(null) or data with a "constructor" key) falls through to the
	// complete dispatch chain below — slower, never incorrect.
	if ((value as object).constructor !== Object) {
		if (value instanceof UniffiEnum) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const enumValue = value as any
			const inner = enumValue.inner

			return typeof inner !== "undefined" && inner != null
				? {
						__ue: 1,
						tn: enumValue[uniffiTypeNameSymbol],
						t: enumValue.tag,
						i: encodeValue(inner)
					}
				: {
						__ue: 1,
						tn: enumValue[uniffiTypeNameSymbol],
						t: enumValue.tag
					}
		}

		// Binary checks must precede the toJSON pass-through: Buffer defines its own
		// (verbose) toJSON, but it must serialize as our compact base64 envelope.
		if (ArrayBuffer.isView(value)) {
			return encodeBinary(value)
		}

		if (value instanceof ArrayBuffer) {
			return {
				__bin: 1,
				k: "ArrayBuffer",
				d: Buffer.from(new Uint8Array(value)).toString("base64")
			}
		}

		// Error: name/message/stack/cause are NON-enumerable, so the plain key-walk below would emit
		// {} and bare JSON.stringify would too. Encode to a structured plain object (lossy — it does
		// NOT revive to a real Error, nothing needs that; logs/diagnostics want the fields, persistence
		// previously got {}). Keeps the stack, the chained cause, and any custom own props.
		if (value instanceof Error) {
			return encodeError(value)
		}

		// Map / Set: bare JSON yields {} (their contents live behind iteration, not own keys). Encode as
		// round-trip envelopes so deserialize restores real Map/Set instances.
		if (value instanceof Map) {
			const entries = new Array<[unknown, unknown]>(value.size)
			let i = 0

			for (const [k, v] of value) {
				entries[i++] = [encodeValue(k), encodeValue(v)]
			}

			return {
				__map: 1,
				e: entries
			}
		}

		if (value instanceof Set) {
			const values = new Array<unknown>(value.size)
			let i = 0

			for (const v of value) {
				values[i++] = encodeValue(v)
			}

			return {
				__set: 1,
				v: values
			}
		}
	}

	if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
		// Objects with their own toJSON (Date, third-party types) keep stock
		// JSON.stringify semantics — the native serializer invokes it.
		return value
	}

	// Object.keys + indexed loop: measured decisively faster than for-in here
	// (for-in cost V8 +44% on the envelope-dense serialize benchmark).
	const obj = value as Record<string, unknown>
	const keys = Object.keys(obj)
	const keyCount = keys.length
	let copy: Record<string, unknown> | null = null

	for (let i = 0; i < keyCount; i++) {
		const key = keys[i] as string
		const child = obj[key]
		const childType = typeof child
		const encoded =
			child !== null && childType === "object"
				? encodeValue(child)
				: childType === "bigint"
					? {
							__bi: 1,
							v: (child as bigint).toString()
						}
					: child

		if (copy !== null) {
			copy[key] = encoded
		} else if (encoded !== child) {
			copy = {}

			for (let j = 0; j < i; j++) {
				const priorKey = keys[j] as string

				copy[priorKey] = obj[priorKey]
			}

			copy[key] = encoded
		}
	}

	return copy ?? value
}

// ─── Decoding (deserialize) ─────────────────────────────────────────────────
// JSON.parse with a reviver pays a native→JS call for EVERY key of every parsed
// object — for multi-MB boot-restore payloads that is millions of calls, nearly
// all returning the value unchanged. Instead: parse fully natively, then revive
// envelopes in one JS walk that recurses into containers only; primitive
// properties cost an inline typeof check, not a call.

const BINARY_CONSTRUCTORS: Record<string, new (buffer: ArrayBuffer) => ArrayBufferView> = {
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array,
	BigInt64Array,
	BigUint64Array
}

function reviveBinary(envelope: { k: string; d: string }): ArrayBufferView | ArrayBuffer {
	const bytes = Buffer.from(envelope.d, "base64")
	const kind = envelope.k

	if (kind === "Buffer") {
		return bytes
	}

	if (kind === "Uint8Array") {
		return new Uint8Array(bytes)
	}

	// Buffer.from(base64) may share memory from a pool; copy into a fresh
	// ArrayBuffer of exactly the decoded byte length before constructing the view.
	const fresh = new Uint8Array(bytes).buffer

	if (kind === "ArrayBuffer") {
		return fresh
	}

	if (kind === "DataView") {
		return new DataView(fresh)
	}

	const ctor = BINARY_CONSTRUCTORS[kind]

	if (!ctor) {
		return new Uint8Array(bytes)
	}

	return new ctor(fresh)
}

// Constructor with UniffiEnum's EXACT prototype: `new` is faster than
// Object.create and the revived object is indistinguishable from before
// (same prototype identity, so instanceof and re-serialization both work).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const RevivedUniffiEnum = function (this: unknown) {} as unknown as new () => any

RevivedUniffiEnum.prototype = UniffiEnum.prototype

function reviveUniffiEnum(envelope: Record<string, unknown>): unknown {
	// Envelope fields are revived explicitly (children-before-parent, matching
	// reviver order) since the generic key walk is skipped for envelopes.
	let typeName = envelope["tn"]

	if (typeName !== null && typeof typeName === "object") {
		typeName = reviveContainer(typeName)
	}

	let tag = envelope["t"]

	if (tag !== null && typeof tag === "object") {
		tag = reviveContainer(tag)
	}

	const ue = new RevivedUniffiEnum()

	// Plain assignment creates the same all-true property descriptor the old
	// Object.defineProperty call did, at a fraction of the cost.
	ue[uniffiTypeNameSymbol] = typeName
	ue.tag = tag

	const inner = envelope["i"]

	if (inner != null) {
		const revived = typeof inner === "object" ? reviveContainer(inner) : inner

		ue.inner = Array.isArray(revived) ? Object.freeze(revived) : revived
	}

	return ue
}

// Depth-first in-place revival of a freshly-parsed JSON tree (children before
// parents, matching reviver order, so envelope inners are already revived when
// the envelope itself is transformed). Mutating is safe: the tree is private
// JSON.parse output that nothing else references yet. Envelopes dispatch
// BEFORE the generic key walk — they are the most common objects in our
// payloads and need no walk of their own (their relevant fields are revived
// explicitly), ordered by observed frequency: __bi, __ue, __bin.
function reviveContainer(value: object): unknown {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const child: unknown = value[i]

			if (child !== null && typeof child === "object") {
				const revived = reviveContainer(child)

				if (revived !== child) {
					value[i] = revived
				}
			}
		}

		return value
	}

	const obj = value as Record<string, unknown>

	if (obj["__bi"] === 1) {
		let v = obj["v"]

		if (v !== null && typeof v === "object") {
			v = reviveContainer(v)
		}

		// BigInt() throws SyntaxError on a non-integer string (truncated/corrupt DB
		// value, NaN, empty string). Degrade to null instead of aborting the whole
		// deserialize so a single bad envelope can't crash deserialization.
		// (Measured: a BigInt(+v) double fast path is NOT faster — keep the exact parse.)
		try {
			return BigInt(v as string)
		} catch {
			return null
		}
	}

	if (obj["__ue"] === 1) {
		return reviveUniffiEnum(obj)
	}

	if (obj["__bin"] === 1) {
		return reviveBinary(obj as { k: string; d: string })
	}

	if (obj["__map"] === 1) {
		const entries = obj["e"] as [unknown, unknown][]
		const map = new Map<unknown, unknown>()

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i] as [unknown, unknown]
			const k = entry[0]
			const v = entry[1]

			map.set(
				k !== null && typeof k === "object" ? reviveContainer(k) : k,
				v !== null && typeof v === "object" ? reviveContainer(v) : v
			)
		}

		return map
	}

	if (obj["__set"] === 1) {
		const values = obj["v"] as unknown[]
		const set = new Set<unknown>()

		for (let i = 0; i < values.length; i++) {
			const v = values[i]

			set.add(v !== null && typeof v === "object" ? reviveContainer(v) : v)
		}

		return set
	}

	// for-in here, Object.keys in the encoder: measured — the in-place mutating
	// decoder walk is fastest with for-in, the copy-on-write encoder walk with a
	// keys array. (for-in also allocates nothing.)
	for (const key in obj) {
		const child = obj[key]

		if (child !== null && typeof child === "object") {
			const revived = reviveContainer(child)

			if (revived !== child) {
				obj[key] = revived
			}
		}
	}

	return obj
}

// ─── Public API ─────────────────────────────────────────────────────────────

// Lazily constructed (not at module eval): the diagnostic logger now imports this module, which
// loads during the console polyfill at the very start of boot — before TextDecoder is guaranteed
// available. Building it on first use (a real deserialize) keeps module evaluation side-effect-free.
let utf8Decoder: TextDecoder | null = null

export function serialize(value: unknown): string {
	return JSON.stringify(encodeValue(value))
}

// Structural "would serialize to equal content" check WITHOUT building either string — used by
// hot fixed-point detection (e.g. offline reconcile no-op passes over 100k-entry metas). It can
// early-exit on the first difference and allocates nothing.
//
// Contract: a `true` result means both values hold the same serializable content (same plain
// object keys/values, same array elements, same primitives/bigints, same UniffiEnum
// typeName/tag/inner). Anything this walk does not fully understand (objects with their own
// toJSON like Date, binary views, Maps/Sets, foreign class instances) conservatively returns
// `false` — callers fall back to their full serialize comparison, so false negatives only cost
// time while false positives are impossible.
export function serializeEquals(a: unknown, b: unknown): boolean {
	if (a === b) {
		return true
	}

	if (a === null || b === null) {
		return false
	}

	const typeOfA = typeof a

	if (typeOfA !== typeof b || typeOfA !== "object") {
		// Distinct primitives (incl. bigint) — `a === b` above already ruled out equality.
		return false
	}

	const aIsArray = Array.isArray(a)

	if (aIsArray !== Array.isArray(b)) {
		return false
	}

	if (aIsArray) {
		const arrayA = a as unknown[]
		const arrayB = b as unknown[]

		if (arrayA.length !== arrayB.length) {
			return false
		}

		for (let i = 0; i < arrayA.length; i++) {
			if (!serializeEquals(arrayA[i], arrayB[i])) {
				return false
			}
		}

		return true
	}

	const aIsEnum = a instanceof UniffiEnum
	const bIsEnum = b instanceof UniffiEnum

	if (aIsEnum !== bIsEnum) {
		return false
	}

	if (aIsEnum) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const enumA = a as any
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const enumB = b as any

		return (
			enumA[uniffiTypeNameSymbol] === enumB[uniffiTypeNameSymbol] &&
			enumA.tag === enumB.tag &&
			serializeEquals(enumA.inner, enumB.inner)
		)
	}

	const constructorA = (a as object).constructor
	const constructorB = (b as object).constructor

	if ((constructorA !== Object && constructorA !== undefined) || (constructorB !== Object && constructorB !== undefined)) {
		// Non-plain object (Date, binary view, Map, foreign instance) — bail conservatively.
		return false
	}

	if (typeof (a as { toJSON?: unknown }).toJSON === "function" || typeof (b as { toJSON?: unknown }).toJSON === "function") {
		return false
	}

	const keysA = Object.keys(a as object)
	const keysB = Object.keys(b as object)

	if (keysA.length !== keysB.length) {
		return false
	}

	const objectA = a as Record<string, unknown>
	const objectB = b as Record<string, unknown>

	for (let i = 0; i < keysA.length; i++) {
		const key = keysA[i] as string

		if (!Object.prototype.hasOwnProperty.call(objectB, key)) {
			return false
		}

		if (!serializeEquals(objectA[key], objectB[key])) {
			return false
		}
	}

	return true
}

export function deserialize<T>(input: string | ArrayBuffer | Uint8Array): T {
	const json = typeof input === "string" ? input : (utf8Decoder ??= new TextDecoder()).decode(input)
	const parsed: unknown = JSON.parse(json)

	// Envelope keys are emitted literally by serialize() (the only writer of these
	// payloads), so a payload without the substring '"__' cannot contain an envelope
	// and skips the revival walk entirely. False positives (the characters "__ inside
	// a string value) just take the walk; correctness never depends on this scan.
	if (parsed === null || typeof parsed !== "object" || !json.includes("\"__")) {
		return parsed as T
	}

	return reviveContainer(parsed) as T
}

export function deserializeRouteParam<T>(serialized: string | undefined | null): T | null {
	if (!serialized) {
		return null
	}

	try {
		return deserialize(serialized) as T
	} catch (e) {
		logger.warn("serializer", "deserializeRouteParam failed — returning null", { inputLength: serialized.length, error: e })

		return null
	}
}

// ─── Capture-time SDK-error snapshot (freezeForLog) ──────────────────────────
// A live uniffi FilenSdkError can't be handled by encodeValue at serialize time: its detail
// (kind/message/serverMessage/serverCode) lives behind FFI METHODS that THROW once the native handle
// is freed — and the diagnostic logger serializes at a DEFERRED flush (debounced), after which the
// very transitions that surface these errors (e.g. AppState "background", which uniffiDestroys the
// socket listener) may already have freed the handle. So the logger calls this SYNCHRONOUSLY at the
// log call to snapshot the error into a plain `{ __sdkError }` object, which encodeValue then handles
// like any other plain object at flush. Duck-typed (no @filen/sdk-rs import) to keep this module's
// load dependency-free; mirrors @/lib/sdkErrors `unwrapSdkError` (FilenSdkError.hasInner/getInner).
// Copy-on-write: returns the SAME reference when there is no SDK error (the common case → zero alloc).

const FILEN_SDK_ERROR_TYPE_NAME = "FilenSdkError"
const FREEZE_MAX_DEPTH = 8

type SdkErrorLike = {
	message?: () => string
	serverMessage?: () => string | undefined
	serverCode?: () => string | undefined
}

// The FilenSdkError target, whether `value` is the raw error or the thrown UniffiThrownObject wrapper
// (whose `.inner` is the error). Returns null for anything else. Fully guarded — probing a hostile
// proxy / a stale handle must never throw out of a log call.
function asSdkError(value: object): SdkErrorLike | null {
	try {
		if ((value as Record<symbol, unknown>)[uniffiTypeNameSymbol] === FILEN_SDK_ERROR_TYPE_NAME) {
			return value as SdkErrorLike
		}

		const inner = (value as { inner?: unknown }).inner

		if (
			inner !== null &&
			typeof inner === "object" &&
			(inner as Record<symbol, unknown>)[uniffiTypeNameSymbol] === FILEN_SDK_ERROR_TYPE_NAME
		) {
			return inner as SdkErrorLike
		}
	} catch {
		return null
	}

	return null
}

function snapshotSdkError(sdk: SdkErrorLike, original: object): { __sdkError: Record<string, unknown> } {
	const fields: Record<string, unknown> = {}

	// message() carries the kind NAME + detail ("Error of kind Reqwest: ...") so the numeric kind is
	// redundant; serverMessage()/serverCode() add the server specifics for API errors. Each guarded —
	// a freed handle must not make a log call throw.
	try {
		const message = sdk.message?.()

		if (typeof message === "string") {
			fields["message"] = message
		}
	} catch {
		// A freed handle must not throw out of a log call.
	}

	try {
		const serverMessage = sdk.serverMessage?.()

		if (typeof serverMessage === "string") {
			fields["serverMessage"] = serverMessage
		}
	} catch {
		// Ignore.
	}

	try {
		const serverCode = sdk.serverCode?.()

		if (typeof serverCode === "string") {
			fields["serverCode"] = serverCode
		}
	} catch {
		// Ignore.
	}

	// The JS stack from the thrown wrapper locates where the FFI boundary threw.
	if (original instanceof Error && typeof original.stack === "string") {
		fields["stack"] = original.stack
	}

	return {
		__sdkError: fields
	}
}

function freezeNode(value: unknown, depth: number): unknown {
	if (value === null || typeof value !== "object") {
		return value
	}

	const sdk = asSdkError(value as object)

	if (sdk) {
		return snapshotSdkError(sdk, value as object)
	}

	// Below the depth cap, leave the subtree untouched.
	if (depth >= FREEZE_MAX_DEPTH) {
		return value
	}

	if (Array.isArray(value)) {
		let copy: unknown[] | null = null

		for (let i = 0; i < value.length; i++) {
			const child: unknown = value[i]
			const frozen = child !== null && typeof child === "object" ? freezeNode(child, depth + 1) : child

			if (copy !== null) {
				copy[i] = frozen
			} else if (frozen !== child) {
				copy = value.slice(0, i)
				copy.length = value.length
				copy[i] = frozen
			}
		}

		return copy ?? value
	}

	// Only recurse into plain objects. A non-plain class instance that ISN'T an SDK error (a Date, a
	// Map, another live handle) is left as-is — encodeValue handles it at flush, and walking a foreign
	// instance here risks touching live-handle getters for nothing.
	if ((value as object).constructor !== Object) {
		return value
	}

	const obj = value as Record<string, unknown>
	const keys = Object.keys(obj)
	let copy: Record<string, unknown> | null = null

	for (let i = 0; i < keys.length; i++) {
		const key = keys[i] as string
		const child = obj[key]
		const frozen = child !== null && typeof child === "object" ? freezeNode(child, depth + 1) : child

		if (copy !== null) {
			copy[key] = frozen
		} else if (frozen !== child) {
			copy = {}

			for (let j = 0; j < i; j++) {
				const priorKey = keys[j] as string

				copy[priorKey] = obj[priorKey]
			}

			copy[key] = frozen
		}
	}

	return copy ?? value
}

/**
 * Snapshot any live uniffi FilenSdkError inside `value` (raw or thrown-wrapper, at any depth) into a
 * plain `{ __sdkError: { message, serverMessage?, serverCode?, stack? } }` object, synchronously, so
 * the detail survives to the deferred log flush even after the native handle is freed. Copy-on-write:
 * returns `value` unchanged (same reference) when it holds no SDK error.
 */
export function freezeForLog(value: unknown): unknown {
	return freezeNode(value, 0)
}
