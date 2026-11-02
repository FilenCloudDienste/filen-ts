// Array and string helpers that take content-sized input without passing it as call arguments. A spread or apply call
// (`target.push(...items)`, `Math.max(...values)`, `String.fromCharCode(...units)`, `target.splice(at, n, ...items)`)
// passes every item as an argument of one call, and past about a hundred thousand (fewer on a deep stack) the call
// overflows the stack with a RangeError. Arrays sized by a file's content go through these.

// Arguments per String.fromCharCode / fromCodePoint call.
const CHUNK = 8192

// `items` appended to `target` one by one; `target` itself appended as it was (an array's length taken first).
export function appendAll<T>(target: T[], items: Iterable<T>): void {
	if (Array.isArray(items)) {
		const list = items as readonly T[]
		const count = list.length

		for (let k = 0; k < count; k++) target.push(list[k] as T)

		return
	}

	for (const item of items) target.push(item)
}

// ToIntegerOrInfinity, as splice takes its arguments.
function integer(value: number): number {
	return Number.isNaN(value) ? 0 : Math.trunc(value)
}

// `target.splice(start, deleteCount, ...items)`, the removed items returned: a native splice when the items fit one
// call's arguments, else one pass moving the tail and writing the items in place.
export function spliceAll<T>(target: T[], start: number, deleteCount: number, items: Iterable<T>): T[] {
	const list: readonly T[] = Array.isArray(items) ? (items === target ? [...target] : (items as readonly T[])) : [...items]

	if (list.length <= CHUNK) return target.splice(start, deleteCount, ...list)

	const length = target.length
	const from = integer(start)
	const at = from < 0 ? Math.max(length + from, 0) : Math.min(from, length)
	const removing = Math.min(Math.max(integer(deleteCount), 0), length - at)
	const removed = target.slice(at, at + removing)
	const count = list.length
	const shift = count - removing
	const tail = at + removing

	if (shift > 0) {
		target.length = length + shift

		for (let k = length - 1; k >= tail; k--) target[k + shift] = target[k] as T
	} else if (shift < 0) {
		for (let k = tail; k < length; k++) target[k + shift] = target[k] as T

		target.length = length + shift
	}

	for (let k = 0; k < count; k++) target[at + k] = list[k] as T

	return removed
}

// Math.max(...values): -Infinity for none, NaN when any is NaN, +0 over -0.
export function maxOf(values: Iterable<number>): number {
	let out = -Infinity

	for (const value of values) {
		if (Number.isNaN(value)) return Number.NaN
		if (value > out || (value === 0 && out === 0 && Object.is(out, -0))) out = value
	}

	return out
}

// Math.min(...values): Infinity for none, NaN when any is NaN, -0 under +0.
export function minOf(values: Iterable<number>): number {
	let out = Infinity

	for (const value of values) {
		if (Number.isNaN(value)) return Number.NaN
		if (value < out || (value === 0 && out === 0 && Object.is(value, -0))) out = value
	}

	return out
}

type Units = Uint8Array | Uint16Array | Uint32Array | readonly number[]

function chunkOf(units: Units, start: number, end: number): readonly number[] | Uint8Array | Uint16Array | Uint32Array {
	return Array.isArray(units) ? units.slice(start, end) : (units as Exclude<Units, readonly number[]>).subarray(start, end)
}

// String.fromCharCode(...units), a chunk of arguments per call.
export function fromCharCodes(units: Units): string {
	if (units.length <= CHUNK) return String.fromCharCode(...units)

	let out = ""

	for (let start = 0; start < units.length; start += CHUNK) out += String.fromCharCode(...chunkOf(units, start, start + CHUNK))

	return out
}

// String.fromCodePoint(...points), a chunk of arguments per call.
export function fromCodePoints(points: Units): string {
	if (points.length <= CHUNK) return String.fromCodePoint(...points)

	let out = ""

	for (let start = 0; start < points.length; start += CHUNK) out += String.fromCodePoint(...chunkOf(points, start, start + CHUNK))

	return out
}
