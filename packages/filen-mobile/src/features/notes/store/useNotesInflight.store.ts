import { create } from "zustand"

export type InflightContent = Record<
	string,
	{
		timestamp: number
		content: string
		note: import("@/types").Note
	}[]
>

export type NotesInflightStore = {
	inflightContent: InflightContent
	setInflightContent: (fn: InflightContent | ((prev: InflightContent) => InflightContent)) => void
}

export const useNotesInflightStore = create<NotesInflightStore>(set => ({
	inflightContent: {},
	setInflightContent(fn) {
		set(state => ({
			inflightContent: typeof fn === "function" ? fn(state.inflightContent) : fn
		}))
	}
}))

export default useNotesInflightStore
