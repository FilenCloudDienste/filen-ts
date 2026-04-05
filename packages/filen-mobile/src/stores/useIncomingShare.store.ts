import { create } from "zustand"

export type IncomingShareStore = {
	process: boolean
	setProcess: (fn: boolean | ((prev: boolean) => boolean)) => void
}

export const useIncomingShareStore = create<IncomingShareStore>(set => ({
	process: false,
	setProcess(fn) {
		set(state => ({
			process: typeof fn === "function" ? fn(state.process) : fn
		}))
	}
}))

export default useIncomingShareStore
