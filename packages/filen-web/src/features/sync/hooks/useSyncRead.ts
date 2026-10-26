import { useEffect, useEffectEvent, useState } from "react"
import type { DesktopSyncError, DesktopSyncResult } from "@filen/shared/desktop"

interface ReadState<T> {
	key: string | null
	data: T | undefined
	error: DesktopSyncError | null
	generation: number
}

export interface SyncRead<T> {
	// undefined until read.
	data: T | undefined
	error: DesktopSyncError | null
	loading: boolean
	reload: () => void
}

// One sync read (held deletions, a dry run, the ignore rules) for as long as the component shows it. `key` names
// what is read; a new key reads again, null reads nothing. Held in the component only: the shell is the source.
export function useSyncRead<T>(key: string | null, load: () => Promise<DesktopSyncResult<T>>): SyncRead<T> {
	const [state, setState] = useState<ReadState<T>>({ key, data: undefined, error: null, generation: 0 })

	// Reset in render (react.dev's "adjusting state when a prop changes"), not an effect.
	if (state.key !== key) {
		setState({ key, data: undefined, error: null, generation: state.generation })
	}

	const read = useEffectEvent(load)
	const { generation } = state

	useEffect(() => {
		if (key === null) {
			return
		}

		let cancelled = false

		function settle(next: Pick<ReadState<T>, "data" | "error">): void {
			if (!cancelled) {
				setState(prev => (prev.key === key ? { ...prev, ...next } : prev))
			}
		}

		read().then(
			result => {
				settle(result.ok ? { data: result.value, error: null } : { data: undefined, error: result.error })
			},
			() => {
				settle({ data: undefined, error: { code: "unknown" } })
			}
		)

		return () => {
			cancelled = true
		}
	}, [key, generation])

	return {
		data: state.data,
		error: state.error,
		loading: key !== null && state.data === undefined && state.error === null,
		reload: () => {
			setState(prev => ({ ...prev, data: undefined, error: null, generation: prev.generation + 1 }))
		}
	}
}
