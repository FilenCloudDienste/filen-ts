import {
	EncodedAudioPacketSource,
	EncodedVideoPacketSource,
	Mp4OutputFormat,
	Output,
	StreamTarget,
	type AudioCodec,
	type EncodedPacket,
	type Rotation,
	type StreamTargetChunk,
	type VideoCodec
} from "mediabunny"
import type { PumpGate } from "@/workers/remux/pump"

// Fragments of at least this long. A video fragment still ends only at a key packet, so for typical
// files each one is a GOP; audio is cut on this alone.
const MIN_FRAGMENT_SECONDS = 1

// The muxer holds a fragment's packets until the key packet that ends it arrives; a file whose key
// packets are further apart than a SourceBuffer can hold is refused before all of it is in memory.
export class FragmentTooLargeError extends Error {
	public constructor(bytes: number) {
		super(`more than ${String(bytes)} bytes between key packets`)
		this.name = "FragmentTooLargeError"
	}
}

// One track muxed to fragmented MP4. The first segment carries the init segment (ftyp + moov) ahead of
// its first fragment. Every packet keeps its source timestamp as its presentation time. Decode times lag
// them by the stream's reorder delay (the patched muxer), so no picture is presented before it is decoded;
// where that puts the first decode time before 0 (a start at the file's first key picture), the muxer
// starts decoding at 0 and writes an edit list that trims the lag back off.
export class FragmentedTrackOutput {
	private readonly output: Output
	// Adds a packet; the decoder config goes with the first one only.
	private readonly add: (packet: EncodedPacket, meta: EncodedAudioChunkMetadata | undefined) => Promise<void>
	private readonly gate: PumpGate
	private started = false
	// Fragments cut so far.
	private fragments = 0
	// Packet bytes added since the last cut, and the cap on them.
	private pendingBytes = 0
	private readonly maxFragmentBytes: number

	public constructor(params: {
		track:
			| { kind: "video"; codec: VideoCodec; decoderConfig: VideoDecoderConfig; rotation: Rotation }
			| { kind: "audio"; codec: AudioCodec; decoderConfig: AudioDecoderConfig | null }
		gate: PumpGate
		maxFragmentBytes: number
		onSegment: (bytes: Uint8Array<ArrayBuffer>) => void
	}) {
		const { track, gate, onSegment } = params

		this.gate = gate
		this.maxFragmentBytes = params.maxFragmentBytes
		this.output = new Output({
			format: new Mp4OutputFormat({
				fastStart: "fragmented",
				minimumFragmentDuration: MIN_FRAGMENT_SECONDS,
				onMoof: () => {
					this.fragments++
				}
			}),
			target: new StreamTarget(
				new WritableStream<StreamTargetChunk>({
					write: chunk => {
						// Deferred: an idle stream runs this inside the target's own write call, which still reads
						// the chunk's length afterwards, and handing the bytes on transfers (detaches) them.
						queueMicrotask(() => {
							onSegment(chunk.data)
						})
					}
				})
			)
		})

		if (track.kind === "video") {
			const source = new EncodedVideoPacketSource(track.codec)
			let first: EncodedVideoChunkMetadata | undefined = { decoderConfig: track.decoderConfig }

			this.output.addVideoTrack(source, { rotation: track.rotation })
			this.add = packet => {
				const meta = first

				first = undefined

				return source.add(packet, meta)
			}
		} else {
			const source = new EncodedAudioPacketSource(track.codec)
			let first: EncodedAudioChunkMetadata | undefined =
				track.decoderConfig === null ? undefined : { decoderConfig: track.decoderConfig }

			this.output.addAudioTrack(source)
			this.add = (packet, override) => {
				const meta = override ?? first

				first = undefined

				return source.add(packet, meta)
			}
		}
	}

	// `meta` overrides the decoder config given at construction (an encoder reports its own with its
	// first chunk).
	public async write(packet: EncodedPacket, meta?: EncodedAudioChunkMetadata): Promise<void> {
		if (!this.started) {
			this.started = true
			await this.output.start()
		}

		const fragments = this.fragments

		await this.add(packet, meta)

		// A fragment is cut when the packet that starts the next one arrives: everything presented
		// before it is out.
		if (this.fragments !== fragments) {
			this.gate.noteFlushed(packet.timestamp)
			this.pendingBytes = 0
		}

		this.pendingBytes += packet.byteLength

		if (this.pendingBytes > this.maxFragmentBytes) {
			throw new FragmentTooLargeError(this.maxFragmentBytes)
		}
	}

	public async end(): Promise<void> {
		if (this.started) {
			await this.output.finalize()
		}

		this.gate.noteFlushed(Number.POSITIVE_INFINITY)
	}

	public async cancel(): Promise<void> {
		if (this.output.state !== "finalized" && this.output.state !== "canceled") {
			await this.output.cancel()
		}
	}
}
