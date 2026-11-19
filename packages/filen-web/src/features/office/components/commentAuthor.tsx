import { useEffect, useRef, useState } from "react"
import { AuthorNameDialog } from "@/features/office/components/authorNameDialog"
import { ensureAuthorName, useOfficeSettings } from "@/features/office/lib/officeSettings"

// What a question asked before the host mounted, or after it unmounted, gets.
const CLOSED = AbortSignal.abort()

// The user's author name for comments and annotations, asked for the first time (as the document editor does): `ask`
// resolves to the name, null when the dialog was dismissed or its host went (Back, a closed file). The caller renders
// `dialog`.
export function useCommentAuthor() {
	const settings = useOfficeSettings()
	const [asking, setAsking] = useState<((name: string | null) => void) | null>(null)
	// The open question's answer, for the unmount below (state is out of its reach).
	const resolver = useRef<((name: string | null) => void) | null>(null)
	// Aborted once the host unmounts: the question is dropped, never left for an answer that cannot come.
	const signal = useRef<AbortSignal>(CLOSED)

	useEffect(() => {
		const controller = new AbortController()

		signal.current = controller.signal

		return () => {
			controller.abort()
			signal.current = CLOSED
			resolver.current?.(null)
			resolver.current = null
		}
	}, [])

	const ask = (): Promise<string | null> =>
		ensureAuthorName(
			() =>
				new Promise<string | null>(resolve => {
					resolver.current = resolve
					setAsking(() => resolve)
				}),
			signal.current
		)

	function answer(name: string | null): void {
		asking?.(name)
		resolver.current = null
		setAsking(null)
	}

	const dialog = (
		<AuthorNameDialog
			open={asking !== null}
			pending={false}
			initialValue={settings.authorName}
			onOpenChange={next => {
				if (!next) {
					answer(null)
				}
			}}
			onSubmit={answer}
		/>
	)

	return { author: settings.authorName, initials: settings.authorInitials, ask, dialog }
}
