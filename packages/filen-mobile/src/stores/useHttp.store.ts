import { create } from "zustand"
import { subscribeWithSelector } from "zustand/middleware"
import type { AnyFile } from "@filen/sdk-rs"

export type HttpStore = {
	port: number | null
	getFileUrl: ((file: AnyFile) => string) | null
	setGetFileUrl: (fn: ((file: AnyFile) => string) | null) => void
	setPort: (port: number | null) => void
}

export const useHttpStore = create<HttpStore>()(
	subscribeWithSelector(set => ({
		port: null,
		getFileUrl: null,
		setGetFileUrl(fn) {
			set({ getFileUrl: fn })
		},
		setPort(port) {
			set({ port })
		}
	}))
)

export default useHttpStore
