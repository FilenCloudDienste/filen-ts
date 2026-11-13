import {
	ALL_FORMATS,
	BufferSource,
	BufferTarget,
	EncodedAudioPacketSource,
	EncodedPacket,
	EncodedPacketSink,
	EncodedVideoPacketSource,
	Input,
	MovOutputFormat,
	Mp4OutputFormat,
	Output,
	type MetadataTags,
	type Rotation
} from "mediabunny"
import { AVC_PRIVATE } from "@/tests/support/fragmentedMp4"
import type { VideoSourceInfo } from "@/features/preview/videoEdit/types"

// Source files for the video export's copy-path tests, muxed by mediabunny from synthetic packets: every video packet
// names its presentation frame number, every audio packet its index, so an output can be checked frame by frame.

export const FPS = 24
export const AUDIO_PACKET_SECONDS = 1024 / 48_000
const AAC_CONFIG = Uint8Array.from([0x11, 0x90])

export interface FixtureOptions {
	seconds: number
	// Frames per GOP (a key frame every gop frames).
	gop: number
	// I P B B reordering (B-frames presented before the P decoded ahead of them).
	bframes: boolean
	// Each GOP after the first opens with two leading pictures (presented before its key frame, decoded after it).
	openGop?: boolean
	audio: boolean
	container?: "mp4" | "mov"
	rotation?: Rotation
	tags?: MetadataTags
	// Bytes of padding per video packet.
	padding?: number
}

export function frameOf(packet: EncodedPacket): number {
	return new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength).getUint32(5)
}

export function audioIndexOf(packet: EncodedPacket): number {
	return new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength).getUint32(0)
}

function videoBytes(frame: number, key: boolean, padding: number): Uint8Array {
	const size = 64 + padding
	const bytes = new Uint8Array(4 + size)

	new DataView(bytes.buffer).setUint32(0, size)
	bytes[4] = key ? 0x65 : 0x41
	new DataView(bytes.buffer).setUint32(5, frame)

	return bytes
}

// Presentation frame numbers in decode order, with key flags.
export function decodeOrder(frames: number, gop: number, bframes: boolean, openGop: boolean): { frame: number; key: boolean }[] {
	const order: { frame: number; key: boolean }[] = []

	for (let start = 0; start < frames; start += gop) {
		const end = Math.min(frames, start + gop)
		// An open GOP's last two frames are decoded after the next key frame instead.
		const last = openGop && end < frames ? end - 2 : end

		order.push({ frame: start, key: true })

		if (openGop && start > 0) {
			order.push({ frame: start - 2, key: false }, { frame: start - 1, key: false })
		}

		let at = start + 1

		while (bframes && at + 2 < last) {
			order.push({ frame: at + 2, key: false }, { frame: at, key: false }, { frame: at + 1, key: false })
			at += 3
		}

		for (; at < last; at++) {
			order.push({ frame: at, key: false })
		}
	}

	return order
}

export async function sourceFixture(options: FixtureOptions): Promise<Uint8Array> {
	const output = new Output({
		format: options.container === "mov" ? new MovOutputFormat() : new Mp4OutputFormat(),
		target: new BufferTarget()
	})
	const video = new EncodedVideoPacketSource("avc")
	const audio = options.audio ? new EncodedAudioPacketSource("aac") : null

	output.addVideoTrack(video, { rotation: options.rotation ?? 0 })

	if (audio !== null) {
		output.addAudioTrack(audio)
	}

	if (options.tags !== undefined) {
		output.setMetadataTags(options.tags)
	}

	await output.start()

	const frames = options.seconds * FPS
	const order = decodeOrder(frames, options.gop, options.bframes, options.openGop === true)
	let audioIndex = 0
	let first = true

	for (const { frame, key } of order) {
		await video.add(
			new EncodedPacket(videoBytes(frame, key, options.padding ?? 0), key ? "key" : "delta", frame / FPS, 1 / FPS),
			first ? { decoderConfig: { codec: "avc1.64001f", codedWidth: 1280, codedHeight: 720, description: AVC_PRIVATE } } : undefined
		)
		first = false

		// Audio up to the latest presentation time decoded so far keeps the two interleaved.
		while (
			audio !== null &&
			audioIndex * AUDIO_PACKET_SECONDS < (frame + 1) / FPS &&
			audioIndex * AUDIO_PACKET_SECONDS < options.seconds
		) {
			const bytes = new Uint8Array(32)

			new DataView(bytes.buffer).setUint32(0, audioIndex)
			await audio.add(
				new EncodedPacket(bytes, "key", audioIndex * AUDIO_PACKET_SECONDS, AUDIO_PACKET_SECONDS),
				audioIndex === 0
					? { decoderConfig: { codec: "mp4a.40.2", numberOfChannels: 2, sampleRate: 48_000, description: AAC_CONFIG } }
					: undefined
			)
			audioIndex++
		}
	}

	await output.finalize()

	const buffer = output.target.buffer

	if (buffer === null) {
		throw new Error("no output")
	}

	return new Uint8Array(buffer)
}

export function openInput(bytes: Uint8Array): Input {
	return new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS })
}

// Key frame times as the probe would list them.
export async function keyframesOf(input: Input): Promise<Float64Array> {
	const track = await input.getPrimaryVideoTrack()

	if (track === null) {
		return new Float64Array()
	}

	const sink = new EncodedPacketSink(track)
	const times: number[] = []
	let key = await sink.getFirstKeyPacket({ metadataOnly: true })

	while (key !== null) {
		times.push(key.timestamp)
		key = await sink.getNextKeyPacket(key, { metadataOnly: true })
	}

	return Float64Array.from(times)
}

export async function sourceInfoOf(bytes: Uint8Array, overrides: Partial<VideoSourceInfo> = {}): Promise<VideoSourceInfo> {
	const input = openInput(bytes)
	const track = await input.getPrimaryVideoTrack()
	const audio = await input.getAudioTracks()

	return {
		duration: await input.computeDuration(),
		width: 1280,
		height: 720,
		codedWidth: 1280,
		codedHeight: 720,
		rotation: (await track?.getRotation()) ?? 0,
		frameRate: FPS,
		videoCodec: "avc1.64001f",
		transfer: "sdr",
		bitDepth: 8,
		keyframes: await keyframesOf(input),
		audio: audio.map(track => ({ number: track.number, codec: "aac", channels: 2, language: null })),
		container: "mp4",
		hasSubtitles: false,
		hasChapters: false,
		hasLocation: false,
		bytes: bytes.byteLength,
		previewable: true,
		...overrides
	}
}

// Every packet of the output's tracks, in decode order.
export async function outputPackets(bytes: Uint8Array): Promise<{ video: EncodedPacket[]; audio: EncodedPacket[]; input: Input }> {
	const input = openInput(bytes)
	const video: EncodedPacket[] = []
	const audio: EncodedPacket[] = []
	const videoTrack = await input.getPrimaryVideoTrack()
	const audioTrack = await input.getPrimaryAudioTrack()

	if (videoTrack !== null) {
		for await (const packet of new EncodedPacketSink(videoTrack).packets()) {
			video.push(packet)
		}
	}

	if (audioTrack !== null) {
		for await (const packet of new EncodedPacketSink(audioTrack).packets()) {
			audio.push(packet)
		}
	}

	return { video, audio, input }
}
