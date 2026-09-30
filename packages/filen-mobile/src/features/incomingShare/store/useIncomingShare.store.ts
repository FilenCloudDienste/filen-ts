import { create } from "zustand"

export type IncomingShareStore = {
	process: boolean
	setProcess: (value: boolean) => void
}

export const useIncomingShareStore = create<IncomingShareStore>(set => ({
	process: false,
	setProcess(value) {
		set({
			process: value
		})
	}
}))

export default useIncomingShareStore
