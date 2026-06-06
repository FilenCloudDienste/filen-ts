import { create } from "zustand"
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

export const useChecklistStore = create<ChecklistStore>(set => ({
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

export default useChecklistStore
