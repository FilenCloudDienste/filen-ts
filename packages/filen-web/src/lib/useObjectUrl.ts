import { useEffect, useState } from "react"

// A blob URL for `source`, revoked when the source changes or the component unmounts. null until the
// first mint. Raw bytes are wrapped in the effect, never in render, because new Blob copies them.
export function useObjectUrl(source: Blob | Uint8Array, mime?: string): string | null {
	const [url, setUrl] = useState<string | null>(null)

	useEffect(() => {
		// The generic ArrayBufferLike-vs-ArrayBuffer parameter on Uint8Array (TS lib.es2024.arraybuffer)
		// makes an unparameterized Uint8Array reject BlobPart's stricter ArrayBufferView<ArrayBuffer> —
		// bytes here are always backed by a real ArrayBuffer (Comlink.transfer of a worker download, never
		// a SharedArrayBuffer), so this narrows the generic parameter only, not the value.
		const blob =
			source instanceof Blob ? source : new Blob([source as Uint8Array<ArrayBuffer>], { type: mime ?? "application/octet-stream" })
		const objectUrl = URL.createObjectURL(blob)

		// Minting the blob URL IS the side effect (a fresh external-system resource requiring a paired
		// revoke) — there is no value to render until this runs, so it cannot be computed during render. A
		// useMemo/lazy-useState alternative would recompute under StrictMode's double-invoke with no
		// cleanup hook to revoke the discarded first URL, leaking it; this effect's own cleanup below is
		// exactly what makes the double-invoke safe (create/revoke/create, no leak).
		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate, see above
		setUrl(objectUrl)

		return () => {
			URL.revokeObjectURL(objectUrl)
		}
	}, [source, mime])

	return url
}
