import { Packr, addExtension } from "msgpackr"
import { UniffiEnum } from "uniffi-bindgen-react-native"

const uniffiTypeNameSymbol = Symbol.for("typeName")

// Preserve the [uniffiTypeNameSymbol] property on UniFFI tagged unions
// so that the global instanceOf() checks survive a pack/unpack round-trip.
addExtension({
	type: 0x75,
	Class: UniffiEnum,
	write(instance) {
		return [instance[uniffiTypeNameSymbol], instance.tag, instance.inner]
	},
	read(data) {
		return Object.defineProperty(
			{
				tag: data[1],
				inner: data[2]
			},
			uniffiTypeNameSymbol,
			{
				value: data[0]
			}
		)
	}
})

const packr = new Packr({
	useBigIntExtension: true,
	int64AsType: "bigint",
	moreTypes: true,
	encodeUndefinedAsNil: true,
	copyBuffers: true
})

export const pack = packr.pack.bind(packr)
export const unpack = packr.unpack.bind(packr)
