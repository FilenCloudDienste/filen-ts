import { StreamTarget, type StreamTargetChunk } from "mediabunny"
import type { SavePortSink } from "@filen/shared/savePort"

// The muxer's output as an append-only byte stream: a fragmented MP4 (moov first, then moof/mdat pairs, mfra last)
// written through a StreamTarget whose chunks are passed on in order. The upload reads a stream, so a write that goes
// back (a muxer patching a box it already wrote) can never reach it: it fails the export instead of corrupting the file.

// The bytes the muxer may run ahead of the upload: the muxer's own writes wait (and so do the encoders) beyond it.
export const OUTPUT_QUEUE_BYTES = 4 * 1024 * 1024

// The muxer's write granularity: whole save-port chunks.
export const OUTPUT_CHUNK_BYTES = 1024 * 1024

export class NonMonotonicWriteError extends Error {
	public constructor(expected: number, got: number) {
		super(`the muxer wrote at ${String(got)} after ${String(expected)}: the output must be append-only`)
		this.name = "NonMonotonicWriteError"
	}
}

export interface AppendOnlyTarget {
	readonly target: StreamTarget
	// Bytes accepted so far.
	readonly written: () => number
}

export function appendOnlyTarget(sink: SavePortSink): AppendOnlyTarget {
	let expected = 0
	const stream = new WritableStream<StreamTargetChunk>(
		{
			write: async chunk => {
				if (chunk.position !== expected) {
					throw new NonMonotonicWriteError(expected, chunk.position)
				}

				expected += chunk.data.byteLength
				await sink.write(chunk.data)
			},
			close: () => sink.close()
		},
		{ highWaterMark: OUTPUT_QUEUE_BYTES, size: chunk => chunk.data.byteLength }
	)

	return {
		target: new StreamTarget(stream, { chunked: true, chunkSize: OUTPUT_CHUNK_BYTES }),
		written: () => expected
	}
}
