import { UniffiEnum } from "uniffi-bindgen-react-native"

const uniffiTypeNameSymbol = Symbol.for("typeName")

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

// ─── Reviver ────────────────────────────────────────────────────────────────

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
