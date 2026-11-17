import { AUDIO_FORMATS, SYNTH_CAPS, type AudioFormat } from "./fileFamilies"
import { uint32le } from "./videos/probeAvi"

// Audio a synthesizer renders: a MIDI song, or a tracker module.
export type AudioSynthKind = NonNullable<AudioFormat["synth"]>

// The synthesizer the file `extension` (its type extension, lower case) needs, from its AUDIO_FORMATS row; undefined
// for a format that is decoded.
export function audioSynthKind(extension: string): AudioSynthKind | undefined {
	return AUDIO_FORMATS.get(extension)?.synth
}

// The largest file `kind`'s synthesizer reads, in bytes, whoever asks it to: past it the file is never read.
export function synthCap(kind: AudioSynthKind): number {
	return Number(SYNTH_CAPS[kind])
}

// Whether a file's first bytes start a MIDI song: a Standard MIDI File's header, or an RMI's RIFF RMID. Checked before
// a file is read whole for the MIDI synthesizer.
export function isMidiHead(head: Uint8Array): boolean {
	return ascii(head, 0) === "MThd" || (ascii(head, 0) === "RIFF" && ascii(head, 8) === "RMID")
}

// The most events a MIDI song may hold, and the most ports (16 channels each) it may address: its parse holds about
// 340 bytes per event, so a song at the cap leaves most of the MIDI worker's 60 MiB to the bank and the synthesizer.
export const MIDI_MAX_EVENTS = 100_000
export const MIDI_MAX_PORTS = 16

// Bytes per data of each channel message kind (status >> 4), as spessasynth_core reads them.
const CHANNEL_DATA_BYTES: Readonly<Record<number, number>> = { 8: 2, 9: 2, 10: 2, 11: 2, 12: 1, 13: 1, 14: 2 }

// A MIDI file's events, counted without parsing it, by exactly the rules spessasynth_core's parser follows: the
// header's track count of MTrk chunks, each walked by its delta times, running status (kept from channel messages
// only), SysEx and meta lengths. An RMI (RIFF RMID) is counted by the Standard MIDI File in its first, "data", chunk.
// Null for what that parser refuses, and for a chunk declaring more bytes than the file holds, or more than
// MIDI_MAX_PORTS ports; the count stops past `limit`, where it no longer matters by how much.
export function midiEventCount(bytes: Uint8Array, limit = Number.POSITIVE_INFINITY): number | null {
	const smf = ascii(bytes, 0) === "RIFF" ? rmidData(bytes) : bytes

	if (smf === null || ascii(smf, 0) !== "MThd" || smf.length < 14 || uint32be(smf, 4) !== 6) {
		return null
	}

	const tracks = ((smf[10] ?? 0) << 8) | (smf[11] ?? 0)
	const ports = new Set<number>()
	let count = 0
	let at = 14

	for (let track = 0; track < tracks && count <= limit; track++) {
		if (at + 8 > smf.length || ascii(smf, at) !== "MTrk") {
			return null
		}

		const length = uint32be(smf, at + 4)

		if (length > smf.length - at - 8) {
			return null
		}

		const walked = trackEvents(smf.subarray(at + 8, at + 8 + length), limit - count, ports)

		if (walked === null) {
			return null
		}

		count += walked
		at += 8 + length
	}

	return count
}

// A variable-length quantity as spessasynth_core reads it: to its last byte however long, in 32-bit arithmetic.
function readQuantity(track: Uint8Array, cursor: { at: number }): number {
	let value = 0

	while (cursor.at < track.length) {
		const byte = track[cursor.at++] ?? 0

		value = (value << 7) | (byte & 0x7f)

		if (byte >> 7 !== 1) {
			break
		}
	}

	return value
}

function trackEvents(track: Uint8Array, limit: number, ports: Set<number>): number | null {
	const cursor = { at: 0 }
	let running: number | null = null
	let count = 0

	while (cursor.at < track.length && count <= limit) {
		readQuantity(track, cursor)

		// A delta time that ends the track is an event of no status.
		if (cursor.at >= track.length) {
			count++
			break
		}

		const first = track[cursor.at] ?? 0
		let status: number

		if (first < 0x80) {
			if (running === null) {
				return null
			}

			status = running
		} else {
			status = first
			cursor.at++
		}

		let size: number

		if (status >= 0x80 && status < 0xf0) {
			size = CHANNEL_DATA_BYTES[status >> 4] ?? 0
			running = status
		} else if (status === 0xf0 || status === 0xf7) {
			size = readQuantity(track, cursor)
		} else if (status === 0xff) {
			const type = track[cursor.at++] ?? 0

			size = readQuantity(track, cursor)

			// A port meta event: 16 more channels for each port addressed.
			if (type === 0x21 && size >= 1) {
				ports.add(track[cursor.at] ?? 0)

				if (ports.size > MIDI_MAX_PORTS) {
					return null
				}
			}
		} else {
			size = 0
		}

		count++
		cursor.at += Math.max(0, Math.min(size, track.length - cursor.at))
	}

	return count
}

// The Standard MIDI File of an RMI: its first chunk after RMID must be "data", as spessasynth_core reads it.
function rmidData(bytes: Uint8Array): Uint8Array | null {
	if (ascii(bytes, 8) !== "RMID" || ascii(bytes, 12) !== "data") {
		return null
	}

	const length = uint32le(bytes, 16)

	return length > bytes.length - 20 ? null : bytes.subarray(20, 20 + length)
}

function ascii(bytes: Uint8Array, at: number): string {
	return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0)
}

function uint32be(bytes: Uint8Array, at: number): number {
	return (((bytes[at] ?? 0) << 24) >>> 0) + ((bytes[at + 1] ?? 0) << 16) + ((bytes[at + 2] ?? 0) << 8) + (bytes[at + 3] ?? 0)
}
