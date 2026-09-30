import { create } from "zustand"
import type { QuillFormats } from "@/components/textEditor/richText/dom"

export type RichtextStore = {
	formats: QuillFormats
	setFormats: (formats: QuillFormats) => void
}

export const useRichtextStore = create<RichtextStore>(set => ({
	formats: {},
	setFormats(formats) {
		set({
			formats
		})
	}
}))

export default useRichtextStore
