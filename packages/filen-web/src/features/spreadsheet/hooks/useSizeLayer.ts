import { useEffect, useRef, useState } from "react"
import {
	EMPTY_LAYER,
	followShift,
	loadLayer,
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

function persist(key: LayerKey, layer: SizeLayer): void {
	saveLayer(key, layer).catch((e: unknown) => {
		log.error("spreadsheet", "keeping column and row sizes failed", e)
	})
}

// A change to the layer, with the stash an undone delete takes its sizes back from.
type LayerChange = (current: { layer: SizeLayer; stash: StashedSizes[] }) => { layer: SizeLayer; stash: StashedSizes[] }

// The local size layer of the file on show: loaded once per key, saved once per change. The layer of
// record is held in a ref, so two changes before a re-render both land; changes made before the stored
// sizes have loaded are replayed onto them, and nothing is saved until then (a save would replace them).
export function useSizeLayer(key: LayerKey): SizeLayerHandle {
	const { kind, id } = key
	const keyId = `${kind}:${id}`
	const [shown, setShown] = useState<{ keyId: string; layer: SizeLayer }>({ keyId, layer: EMPTY_LAYER })
	const current = useRef<{ layer: SizeLayer; stash: StashedSizes[] }>({ layer: EMPTY_LAYER, stash: [] })
	// Changes made before the stored sizes loaded; null once they have.
	const pending = useRef<LayerChange[] | null>([])

	// Another file starts from nothing (its refs are reset by the effect below, before its load).
	if (shown.keyId !== keyId) {
		setShown({ keyId, layer: EMPTY_LAYER })
	}

	useEffect(() => {
		let live = true

		current.current = { layer: EMPTY_LAYER, stash: [] }
		pending.current = []

		loadLayer({ kind, id }).then(
			loaded => {
				if (!live) {
					return
				}

				const replayed = (pending.current ?? []).reduce((state, change) => change(state), {
					layer: loaded,
					stash: [] as StashedSizes[]
				})
				const changed = (pending.current?.length ?? 0) > 0

				pending.current = null
				current.current = replayed
				setShown({ keyId: `${kind}:${id}`, layer: replayed.layer })

				if (changed) {
					persist({ kind, id }, replayed.layer)
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

	function change(apply: LayerChange): void {
		const before = current.current.layer

		current.current = apply(current.current)
		pending.current?.push(apply)

		if (current.current.layer === before) {
			return
		}

		setShown({ keyId, layer: current.current.layer })

		if (pending.current === null) {
			persist({ kind, id }, current.current.layer)
		}
	}

	return {
		layer: shown.keyId === keyId ? shown.layer : EMPTY_LAYER,
		update: (sheet, axis, entries) => {
			change(state => ({ layer: updateLayer(state.layer, sheet, axis, entries), stash: state.stash }))
		},
		follow: (sheet, shift) => {
			change(state => followShift(state.layer, sheet, shift, state.stash))
		}
	}
}
