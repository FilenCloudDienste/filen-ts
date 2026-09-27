import { useEffect, useRef, useState } from "react"
import {
	EMPTY_LAYER,
	followShift,
	loadLayer,
	mergeLayers,
	saveLayer,
	updateLayer,
	type LayerKey,
	type SizeLayer,
	type StashedSizes
} from "@/features/spreadsheet/lib/sizeLayer"
import type { AxisShift, SizeAxis, SizeEntry } from "@/features/spreadsheet/lib/sizes.logic"
import { log } from "@/lib/log"

export interface SizeLayerHandle {
	layer: SizeLayer
	update: (sheet: number, axis: SizeAxis, entries: readonly SizeEntry[]) => void
	// A CSV's rows or columns moved: its sizes move with them (an undone delete gets its sizes back).
	follow: (sheet: number, shift: AxisShift & { revert: boolean }) => void
}

// The local size layer of the file on show: loaded once per key, saved once per change.
export function useSizeLayer(key: LayerKey): SizeLayerHandle {
	const { kind, id } = key
	const keyId = `${kind}:${id}`
	// The layer belongs to the file it was loaded for: another file starts from nothing.
	const [held, setHeld] = useState<{ keyId: string; layer: SizeLayer }>({ keyId, layer: EMPTY_LAYER })
	const stash = useRef<StashedSizes[]>([])

	if (held.keyId !== keyId) {
		setHeld({ keyId, layer: EMPTY_LAYER })
	}

	const layer = held.keyId === keyId ? held.layer : EMPTY_LAYER

	useEffect(() => {
		let live = true

		stash.current = []

		loadLayer({ kind, id }).then(
			loaded => {
				if (live) {
					// Sizes set while it loaded (none, almost always) win.
					setHeld(since => {
						const loadedFor = `${kind}:${id}`

						return { keyId: loadedFor, layer: mergeLayers(loaded, since.keyId === loadedFor ? since.layer : EMPTY_LAYER) }
					})
				}
			},
			(e: unknown) => {
				log.error("spreadsheet", "reading kept column and row sizes failed", e)
			}
		)

		return () => {
			live = false
		}
	}, [kind, id])

	function commit(next: SizeLayer): void {
		setHeld({ keyId, layer: next })
		saveLayer({ kind, id }, next).catch((e: unknown) => {
			log.error("spreadsheet", "keeping column and row sizes failed", e)
		})
	}

	return {
		layer,
		update: (sheet, axis, entries) => {
			commit(updateLayer(layer, sheet, axis, entries))
		},
		follow: (sheet, shift) => {
			const next = followShift(layer, sheet, shift, stash.current)

			stash.current = next.stash

			if (next.layer !== layer) {
				commit(next.layer)
			}
		}
	}
}
