import { useEffect, useState } from "react"
import { log } from "@/lib/log"

export type TextFamilyReading<T> = { status: "pending" } | { status: "done"; value: T } | { status: "failed" }

// A text read in the text-family worker by `read` (a module-scope function), again whenever the text changes. A failure
// is logged under `what`.
export function useTextFamilyReading<T>(text: string, read: (text: string) => Promise<T>, what: string): TextFamilyReading<T> {
	const [state, setState] = useState<TextFamilyReading<T>>({ status: "pending" })

	useEffect(() => {
		let live = true

		read(text).then(
			value => {
				if (live) setState({ status: "done", value })
			},
			(e: unknown) => {
				log.error("preview", `reading ${what} failed`, e)

				if (live) setState({ status: "failed" })
			}
		)

		return () => {
			live = false
		}
	}, [text, read, what])

	return state
}
