// Byte helpers every platform shares.

// The fixed-width readers live with the container walkers, which cannot import from a parent directory.
export { fourCC, uint16be, uint16le, uint24be, uint32be, uint32le } from "./videos/probeBytes"

export interface PlatformTextDecoder {
	readonly encoding: string
	decode(input?: Uint8Array, options?: { stream?: boolean }): string
}

type TextDecoderConstructor = new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) => PlatformTextDecoder

// The platform's TextDecoder (browsers, Node, Hermes once Expo installed it), which this package's ESNext-only types do
// not declare. Throws for a label the platform does not know. Call it when needed, never at module top: on Hermes the
// global appears lazily.
export function platformTextDecoder(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }): PlatformTextDecoder {
	return new (globalThis as unknown as { TextDecoder: TextDecoderConstructor }).TextDecoder(label, options)
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"))

// Lower-case hex, two digits a byte.
export function bytesToHex(bytes: Uint8Array | ArrayBuffer): string {
	let out = ""

	for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) {
		out += HEX[byte] ?? ""
	}

	return out
}
