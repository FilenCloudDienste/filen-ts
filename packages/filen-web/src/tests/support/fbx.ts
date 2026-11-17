import { zlibSync } from "fflate"

// Binary FBX files built byte for byte (7.4: 32-bit record headers), for the 3D preflight and FBXLoader tests: records
// with properties and children, null records, and the footer FBXLoader's end-of-content rule needs.

export interface FbxRecord {
	readonly name: string
	readonly properties: readonly Uint8Array[]
	readonly children?: readonly (FbxRecord | null)[]
}

const NULL_RECORD = 13
const FOOTER = 200

function u32(value: number): Uint8Array {
	const bytes = new Uint8Array(4)

	new DataView(bytes.buffer).setUint32(0, value, true)

	return bytes
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
	let at = 0

	for (const part of parts) {
		bytes.set(part, at)
		at += part.length
	}

	return bytes
}

// A double array: zlib-compressed `data` declaring `count` elements, or stored (`data` as is) with a length field that
// may lie.
export function doubleArray(count: number, data: Uint8Array, options: { compressed?: boolean; lengthField?: number } = {}): Uint8Array {
	const compressed = options.compressed ?? true
	const body = compressed ? zlibSync(data) : data

	return concat([Uint8Array.of(0x64), u32(count), u32(compressed ? 1 : 0), u32(options.lengthField ?? body.length), body])
}

// A boolean array of type 'c', stored.
export function charArray(values: readonly number[]): Uint8Array {
	return concat([Uint8Array.of(0x63), u32(values.length), u32(0), u32(values.length), Uint8Array.from(values)])
}

export function int32(value: number): Uint8Array {
	return concat([Uint8Array.of(0x49), u32(value)])
}

function record(entry: FbxRecord | null, start: number): Uint8Array {
	if (entry === null) return new Uint8Array(NULL_RECORD)

	const name = new TextEncoder().encode(entry.name)
	const properties = concat(entry.properties)
	let at = start + NULL_RECORD + name.length + properties.length
	const children: Uint8Array[] = []

	for (const child of entry.children ?? []) {
		const bytes = record(child, at)

		children.push(bytes)
		at += bytes.length
	}

	return concat([
		u32(at),
		u32(entry.properties.length),
		u32(properties.length),
		Uint8Array.of(name.length),
		name,
		properties,
		...children
	])
}

export function fbxFile(records: readonly (FbxRecord | null)[]): Uint8Array {
	const header = concat([new TextEncoder().encode("Kaydara FBX Binary  \0\x1a\0"), u32(7400)])
	const body: Uint8Array[] = []
	let at = header.length

	for (const entry of records) {
		const bytes = record(entry, at)

		body.push(bytes)
		at += bytes.length
	}

	return concat([header, ...body, new Uint8Array(FOOTER)])
}
