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
		const inner = instance.inner

		return inner != null
			? [instance[uniffiTypeNameSymbol], instance.tag, inner]
			: [instance[uniffiTypeNameSymbol], instance.tag]
	},
	read(data) {
		const obj = Object.create(UniffiEnum.prototype)

		Object.defineProperty(obj, uniffiTypeNameSymbol, {
			value: data[0]
		})

		obj.tag = data[1]

		if (data[2] != null) {
			obj.inner = data[2]
		}

		return obj
	}
})

const packr = new Packr({
	useBigIntExtension: true,
	int64AsType: "bigint",
	moreTypes: true,
	copyBuffers: true
})

export const pack = packr.pack.bind(packr)
export const unpack = packr.unpack.bind(packr)
