import { Packr, addExtension } from "msgpackr"
import { UniffiEnum } from "uniffi-bindgen-react-native"

const uniffiTypeNameSymbol = Symbol.for("typeName")

// Preserve the [uniffiTypeNameSymbol] property on UniFFI tagged unions
// so that the global instanceOf() checks survive a pack/unpack round-trip.
// Reconstructed objects inherit UniffiEnum.prototype so that double
// pack/unpack cycles also trigger the extension via instanceof.
// Unit variants (no associated data) omit the inner property entirely,
// matching the shape produced by uniffi-bindgen-react-native.
addExtension({
	type: 0x75,
	Class: UniffiEnum,
	write(instance) {
		const typeName = instance[uniffiTypeNameSymbol]
		const tag = instance.tag
		const inner = instance.inner

		return typeof inner !== "undefined" && inner != null ? [typeName, tag, inner] : [typeName, tag]
	},
	read(data) {
		const obj = Object.create(UniffiEnum.prototype)

		// Match the property descriptors of the original class field initializers
		// (enumerable + writable + configurable) so that Hermes AOT bytecode
		// handles them identically to SDK-constructed instances.
		Object.defineProperty(obj, uniffiTypeNameSymbol, {
			value: data[0],
			enumerable: true,
			writable: true,
			configurable: true
		})

		obj.tag = data[1]

		if (typeof data[2] !== "undefined" && data[2] != null) {
			// Freeze inner to match SDK constructors: this.inner = Object.freeze([v0])
			obj.inner = Array.isArray(data[2]) ? Object.freeze(data[2]) : data[2]
		}

		return obj
	}
})

const packr = new Packr({
	useBigIntExtension: true,
	int64AsType: "bigint",
	moreTypes: true,
	copyBuffers: true,
	bundleStrings: true,
	variableMapSize: true
})

export const pack = packr.pack.bind(packr)
export const unpack = packr.unpack.bind(packr)
