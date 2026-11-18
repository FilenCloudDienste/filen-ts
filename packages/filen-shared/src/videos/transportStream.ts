// A transport stream is never this small, and a declaration file (`lib.d.ts`) is always TypeScript.
export const MIN_TRANSPORT_STREAM_BYTES = 1024 * 1024

// Whether a `.ts` / `.mts` file of this size and lowercase stem (name without extension) could be a transport stream.
export function mayBeTransportStream(size: number, lowerStem: string): boolean {
	return size >= MIN_TRANSPORT_STREAM_BYTES && !lowerStem.endsWith(".d")
}
