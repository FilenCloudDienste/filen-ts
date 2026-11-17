// A loader parsing an untrusted model allocates typed arrays from the counts and sizes the file declares (USDC's
// buffers, an FBX's arrays, meshopt's buffers). While it parses, every typed array and ArrayBuffer the worker creates by
// length is checked against a budget before it is allocated: one over the per-allocation limit, or one taking the
// parse past its total, throws instead. Views over existing buffers allocate nothing and pass. The constructors are
// restored when the parse settles. Only for the 3D worker, which parses one model at a time.

export class AllocationRefusedError extends Error {
	constructor() {
		super("the model asks for more memory than the viewer allows")

		this.name = "AllocationRefused"
	}
}

export interface AllocationLimits {
	// Bytes one allocation may take.
	readonly each: number
	// Bytes every allocation of the parse may take together.
	readonly total: number
}

const CONSTRUCTORS = [
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
	"BigInt64Array",
	"BigUint64Array",
	"ArrayBuffer"
] as const

// The elements a constructor call allocates: a length, or a copied array's length; null for a view over a buffer.
export function allocatedElements(argument: unknown): number | null {
	if (typeof argument === "number") return argument
	if (argument instanceof ArrayBuffer || (typeof SharedArrayBuffer !== "undefined" && argument instanceof SharedArrayBuffer)) return null
	if (ArrayBuffer.isView(argument)) return "length" in argument && typeof argument.length === "number" ? argument.length : null
	if (typeof argument === "object" && argument !== null && "length" in argument && typeof argument.length === "number")
		return argument.length

	return null
}

export async function withAllocationBudget<T>(limits: AllocationLimits, run: () => Promise<T>): Promise<T> {
	const scope = globalThis as unknown as Record<string, unknown>
	const saved = new Map<string, unknown>()
	// Read through the object: a flag set in the trap is not narrowed away at the catch.
	const state = { spent: 0, refused: false }

	for (const name of CONSTRUCTORS) {
		const real = scope[name] as (abstract new (...args: never[]) => object) & { BYTES_PER_ELEMENT?: number }
		const size = real.BYTES_PER_ELEMENT ?? 1

		saved.set(name, real)
		scope[name] = new Proxy(real, {
			construct(target, args: unknown[], newTarget) {
				const elements = allocatedElements(args[0])

				if (elements !== null) {
					const bytes = elements * size

					state.spent += bytes

					if (bytes > limits.each || state.spent > limits.total) {
						state.refused = true

						throw new AllocationRefusedError()
					}
				}

				return Reflect.construct(target, args, newTarget) as object
			}
		})
	}

	try {
		return await run()
	} catch (error) {
		// A loader may wrap the refusal in an error of its own.
		throw state.refused ? new AllocationRefusedError() : error
	} finally {
		for (const [name, real] of saved) scope[name] = real
	}
}
