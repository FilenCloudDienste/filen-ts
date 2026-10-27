// A layoutText answer read by the page inside the frame it is drawn in. After a key, Chromium runs the next frame
// before the worker's posted answer, which then paints one frame late; a cross-origin isolated page can share memory
// with its worker, so the worker also writes the answer into a SharedArrayBuffer the page reads in requestAnimationFrame
// (the frame's own start). The posted answer still arrives: whichever comes first is used.
//
// Layout of the buffer: Int32 header [answered request id, byte length, status], the value from byte HEADER_BYTES. The
// worker writes the value, then publishes the id last (Atomics.store); the page reads the value only once the id it
// waits for is published. One request is in flight per mailbox (the editor's), so a value is never overwritten while
// it is read.
//
// The value is encoded as tagged plain data: undefined, null, booleans, numbers, strings, arrays, plain objects and
// typed arrays (copied out on reading, never views of shared memory). Anything else, or a value larger than the
// buffer, publishes the id with OVERFLOW, and the page waits for the posted answer.

export interface TextMailboxTicket {
	readonly buffer: SharedArrayBuffer
	readonly id: number
}

const HEADER_BYTES = 16
const ID = 0
const LENGTH = 1
const STATUS = 2
const WRITTEN = 1
const OVERFLOW = 2

// A body's answer is tens of KiB; the largest a text box lays out stays far below this.
export const TEXT_MAILBOX_BYTES = 1 << 20

const Tag = { Undefined: 0, Null: 1, False: 2, True: 3, Number: 4, String: 5, Array: 6, Object: 7, Typed: 8 } as const

type Tag = (typeof Tag)[keyof typeof Tag]

const TYPED = [
	Int8Array,
	Uint8Array,
	Uint8ClampedArray,
	Int16Array,
	Uint16Array,
	Int32Array,
	Uint32Array,
	Float32Array,
	Float64Array
] as const

type Typed = InstanceType<(typeof TYPED)[number]>

function typedKind(value: object): number {
	for (let kind = 0; kind < TYPED.length; kind++) if (value instanceof (TYPED[kind] as (typeof TYPED)[number])) return kind

	return -1
}

class Overflow extends Error {}

// Code units per String.fromCharCode call (its arguments go on the stack).
const STRING_CHUNK = 4096

class Writer {
	private readonly view: DataView
	private readonly bytes: Uint8Array
	at = HEADER_BYTES

	constructor(buffer: SharedArrayBuffer) {
		this.view = new DataView(buffer)
		this.bytes = new Uint8Array(buffer)
	}

	private room(count: number): void {
		if (this.at + count > this.bytes.length) throw new Overflow()
	}

	tag(tag: Tag): void {
		this.room(1)
		this.view.setUint8(this.at++, tag)
	}

	count(value: number): void {
		this.room(4)
		this.view.setUint32(this.at, value, true)
		this.at += 4
	}

	number(value: number): void {
		this.room(8)
		this.view.setFloat64(this.at, value, true)
		this.at += 8
	}

	string(value: string): void {
		this.count(value.length)
		// Unit-aligned, so the reader decodes a view of the units.
		this.at = (this.at + 1) & ~1
		this.room(2 * value.length)

		const units = new Uint16Array(this.bytes.buffer, this.at, value.length)

		for (let index = 0; index < value.length; index++) units[index] = value.charCodeAt(index)

		this.at += 2 * value.length
	}

	typed(kind: number, value: Typed): void {
		this.room(1)
		this.view.setUint8(this.at++, kind)
		this.count(value.length)
		// Element-aligned, so the reader copies with one slice.
		this.at = (this.at + 7) & ~7
		this.room(value.byteLength)
		this.bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), this.at)
		this.at += value.byteLength
	}

	value(value: unknown, depth: number): void {
		if (depth > 32) throw new Overflow()

		switch (typeof value) {
			case "undefined":
				this.tag(Tag.Undefined)
				return
			case "boolean":
				this.tag(value ? Tag.True : Tag.False)
				return
			case "number":
				this.tag(Tag.Number)
				this.number(value)
				return
			case "string":
				this.tag(Tag.String)
				this.string(value)
				return
			case "object":
				break
			default:
				throw new Overflow()
		}

		if (value === null) {
			this.tag(Tag.Null)

			return
		}

		if (Array.isArray(value)) {
			this.tag(Tag.Array)
			this.count(value.length)

			for (const item of value) this.value(item, depth + 1)

			return
		}

		if (ArrayBuffer.isView(value)) {
			const kind = typedKind(value)

			if (kind < 0) throw new Overflow()

			this.tag(Tag.Typed)
			this.typed(kind, value as Typed)

			return
		}

		if (Object.getPrototypeOf(value) !== Object.prototype) throw new Overflow()

		const keys = Object.keys(value)

		this.tag(Tag.Object)
		this.count(keys.length)

		for (const key of keys) {
			this.string(key)
			this.value((value as Record<string, unknown>)[key], depth + 1)
		}
	}
}

class Reader {
	private readonly view: DataView
	private readonly buffer: SharedArrayBuffer
	private at = HEADER_BYTES

	constructor(buffer: SharedArrayBuffer) {
		this.buffer = buffer
		this.view = new DataView(buffer)
	}

	private count(): number {
		const value = this.view.getUint32(this.at, true)

		this.at += 4

		return value
	}

	private string(): string {
		const length = this.count()

		this.at = (this.at + 1) & ~1

		const units = new Uint16Array(length)

		units.set(new Uint16Array(this.buffer, this.at, length))
		this.at += 2 * length

		let out = ""

		for (let start = 0; start < length; start += STRING_CHUNK)
			out += String.fromCharCode(...units.subarray(start, Math.min(length, start + STRING_CHUNK)))

		return out
	}

	value(): unknown {
		const tag = this.view.getUint8(this.at++) as Tag

		switch (tag) {
			case Tag.Undefined:
				return undefined
			case Tag.Null:
				return null
			case Tag.False:
				return false
			case Tag.True:
				return true
			case Tag.Number: {
				const value = this.view.getFloat64(this.at, true)

				this.at += 8

				return value
			}
			case Tag.String:
				return this.string()
			case Tag.Array: {
				const length = this.count()
				const out: unknown[] = []

				for (let index = 0; index < length; index++) out.push(this.value())

				return out
			}
			case Tag.Object: {
				const length = this.count()
				const out: Record<string, unknown> = {}

				for (let index = 0; index < length; index++) {
					const key = this.string()

					out[key] = this.value()
				}

				return out
			}
			case Tag.Typed: {
				const Kind = TYPED[this.view.getUint8(this.at++)] as (typeof TYPED)[number]
				const length = this.count()

				this.at = (this.at + 7) & ~7

				// A copy: the page never keeps a view of shared memory.
				const copy = new Kind(length)

				new Uint8Array(copy.buffer).set(new Uint8Array(this.buffer, this.at, copy.byteLength))
				this.at += copy.byteLength

				return copy
			}
		}
	}
}

// Worker side: writes `value` as the answer to `ticket`'s request. False when it did not fit (the page then waits for
// the posted answer).
export function writeTextMailbox(ticket: TextMailboxTicket, value: unknown): boolean {
	const header = new Int32Array(ticket.buffer, 0, HEADER_BYTES / 4)
	const writer = new Writer(ticket.buffer)
	let status = WRITTEN

	try {
		writer.value(value, 0)
	} catch (error) {
		if (!(error instanceof Overflow) && !(error instanceof RangeError)) throw error

		status = OVERFLOW
	}

	Atomics.store(header, LENGTH, writer.at)
	Atomics.store(header, STATUS, status)
	Atomics.store(header, ID, ticket.id)

	return status === WRITTEN
}

// Page side: a mailbox for one editor, where the shared memory exists (a cross-origin isolated page).
export class TextMailbox {
	private readonly buffer: SharedArrayBuffer
	private readonly header: Int32Array
	private next = 0

	private constructor(buffer: SharedArrayBuffer) {
		this.buffer = buffer
		this.header = new Int32Array(buffer, 0, HEADER_BYTES / 4)
	}

	static create(scope: unknown = globalThis, bytes = TEXT_MAILBOX_BYTES): TextMailbox | undefined {
		const isolated = typeof scope === "object" && scope !== null && Reflect.get(scope, "crossOriginIsolated") === true

		if (!isolated || typeof SharedArrayBuffer !== "function") return undefined

		return new TextMailbox(new SharedArrayBuffer(bytes))
	}

	ticket(): TextMailboxTicket {
		this.next = (this.next + 1) | 0

		return { buffer: this.buffer, id: this.next }
	}

	// The answer to `id` once published: { value } when it was written, "posted" when only the posted answer has it,
	// undefined while it is not there yet.
	take(id: number): { readonly value: unknown } | "posted" | undefined {
		if (Atomics.load(this.header, ID) !== id) return undefined
		if (Atomics.load(this.header, STATUS) !== WRITTEN) return "posted"

		return { value: new Reader(this.buffer).value() }
	}
}
