import { create } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"
import type { AnyFile } from "@filen/sdk-rs"

export type HttpStore = {
	port: number | null
	getFileUrl: ((file: AnyFile) => string) | null
	setGetFileUrl: (fn: ((file: AnyFile) => string) | null) => void
	setPort: (fn: number | null | ((prev: number | null) => number | null)) => void
}

export const useHttpStore = create<HttpStore>()(
	subscribeWithSelector(set => ({
		port: null,
		getFileUrl: null,
		setGetFileUrl(fn) {
			set(state => ({
				getFileUrl: typeof fn === "function" || fn === null ? fn : state.getFileUrl
			}))
		},
		setPort(fn) {
			set(state => ({
				port: typeof fn === "function" ? fn(state.port) : fn
			}))
		}
	}))
)

export default useHttpStore
