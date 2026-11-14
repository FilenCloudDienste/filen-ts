import { useState } from "react"
import { AuthorNameDialog } from "@/features/office/components/authorNameDialog"
import { ensureAuthorName, useOfficeSettings } from "@/features/office/lib/officeSettings"

// The user's author name for comments and annotations, asked for the first time (as the document editor does): `ask`
// resolves to the name, null when the dialog was dismissed. The caller renders `dialog`.
export function useCommentAuthor() {
	const settings = useOfficeSettings()
	const [asking, setAsking] = useState<((name: string | null) => void) | null>(null)
	const ask = (): Promise<string | null> =>
		ensureAuthorName(
			() =>
				new Promise<string | null>(resolve => {
					setAsking(() => resolve)
				})
		)
	const dialog = (
		<AuthorNameDialog
			open={asking !== null}
			pending={false}
			initialValue={settings.authorName}
			onOpenChange={next => {
				if (!next) {
					asking?.(null)
					setAsking(null)
				}
			}}
			onSubmit={name => {
				asking?.(name)
				setAsking(null)
			}}
		/>
	)

	return { author: settings.authorName, initials: settings.authorInitials, ask, dialog }
}
