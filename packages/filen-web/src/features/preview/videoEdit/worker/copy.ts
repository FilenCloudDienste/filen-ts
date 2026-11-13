import type { EncodedAudioPacketSource, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource } from "mediabunny"
import type { TimeRange } from "@/features/preview/videoEdit/types"
import { ExportRefusedError, throwIfCancelled } from "@/features/preview/videoEdit/worker/errors"
import type { InterleaveGate } from "@/features/preview/videoEdit/worker/gate"

// The copy path: coded packets moved from the source into the output untouched, for one or many kept ranges
// concatenated on one timeline.
//
// Video: each range starts at a key packet (plan.ts copyRanges moved its start there) and is read in decode order up to
// the first packet presented at or after its end. Packets read before that point but presented before the range's
// start (an open GOP's leading pictures, which reference the GOP before) are dropped, so a range only ever shrinks and
// nothing the user removed is shown. The range's real end is where the last frame kept stops showing (B-frames
// reordered past the cut make it a frame or two earlier than asked), which copyBounds finds from packet timestamps
// alone, before any data is read, so the audio is cut at exactly that boundary.
//
// Audio is laid down gap-free: per range, the packets whose running total comes closest to the video's running total,
// so after any number of joins the audio is never more than half a packet off the video (no drift).

// Presentation-time slack between key frame tables and packet timestamps.
const EPSILON = 0.001

// A range as the copy path actually cuts it, in source seconds.
export interface CopyBound {
	start: number
	end: number
}

const METADATA_ONLY = { metadataOnly: true } as const

// The key packet a range starts at: the first at or after `start` (the table the plan snapped with may round).
async function startKey(sink: EncodedPacketSink, start: number, metadataOnly: boolean): Promise<EncodedPacket | null> {
	const options = metadataOnly ? METADATA_ONLY : {}
	let key = (await sink.getKeyPacket(start + EPSILON, options)) ?? (await sink.getFirstKeyPacket(options))

	while (key !== null && key.timestamp < start - EPSILON) {
		key = await sink.getNextKeyPacket(key, options)
	}

	return key
}

// Where each range's video really ends (and starts), from packet metadata only. Ranges left with no frame are gone.
export async function copyBounds(sink: EncodedPacketSink, ranges: readonly TimeRange[]): Promise<CopyBound[]> {
	const bounds: CopyBound[] = []

	for (const range of ranges) {
		const key = await startKey(sink, range.start, true)

		if (key === null || key.timestamp >= range.end - EPSILON) {
			continue
		}

		const last = await sink.getKeyPacket(range.end - EPSILON, METADATA_ONLY)
		let packet: EncodedPacket | null = last === null || last.timestamp < key.timestamp ? key : last
		let end = key.timestamp

		while (packet !== null && packet.timestamp < range.end - EPSILON) {
			if (packet.timestamp >= key.timestamp - EPSILON) {
				end = Math.max(end, packet.timestamp + packet.duration)
			}

			packet = await sink.getNextPacket(packet, METADATA_ONLY)
		}

		if (end > key.timestamp + EPSILON) {
			bounds.push({ start: key.timestamp, end })
		}
	}

	return bounds
}

// Output start of each bound on the output timeline.
export function boundOffsets(bounds: readonly CopyBound[], speed: number): number[] {
	const offsets: number[] = []
	let at = 0

	for (const bound of bounds) {
		offsets.push(at)
		at += (bound.end - bound.start) / speed
	}

	return offsets
}

// mediabunny's own muxer rule: no packet may be presented before the latest frame of the previous GOP. A source that
// breaks it (rare encoders) has its offending packets dropped rather than failing the export.
export class GopRule {
	private max: number | null = null
	private maxBeforeLastKey: number | null = null

	public accepts(timestamp: number, key: boolean): boolean {
		if (this.max === null) {
			return key
		}

		const floor = key ? this.max : this.maxBeforeLastKey

		return floor === null || timestamp >= floor
	}

	public record(timestamp: number, key: boolean): void {
		if (key) {
			this.maxBeforeLastKey = this.max
		}

		this.max = Math.max(this.max ?? Number.NEGATIVE_INFINITY, timestamp)
	}
}

export interface CopyVideoParams {
	sink: EncodedPacketSink
	bounds: readonly CopyBound[]
	speed: number
	output: EncodedVideoPacketSource
	decoderConfig: VideoDecoderConfig
	gate: InterleaveGate
	lane: string
	signal: AbortSignal
	// The most bytes one GOP may hold (a fragment holds at least a GOP in memory); null for no cap.
	gopByteCap: number | null
	onPacket?: (bytes: number) => void
}

export async function copyVideo(params: CopyVideoParams): Promise<void> {
	const { sink, bounds, speed, output, gate, lane, signal, gopByteCap } = params
	const offsets = boundOffsets(bounds, speed)
	const rule = new GopRule()
	let first = true

	for (let index = 0; index < bounds.length; index++) {
		const bound = bounds[index]
		const offset = offsets[index]

		if (bound === undefined || offset === undefined) {
			continue
		}

		let packet = await startKey(sink, bound.start, false)
		let gopBytes = 0

		while (packet !== null && packet.timestamp < bound.end - EPSILON) {
			throwIfCancelled(signal)

			const key = packet.type === "key"

			if (packet.timestamp >= bound.start - EPSILON) {
				const timestamp = offset + Math.max(0, packet.timestamp - bound.start) / speed

				gopBytes = key ? packet.byteLength : gopBytes + packet.byteLength

				if (gopByteCap !== null && gopBytes > gopByteCap) {
					throw new ExportRefusedError("gop", `a source GOP exceeds ${String(gopByteCap)} bytes`)
				}

				if (rule.accepts(timestamp, key)) {
					rule.record(timestamp, key)
					await gate.advance(lane, timestamp)
					throwIfCancelled(signal)
					await output.add(
						packet.clone({ timestamp, duration: packet.duration / speed }),
						first ? { decoderConfig: params.decoderConfig } : undefined
					)
					params.onPacket?.(packet.byteLength)
					first = false
				}
			}

			packet = await sink.getNextPacket(packet)
		}
	}

	gate.finish(lane)
}

export interface CopyAudioParams {
	sink: EncodedPacketSink
	bounds: readonly CopyBound[]
	output: EncodedAudioPacketSource
	decoderConfig: AudioDecoderConfig
	gate: InterleaveGate
	lane: string
	signal: AbortSignal
}

function packetDuration(packet: EncodedPacket, previous: number): number {
	return packet.duration > 0 ? packet.duration : previous
}

// The packet whose timestamp is closest to `time`.
async function packetNear(sink: EncodedPacketSink, time: number): Promise<EncodedPacket | null> {
	const before = (await sink.getPacket(time)) ?? (await sink.getFirstPacket())

	if (before === null) {
		return null
	}

	const after = await sink.getNextPacket(before)

	return after !== null && Math.abs(after.timestamp - time) < Math.abs(before.timestamp - time) ? after : before
}

// Lays the audio of `bounds` down gap-free. Returns how far the audio's running total ends from the video's (seconds;
// within half a packet).
export async function copyAudio(params: CopyAudioParams): Promise<number> {
	const { sink, bounds, output, gate, lane, signal } = params
	// Output seconds written (the audio's running total) and the video's running total.
	let written = 0
	let target = 0
	let duration = 0
	let first = true

	for (const bound of bounds) {
		const rangeStart = target

		target += bound.end - bound.start

		// Audio that ran out short of the last range (a source whose audio ends before its video) restarts in step.
		if (written < rangeStart - Math.max(duration, EPSILON)) {
			written = rangeStart
		}

		// The start that carries the audio's lead or lag on: the joins never add up to drift.
		let packet = await packetNear(sink, bound.start + (written - rangeStart))

		while (packet !== null) {
			throwIfCancelled(signal)

			duration = packetDuration(packet, duration)

			if (duration <= 0 || written + duration / 2 > target + 1e-9) {
				break
			}

			await gate.advance(lane, written)
			throwIfCancelled(signal)
			await output.add(packet.clone({ timestamp: written, duration }), first ? { decoderConfig: params.decoderConfig } : undefined)
			first = false
			written += duration
			packet = await sink.getNextPacket(packet)
		}
	}

	gate.finish(lane)

	return written - target
}
