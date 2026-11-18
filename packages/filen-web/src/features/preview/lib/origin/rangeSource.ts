import * as Comlink from "comlink"
import { originSize, type ByteOrigin, type OriginAccess } from "@/lib/sdk/byteOrigin"
import { rangePortReader, type RangePortReader } from "@/lib/media/rangePort"
import type { RangeReadBudget } from "@/lib/media/rangeReads"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { serveBlobPort } from "@/features/preview/lib/origin/blobPort"

export interface OriginRangeSourceOptions {
	// The surface asking (usePreviewAccessMode): a public link's reads only what needs no session.
	readonly access: OriginAccess
	// Only this many bytes from the start are the source (a byte prefix shown as a file of its own). Unset: all of it.
	readonly limit?: number
	// The page reader's reads each take a permit of this budget (ranked first).
	readonly budget?: RangeReadBudget
}

export interface OriginRangeSource {
	// The source's length: the origin's size, or the limit below it.
	readonly size: number
	// The page's own reads.
	readonly reader: RangePortReader
	// A further port on the same bytes, to transfer to a worker reading them itself. Ends with close().
	port(): Promise<MessagePort>
	// Ends the reader and every port opened through port().
	close(): void
}

const FIRST = (): number => 0

// Ports on an origin's bytes, each for a reader of its own (a worker reading them itself); none is opened until asked.
export interface OriginPorts {
	// The source's length: the origin's size, or the limit below it.
	readonly size: number
	// A port on the bytes, served by the SDK worker for the kinds it reads (under `token`, which the preview's cancel
	// registry ends), by the page over blob.slice for a `bytes` origin. Rejects when it cannot be opened (no session for
	// a drive file, a closed archive reader). Ends with close().
	port(): Promise<MessagePort>
	// Ends every port opened through port(), and the token.
	close(): void
}

export function openOriginPorts(
	origin: ByteOrigin,
	token: string,
	options: Pick<OriginRangeSourceOptions, "access" | "limit">
): OriginPorts {
	const { access, limit } = options
	const full = originSize(origin)
	// A `bytes` origin's ports, each ended by its own lifetime; the SDK worker's all end with the token.
	const served: AbortController[] = []
	let closed = false

	return {
		size: limit === undefined ? full : Math.max(0, Math.min(limit, full)),
		port: async () => {
			if (closed) {
				throw new Error("range source closed")
			}

			if (origin.kind === "bytes") {
				const lifetime = new AbortController()

				served.push(lifetime)

				return serveBlobPort(origin.blob, lifetime)
			}

			const { port1, port2 } = new MessageChannel()

			try {
				await runOp(sdkApi.openOriginRangePort(Comlink.transfer(port1, [port1]), origin, access, token))
			} catch (e) {
				port2.close()

				throw e
			}

			return port2
		},
		close: () => {
			if (closed) {
				return
			}

			closed = true

			for (const lifetime of served.splice(0)) {
				lifetime.abort()
			}

			if (origin.kind !== "bytes") {
				void sdkApi.cancelPreviewDownload(token)
			}
		}
	}
}

// An origin's bytes by range through ports (openOriginPorts), with a reader of the page's own on the first. Rejects when
// that port cannot be opened.
export async function openOriginRangeSource(
	origin: ByteOrigin,
	token: string,
	options: OriginRangeSourceOptions
): Promise<OriginRangeSource> {
	const { budget } = options
	const ports = openOriginPorts(origin, token, options)
	let opened: RangePortReader

	try {
		opened = rangePortReader(await ports.port())
	} catch (e) {
		ports.close()

		throw e
	}

	const reader: RangePortReader =
		budget === undefined
			? opened
			: {
					...opened,
					readRange: (start, end, signal) => budget.run(FIRST, () => opened.readRange(start, end, signal)),
					readChecked: (start, end, crc, signal) => budget.run(FIRST, () => opened.readChecked(start, end, crc, signal))
				}
	let closed = false

	return {
		size: ports.size,
		reader,
		port: () => ports.port(),
		close: () => {
			if (closed) {
				return
			}

			closed = true
			opened.close()
			ports.close()
		}
	}
}
