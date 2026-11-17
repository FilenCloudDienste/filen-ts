import { AUDIO_FORMATS, type AudioFormat } from "./fileFamilies"
import { uint32le } from "./videos/probeAvi"

// Audio a synthesizer renders: a MIDI song, or a tracker module.
export type AudioSynthKind = NonNullable<AudioFormat["synth"]>

// The synthesizer the file `extension` (its type extension, lower case) needs, from its AUDIO_FORMATS row; undefined
// for a format that is decoded.
export function audioSynthKind(extension: string): AudioSynthKind | undefined {
	return AUDIO_FORMATS.get(extension)?.synth
}

// A MIDI file's events, counted without parsing it: every MTrk chunk walked by its delta times and running status. An
// RMI (RIFF RMID) is counted by the Standard MIDI File in its "data" chunk. Null for bytes that are neither, or whose
// tracks do not walk; the count stops past `limit`, where it no longer matters by how much.
export function midiEventCount(bytes: Uint8Array, limit = Number.POSITIVE_INFINITY): number | null {
	const smf = rmidData(bytes) ?? bytes

	if (ascii(smf, 0) !== "MThd") {
		return null
	}

	let count = 0
	let at = 8 + uint32be(smf, 4)

	while (at + 8 <= smf.length && count <= limit) {
		const length = uint32be(smf, at + 4)
		const end = Math.min(smf.length, at + 8 + length)

		if (ascii(smf, at) === "MTrk") {
			const walked = trackEvents(smf, at + 8, end, limit - count)

			if (walked === null) {
				return null
			}

			count += walked
		}

		at += 8 + length
	}

	return count
}

function trackEvents(bytes: Uint8Array, start: number, end: number, limit: number): number | null {
	let count = 0
	let status = 0

	for (let at = start; at < end && count <= limit; count++) {
		// The delta time: a variable-length quantity of at most four bytes.
		let length = 0

		while ((bytes[at] ?? 0) & 0x80 && length < 3) {
			at++
			length++
		}

		at++

		const first = bytes[at] ?? 0

		if (first & 0x80) {
			status = first
			at++
		} else if (status === 0) {
			return null
		}

		if (status === 0xff) {
			// A meta event: its type, then a length-prefixed body.
			at++
			at = skipVariable(bytes, at)
		} else if (status === 0xf0 || status === 0xf7) {
			at = skipVariable(bytes, at)
			status = 0
		} else {
			const type = status & 0xf0

			at += type === 0xc0 || type === 0xd0 ? 1 : 2
		}
	}

	return count
}

// Past a variable-length quantity at `at` and the bytes it counts.
function skipVariable(bytes: Uint8Array, at: number): number {
	let value = 0
	let position = at

	for (let i = 0; i < 4; i++) {
		const byte = bytes[position++] ?? 0

		value = value * 128 + (byte & 0x7f)

		if ((byte & 0x80) === 0) {
			break
		}
	}

	return position + value
}

function rmidData(bytes: Uint8Array): Uint8Array | null {
	if (ascii(bytes, 0) !== "RIFF" || ascii(bytes, 8) !== "RMID") {
		return null
	}

	for (let at = 12; at + 8 <= bytes.length;) {
		const length = uint32le(bytes, at + 4)

		if (ascii(bytes, at) === "data") {
			return bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + length))
		}

		at += 8 + length + (length & 1)
	}

	return null
}

function ascii(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)
}

function uint32be(bytes: Uint8Array, at: number): number {
	return (((bytes[at] ?? 0) << 24) >>> 0) + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0)
}
