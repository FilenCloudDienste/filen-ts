export interface SyncIndexRedirectInput {
	// undefined while the stored value is still being read.
	storedId: string | null | undefined
	// null while the first overview is in flight.
	pairIds: readonly string[] | null
}

// Where bare /sync goes: the last opened pair (an id) while the overview still holds it, the select prompt (null),
// or undecided (undefined).
export function syncIndexRedirectTarget({ storedId, pairIds }: SyncIndexRedirectInput): string | null | undefined {
	if (storedId === null) {
		return null
	}

	if (storedId === undefined || pairIds === null) {
		return undefined
	}

	return pairIds.includes(storedId) ? storedId : null
}
