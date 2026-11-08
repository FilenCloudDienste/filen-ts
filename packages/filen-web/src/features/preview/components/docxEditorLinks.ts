import { createElement, useState, type ReactNode, type RefObject } from "react"
import { flushSync } from "react-dom"
import { TextSelection } from "prosemirror-state"
import { docxBookmarkStart, type DocxLinkAt, type PagedEditor } from "@filen/office/core/docx/paged"
import { linkActivator } from "@filen/office/react/docx"
import type { DocxEditorHandle } from "@filen/office/react/docx/editor"
import { DocxLinkGate } from "@/features/preview/components/docxLinkGate"
import { isSafeAbsoluteHref } from "@/lib/safeUrl"

// Following a hyperlink from the editor (Ctrl/Cmd+Click, Open link), as Word does: a link to a bookmark puts the
// caret there; a web or mail link opens in a new tab with no opener, judged when followed, once its domain is
// trusted (the viewer's gate, mounted on the first link followed so an editor no one follows a link in never
// reads the trust set).

export interface DocxLinkFollow {
	follow: (link: DocxLinkAt) => void
	// The trust confirmation, rendered by the editor.
	gate: ReactNode
}

interface Opener {
	open: ((href: string) => void) | null
	register: (open: (href: string) => void) => void
}

export function useDocxLinkFollow(
	editor: PagedEditor | undefined,
	handleRef: RefObject<DocxEditorHandle | null>,
	focusEditor: () => void
): DocxLinkFollow {
	// What the gate registers once mounted; one object for the editor's life.
	const [opener] = useState<Opener>(() => {
		const holder: Opener = {
			open: null,
			register: open => {
				holder.open = open
			}
		}

		return holder
	})
	const [gateMounted, setGateMounted] = useState(false)

	const follow = (link: DocxLinkAt): void => {
		if (editor === undefined) {
			return
		}

		if (link.target === null) {
			const at = link.anchor === null ? undefined : docxBookmarkStart(editor, link.anchor)

			if (at === undefined) {
				return
			}

			const body = editor.body.session

			if (editor.activeStory !== body.story.story.index) {
				editor.exitStory()
			}

			body.dispatch(body.state.tr.setSelection(TextSelection.near(body.state.doc.resolve(at))))
			handleRef.current?.scrollToCaret()
			focusEditor()

			return
		}

		const href = link.anchor === null ? link.target : `${link.target}#${link.anchor}`

		linkActivator({
			allow: isSafeAbsoluteHref,
			open: safe => {
				// Mounted synchronously, so the link still opens inside the click's user activation.
				if (opener.open === null) {
					flushSync(() => {
						setGateMounted(true)
					})
				}

				opener.open?.(safe)
			}
		})({ kind: "external", href, tooltip: undefined })
	}

	return { follow, gate: gateMounted ? createElement(DocxLinkGate, { register: opener.register }) : null }
}
