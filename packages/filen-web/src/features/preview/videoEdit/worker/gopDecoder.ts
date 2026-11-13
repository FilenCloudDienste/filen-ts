import { pickFrame } from "@/features/preview/videoEdit/worker/preview.logic"

// Exact frames out of one reused VideoDecoder. A request decodes from the keyframe at or before the frame shown at
// that time (the sample with the latest start at or before it, by the container's real timestamps, so variable frame
// rates step correctly) forward in decode order until that frame comes out. The decoder is kept where it stopped, with
// the few frames it had already decoded past the answer: stepping forward within the GOP continues from there instead
// of starting over, and the next frame is often already out. A request that is no longer current stops between
// packets, leaving that position intact.

// The part of mediabunny's EncodedPacketSink this needs (timestamps in seconds, decode-order traversal).
export interface PacketLike {
	readonly timestamp: number
	readonly microsecondTimestamp: number
	readonly sequenceNumber: number
	toEncodedVideoChunk(): EncodedVideoChunk
}

export interface PacketSource<P extends PacketLike> {
	getFirstPacket(): Promise<P | null>
	getPacket(timestamp: number): Promise<P | null>
	getKeyPacket(timestamp: number): Promise<P | null>
	getNextPacket(packet: P): Promise<P | null>
}

export class SupersededError extends Error {
	public constructor() {
		super("frame request superseded")
		this.name = "AbortError"
	}
}

export class FrameDecodeError extends Error {
	public constructor(cause: unknown) {
		super("video frame did not decode", { cause })
		this.name = "FrameDecodeError"
	}
}

// Decoded frames held past the answer for the next step. A decoder's output frames come from a small pool; holding
// more would starve it.
const STASH = 3
// Packets queued in the decoder before the feeder waits for it.
const MAX_DECODE_QUEUE = 2

export type DecoderFactory = (init: VideoDecoderInit) => VideoDecoder

export class GopDecoder<P extends PacketLike> {
	private readonly config: VideoDecoderConfig
	private readonly packets: PacketSource<P>
	private readonly createDecoder: DecoderFactory
	private decoder: VideoDecoder | null = null
	// The keyframe the decoder started from (its sequence number); null when it must start over.
	private gop: number | null = null
	private lastFed: P | null = null
	// The latest timestamp the decoder has put out (µs).
	private lastOut = Number.NEGATIVE_INFINITY
	private readonly queue: VideoFrame[] = []
	private readonly candidate: { frame: VideoFrame | null } = { frame: null }
	// The stream ended (flushed): a new keyframe is needed before anything else decodes.
	private ended = false
	// A frame was dropped for want of room: continuing would miss it.
	private dropped = false
	private failure: unknown = null
	private wake: (() => void) | null = null

	public constructor(
		config: VideoDecoderConfig,
		packets: PacketSource<P>,
		createDecoder: DecoderFactory = init => new VideoDecoder(init)
	) {
		this.config = config
		this.packets = packets
		this.createDecoder = createDecoder
	}

	// The frame shown at `time`; the caller owns it. Rejects with SupersededError once `current` answers false.
	public async frameAt(time: number, current: () => boolean): Promise<VideoFrame> {
		const target = (await this.packets.getPacket(Math.max(0, time))) ?? (await this.packets.getFirstPacket())

		if (target === null) {
			throw new FrameDecodeError(new Error("no video packets"))
		}

		const targetUs = target.microsecondTimestamp

		// Already decoded on an earlier step.
		if (this.queue.some(frame => frame.timestamp === targetUs)) {
			const hit = pickFrame(this.queue, targetUs, this.candidate)

			if (hit !== null) {
				return hit
			}
		}

		const key = (await this.packets.getKeyPacket(target.timestamp)) ?? (await this.packets.getFirstPacket())

		if (key === null) {
			throw new FrameDecodeError(new Error("no key packet"))
		}

		if (!current()) {
			throw new SupersededError()
		}

		const continuing =
			this.decoder !== null &&
			this.decoder.state === "configured" &&
			this.failure === null &&
			!this.ended &&
			!this.dropped &&
			this.gop === key.sequenceNumber &&
			this.lastOut < targetUs

		if (!continuing) {
			this.restart(key.sequenceNumber)
		}

		return this.decodeUntil(targetUs, key, current)
	}

	// The keyframe at or before `time`, decoded on its own (a filmstrip still); null when the file has none. Leaves the
	// decoder needing a new start.
	public async keyFrameAt(time: number): Promise<VideoFrame | null> {
		const key = (await this.packets.getKeyPacket(Math.max(0, time))) ?? (await this.packets.getFirstPacket())

		if (key === null) {
			return null
		}

		const decoder = this.restart(null)

		decoder.decode(key.toEncodedVideoChunk())
		this.lastFed = key

		try {
			await decoder.flush()
		} catch (error) {
			this.failure ??= error
		}

		this.ended = true

		const frame = this.queue.shift() ?? null

		this.dropQueue()

		if (frame === null) {
			throw new FrameDecodeError(this.failure)
		}

		return frame
	}

	// Lets go of the decoder and every frame (another decoder needs the hardware); the next request starts over.
	public release(): void {
		this.dropQueue()

		if (this.decoder !== null && this.decoder.state !== "closed") {
			this.decoder.close()
		}

		this.decoder = null
		this.gop = null
		this.lastFed = null
		this.wake?.()
	}

	public close(): void {
		this.release()
	}

	private dropQueue(): void {
		for (const frame of this.queue.splice(0)) {
			frame.close()
		}

		this.candidate.frame?.close()
		this.candidate.frame = null
	}

	// A configured decoder with nothing in it, starting at keyframe `gop`.
	private restart(gop: number | null): VideoDecoder {
		this.dropQueue()
		this.failure = null
		this.ended = false
		this.dropped = false
		this.lastFed = null
		this.lastOut = Number.NEGATIVE_INFINITY
		this.gop = gop

		if (this.decoder === null || this.decoder.state === "closed") {
			this.decoder = this.createDecoder({
				output: frame => {
					this.lastOut = Math.max(this.lastOut, frame.timestamp)

					if (this.queue.length >= STASH + 1) {
						frame.close()
						this.dropped = true
					} else {
						this.queue.push(frame)
					}

					this.wake?.()
				},
				error: error => {
					this.failure = error
					this.wake?.()
				}
			})
			this.decoder.addEventListener("dequeue", () => {
				this.wake?.()
			})
		} else {
			this.decoder.reset()
		}

		try {
			this.decoder.configure(this.config)
		} catch (error) {
			this.failure = error
		}

		return this.decoder
	}

	// Resolves on the decoder's next output, dequeue or error.
	private progress(): Promise<void> {
		return new Promise(resolve => {
			this.wake = () => {
				this.wake = null
				resolve()
			}
		})
	}

	private async decodeUntil(targetUs: number, key: P, current: () => boolean): Promise<VideoFrame> {
		for (;;) {
			const found = pickFrame(this.queue, targetUs, this.candidate)

			if (found !== null) {
				return found
			}

			if (this.failure !== null) {
				const failure = this.failure

				this.gop = null

				throw new FrameDecodeError(failure)
			}

			const decoder = this.decoder

			if (decoder === null) {
				throw new SupersededError()
			}

			if (this.ended) {
				// The stream ran out before the target: the closest frame before it.
				const last = this.candidate.frame

				this.candidate.frame = null

				if (last === null) {
					throw new FrameDecodeError(new Error("frame not found"))
				}

				return last
			}

			if (!current()) {
				throw new SupersededError()
			}

			if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) {
				await this.progress()

				continue
			}

			const next = this.lastFed === null ? key : await this.packets.getNextPacket(this.lastFed)

			// The decoder may have been released or restarted by another caller while the packet was read.
			if (this.decoder !== decoder || this.gop !== key.sequenceNumber) {
				throw new SupersededError()
			}

			if (next === null) {
				try {
					await decoder.flush()
				} catch (error) {
					this.failure ??= error
				}

				this.ended = true

				continue
			}

			try {
				decoder.decode(next.toEncodedVideoChunk())
			} catch (error) {
				this.failure ??= error
			}

			this.lastFed = next
		}
	}
}
