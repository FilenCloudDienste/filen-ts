import { create } from "zustand"

export type HttpStore = {
	port: number | null
	setPort: (fn: number | ((prev: number | null) => number | null)) => void
}

export const useHttpStore = create<HttpStore>(set => ({
	port: null,
	setPort(fn) {
		set(state => ({
			port: typeof fn === "function" ? fn(state.port) : fn
		}))
	}
}))

export default useHttpStore
