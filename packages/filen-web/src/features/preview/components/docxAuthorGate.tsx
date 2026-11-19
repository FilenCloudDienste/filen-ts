import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import type { DocxEditorCommand, DocxRefusalReason } from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { DocxAuthorGate } from "@/features/preview/components/docxAuthorGate.logic"
import { ensureAuthorName } from "@/features/office/lib/officeSettings"
import { AuthorNameDialog } from "@/features/office/components/authorNameDialog"
import { useLatestRef } from "@/lib/useLatestRef"

export interface DocxAuthorGateOptions {
	authorName: string | null
	// The editor whose refused edits ask for the name (undefined while it opens).
	editor: PagedEditor | undefined
	// Runs a command through the host (turning tracking off instead of giving a name).
	execute: (command: DocxEditorCommand) => void
}

export interface DocxAuthorGateControls {
	withAuthor: DocxAuthorGate
	// The dialog asking for the name, rendered by the host.
	dialog: ReactNode
}

interface Question {
	readonly answer: (name: string | null) => void
	// Asked because track changes needs the name: turning tracking off is offered instead.
	readonly tracking: boolean
}

// What a question asked after the editor closed gets.
const CLOSED = AbortSignal.abort()
// Edits refused for one reason this close together are one burst (a key held, say): told about once.
const REFUSAL_BURST_MS = 2000

// The author name gate: commands that record one ask for it first (withAuthor); an edit the editor refused
// for want of it (typing while tracking) asks too, offering to turn track changes off. The refused edit is
// dropped, never made later and never with a stand-in name; a dismissed prompt asks again at the next edit,
// and refusals while it is open are not asked about again. An edit refused because what it changes cannot be
// saved (tracked), or because it would break what the document keeps (a section break, a locked block, a form
// field), is told about in a toast, once per burst of them.
export function useDocxAuthorGate({ authorName, editor, execute }: DocxAuthorGateOptions): DocxAuthorGateControls {
	const { t } = useTranslation("preview")
	const tRef = useLatestRef(t)
	const [question, setQuestion] = useState<Question | null>(null)
	const editorRef = useLatestRef(editor)
	// Aborted once the editor closes: a question still open (or about to be asked) is declined.
	const signalRef = useRef<AbortSignal>(CLOSED)
	// A question is asked or being prepared: refusals meanwhile ask nothing more.
	const askingRef = useRef(false)
	const [withAuthor] = useState(() => (run: (author: string) => void): void => {
		askingRef.current = true

		void ensureAuthorName(
			() =>
				new Promise<string | null>(resolve => {
					const snapshot = editorRef.current?.snapshot()

					// Turning tracking off is offered only where it can be (not in a protected document, say).
					setQuestion({ answer: resolve, tracking: snapshot?.review.authorNeeded === true && snapshot.enabled["review.track"] })
				}),
			signalRef.current
		).then(author => {
			askingRef.current = false

			if (author !== null) {
				run(author)
			}
		})
	})

	useEffect(() => {
		const controller = new AbortController()

		signalRef.current = controller.signal

		return () => {
			controller.abort()
			signalRef.current = CLOSED
		}
	}, [])

	// An edit refused for want of the name asks for it; the name given is the editor's from then on (the host
	// passes the setting on), the edit itself stays undone.
	useEffect(() => {
		if (editor === undefined) {
			return
		}

		// When the last edit told about in a toast was refused, and why: a burst goes on while refusals for the same
		// reason come closer than REFUSAL_BURST_MS.
		let lastToasted = Number.NEGATIVE_INFINITY
		let lastReason: DocxRefusalReason | undefined = undefined

		return editor.onRefused(reason => {
			if (reason !== "authorNeeded") {
				const now = Date.now()
				const burst = reason === lastReason && now - lastToasted < REFUSAL_BURST_MS

				lastToasted = now
				lastReason = reason

				if (!burst) {
					if (reason === "unsupported") {
						toast.error(tRef.current("previewDocxEditUnsupported"), {
							description: tRef.current("previewDocxEditUnsupportedBody")
						})
					} else {
						toast.error(tRef.current("previewDocxEditProtected"), { description: tRef.current("previewDocxEditProtectedBody") })
					}
				}

				return
			}

			if (askingRef.current) {
				return
			}

			withAuthor(() => undefined)
		})
	}, [editor, withAuthor, tRef])

	const reply = (name: string | null): void => {
		question?.answer(name)
		setQuestion(null)
	}

	return {
		withAuthor,
		dialog: (
			<AuthorNameDialog
				open={question !== null}
				pending={false}
				initialValue={authorName}
				onOpenChange={open => {
					if (!open) {
						reply(null)
					}
				}}
				onSubmit={reply}
				onTurnOffTracking={
					question?.tracking === true
						? () => {
								reply(null)
								execute({ type: "review.track", on: false })
							}
						: undefined
				}
			/>
		)
	}
}
