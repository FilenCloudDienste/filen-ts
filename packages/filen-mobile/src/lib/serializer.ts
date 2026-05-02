import { UniffiEnum } from "uniffi-bindgen-react-native"

const uniffiTypeNameSymbol = Symbol.for("typeName")

// %TypedArray%.prototype is shared by every typed array constructor (Int8Array,
// Uint8Array, ..., BigUint64Array). Patching it once covers them all.
const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object

// ─── toJSON hooks ───────────────────────────────────────────────────────────
// JSON.stringify in Hermes runs mostly in native C++. Only toJSON() callbacks
// execute in JS, keeping the per-item cost low.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(UniffiEnum.prototype as any).toJSON = function () {
	const inner = this.inner

	return typeof inner !== "undefined" && inner != null
		? {
				__ue: 1,
				tn: this[uniffiTypeNameSymbol],
				t: this.tag,
				i: inner
			}
		: {
				__ue: 1,
				tn: this[uniffiTypeNameSymbol],
				t: this.tag
			}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(BigInt.prototype as any).toJSON = function () {
	return {
		__bi: 1,
		v: this.toString()
	}
}

function encodeBinaryView(this: ArrayBufferView): {
	__bin: 1
	k: string
	d: string
} {
	const bytes =
		this instanceof Uint8Array ? this : new Uint8Array(this.buffer, this.byteOffset, this.byteLength)

	return {
		__bin: 1,
		k: this.constructor.name,
		d: Buffer.from(bytes).toString("base64")
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(TypedArrayPrototype as any).toJSON = encodeBinaryView

// Buffer extends Uint8Array but defines its own toJSON ({type:"Buffer",data:[...]}).
// Override with our compact base64 envelope for consistency.
if (typeof Buffer !== "undefined") {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	;(Buffer.prototype as any).toJSON = encodeBinaryView
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(DataView.prototype as any).toJSON = encodeBinaryView

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(ArrayBuffer.prototype as any).toJSON = function () {
	return {
		__bin: 1,
		k: "ArrayBuffer",
		d: Buffer.from(new Uint8Array(this)).toString("base64")
	}
}

// ─── Reviver ────────────────────────────────────────────────────────────────

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

function reviver(_key: string, value: unknown): unknown {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>

		if (obj["__ue"] === 1) {
			const ue = Object.create(UniffiEnum.prototype)

			Object.defineProperty(ue, uniffiTypeNameSymbol, {
				value: obj["tn"],
				enumerable: true,
				writable: true,
				configurable: true
			})

			ue.tag = obj["t"]

			if (obj["i"] != null) {
				ue.inner = Array.isArray(obj["i"]) ? Object.freeze(obj["i"]) : obj["i"]
			}

			return ue
		}

		if (obj["__bi"] === 1) {
			return BigInt(obj["v"] as string)
		}

		if (obj["__bin"] === 1) {
			return reviveBinary(obj as { k: string; d: string })
		}
	}

	return value
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function serialize(value: unknown): string {
	return JSON.stringify(value)
}

export function deserialize<T>(input: string | ArrayBuffer | Uint8Array): T {
	const json = typeof input === "string" ? input : new TextDecoder().decode(input)

	return JSON.parse(json, reviver) as T
}
