// The encoding detector's wasm module (crate/, a C ABI over chardetng) from JavaScript. Platform-free: give it the
// compiled module or its bytes. The module owns its buffers: input is copied into its scratch region (ed_buffer gives
// the address, asked again before every write since the region moves when it grows) and the answer is read from its
// output region. Every length is checked on the Rust side; a bad one is an error code, never a trap.

interface Exports {
	readonly memory: WebAssembly.Memory
	ed_buffer(minLen: number): number
	ed_output(): number
	ed_guess(len: number, last: number): number
}

const EXPORTS = ["memory", "ed_buffer", "ed_output", "ed_guess"] as const

// What the detector reads of a file: chardetng settles well within it, and the scratch region never grows past it.
export const GUESS_BYTES = 1 << 20

const decoder = new TextDecoder()

function exportsOf(instance: WebAssembly.Instance): Exports {
	const raw = instance.exports

	for (const name of EXPORTS) {
		if (!(name in raw)) throw new Error(`The encoding detection module lacks ${name}`)
	}

	return raw as unknown as Exports
}

export class EncodingDetector {
	private readonly wasm: Exports

	private constructor(wasm: Exports) {
		this.wasm = wasm
	}

	static async instantiate(module: WebAssembly.Module | BufferSource): Promise<EncodingDetector> {
		const compiled = module instanceof WebAssembly.Module ? module : await WebAssembly.compile(module)

		return new EncodingDetector(exportsOf(await WebAssembly.instantiate(compiled, {})))
	}

	// The legacy encoding (lower-case WHATWG name, never UTF-8) the first GUESS_BYTES of `bytes` most likely are.
	// `last`: `bytes` is the whole file (a prefix cut inside a character is not held against an encoding).
	guess(bytes: Uint8Array, last: boolean): string {
		const head = bytes.subarray(0, GUESS_BYTES)
		const address = this.wasm.ed_buffer(head.length)

		if (address === 0) {
			throw new Error("The encoding detection module is out of memory")
		}

		new Uint8Array(this.wasm.memory.buffer, address, head.length).set(head)

		const length = this.wasm.ed_guess(head.length, last && head.length === bytes.length ? 1 : 0)

		if (length < 0) {
			throw new Error(`The encoding detection module failed (${String(length)})`)
		}

		return decoder.decode(new Uint8Array(this.wasm.memory.buffer, this.wasm.ed_output(), length))
	}
}
