import { createStore, type StoreApi } from "zustand"
import { createContext } from "react"
import type { Checklist } from "@filen/utils"
import type { TextInput } from "react-native"

export type ChecklistStore = {
	parsed: Checklist
	inputRefs: Record<string, React.RefObject<TextInput | null>>
	initialIds: Record<string, boolean>
	ids: string[]
	setIds: (fn: string[] | ((prev: string[]) => string[])) => void
	setInitialIds: (fn: Record<string, boolean> | ((prev: Record<string, boolean>) => Record<string, boolean>)) => void
	setParsed: (fn: Checklist | ((prev: Checklist) => Checklist)) => void
	setInputRefs: (
		fn:
			| Record<string, React.RefObject<TextInput | null>>
			| ((prev: Record<string, React.RefObject<TextInput | null>>) => Record<string, React.RefObject<TextInput | null>>)
	) => void
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
		inputRefs: {},
		initialIds: {},
		ids: [],
		setIds(fn) {
			set(state => ({
				ids: typeof fn === "function" ? fn(state.ids) : fn
			}))
		},
		setInitialIds(fn) {
			set(state => ({
				initialIds: typeof fn === "function" ? fn(state.initialIds) : fn
			}))
		},
		setInputRefs(fn) {
			set(state => ({
				inputRefs: typeof fn === "function" ? fn(state.inputRefs) : fn
			}))
		},
		setParsed(fn) {
			set(state => ({
				parsed: typeof fn === "function" ? fn(state.parsed) : fn
			}))
		}
	}))
}

export const ChecklistStoreContext = createContext<ChecklistStoreApi | null>(null)

export default createChecklistStore
