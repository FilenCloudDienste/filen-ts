import { UniffiEnum } from "uniffi-bindgen-react-native"

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

function encodeValue(value: unknown): unknown {
	if (typeof value === "bigint") {
		return {
			__bi: 1,
			v: value.toString()
		}
	}

	if (value === null || typeof value !== "object") {
		return value
	}

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

	if (Array.isArray(value)) {
		let copy: unknown[] | null = null

		for (let i = 0; i < value.length; i++) {
			const child: unknown = value[i]
			const encoded = encodeValue(child)

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

	if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
		// Objects with their own toJSON (Date, third-party types) keep stock
		// JSON.stringify semantics — the native serializer invokes it.
		return value
	}

	const obj = value as Record<string, unknown>
	const keys = Object.keys(obj)
	let copy: Record<string, unknown> | null = null

	for (let i = 0; i < keys.length; i++) {
		const key = keys[i] as string
		const child = obj[key]
		const encoded = encodeValue(child)

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

function reviveUniffiEnum(envelope: Record<string, unknown>): unknown {
	const ue = Object.create(UniffiEnum.prototype)

	Object.defineProperty(ue, uniffiTypeNameSymbol, {
		value: envelope["tn"],
		enumerable: true,
		writable: true,
		configurable: true
	})

	ue.tag = envelope["t"]

	if (envelope["i"] != null) {
		ue.inner = Array.isArray(envelope["i"]) ? Object.freeze(envelope["i"]) : envelope["i"]
	}

	return ue
}

// Depth-first in-place revival of a freshly-parsed JSON tree (children before
// parents, matching reviver order, so envelope inners are already revived when
// the envelope itself is transformed). Mutating is safe: the tree is private
// JSON.parse output that nothing else references yet.
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

	for (const key in obj) {
		const child = obj[key]

		if (child !== null && typeof child === "object") {
			const revived = reviveContainer(child)

			if (revived !== child) {
				obj[key] = revived
			}
		}
	}

	if (obj["__ue"] === 1) {
		return reviveUniffiEnum(obj)
	}

	if (obj["__bi"] === 1) {
		// BigInt() throws SyntaxError on a non-integer string (truncated/corrupt DB
		// value, NaN, empty string). Degrade to null instead of aborting the whole
		// deserialize so a single bad envelope can't crash deserialization.
		try {
			return BigInt(obj["v"] as string)
		} catch {
			return null
		}
	}

	if (obj["__bin"] === 1) {
		return reviveBinary(obj as { k: string; d: string })
	}

	return obj
}

// ─── Public API ─────────────────────────────────────────────────────────────

const utf8Decoder = new TextDecoder()

export function serialize(value: unknown): string {
	return JSON.stringify(encodeValue(value))
}

export function deserialize<T>(input: string | ArrayBuffer | Uint8Array): T {
	const json = typeof input === "string" ? input : utf8Decoder.decode(input)
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
	} catch {
		return null
	}
}
