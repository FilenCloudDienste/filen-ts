import { createStore, type StoreApi } from "zustand"
import { createContext } from "react"
import type { Checklist, ChecklistItem } from "@filen/shared"
import type { TextInput } from "react-native"

export type ChecklistStore = {
	parsed: Checklist
	// Derived from `parsed` by setParsed (first occurrence wins, matching Array.prototype.find) so
	// per-row selectors are O(1) instead of scanning `parsed` on every notify.
	byId: Map<string, ChecklistItem>
	// Mutated in place and never replaced: nothing subscribes to it, so a reactive `set` would only
	// re-run every row selector on each row mount/unmount.
	inputRefs: Map<string, React.RefObject<TextInput | null>>
	setParsed: (fn: Checklist | ((prev: Checklist) => Checklist)) => void
}

export type ChecklistStoreApi = StoreApi<ChecklistStore>

// Per-editor-INSTANCE store. A vanilla store created fresh per mounted <Checklist> (held in a
// useRef and provided via ChecklistStoreContext) — NOT a module-global singleton and NOT keyed by
// note uuid. The live editor and a history "View" of the same note share the uuid but must own
// independent checklist state, so isolation has to be per component instance. The per-mount store
// is garbage-collected when its <Checklist> unmounts.
export function createChecklistStore(): ChecklistStoreApi {
	return createStore<ChecklistStore>(set => ({
		parsed: [],
		byId: new Map(),
		inputRefs: new Map(),
		setParsed(fn) {
			set(state => {
				const parsed = typeof fn === "function" ? fn(state.parsed) : fn
				const byId = new Map<string, ChecklistItem>()

				for (const item of parsed) {
					if (!byId.has(item.id)) {
						byId.set(item.id, item)
					}
				}

				return {
					parsed,
					byId
				}
			})
		}
	}))
}

export const ChecklistStoreContext = createContext<ChecklistStoreApi | null>(null)

export default createChecklistStore
