import { useEffect, useEffectEvent, useState } from "react"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import { withPdfSession, type PdfToolContext } from "@/features/pdf/tools/registry"

// The editor session a tool's panel or overlay reads from (starting the editor when it is not open yet: choosing the
// tool is the intent to change the document). `stale()` drops it after a request failed because the engine it belongs
// to closed (a save moved the editor to a fresh engine): the current session is fetched again.
export function useToolSession(context: PdfToolContext): { readonly session: PdfEditSessionModel | null; readonly stale: () => void } {
	const [session, setSession] = useState<PdfEditSessionModel | null>(null)
	const [generation, setGeneration] = useState(0)
	const acquire = useEffectEvent(() => withPdfSession(context, current => Promise.resolve(current)))

	useEffect(() => {
		let live = true

		void acquire().then(
			current => {
				if (live) setSession(current)
			},
			() => undefined
		)

		return () => {
			live = false
		}
	}, [generation])

	return {
		session,
		stale: () => {
			setGeneration(value => value + 1)
		}
	}
}
