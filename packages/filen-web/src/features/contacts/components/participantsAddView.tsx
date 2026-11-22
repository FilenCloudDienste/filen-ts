import { useState } from "react"
import { useTranslation } from "react-i18next"
import type { UseQueryResult } from "@tanstack/react-query"
import type { Contact } from "@filen/sdk-rs"
import { toggleInSet } from "@filen/shared"
import type { ContactsQueryData } from "@/features/contacts/queries/contacts"
import { ContactPickerList } from "@/features/contacts/components/contactPickerList"
import { resolveSelectedContacts } from "@/features/contacts/lib/contactPicker.logic"
import { useIsOnline } from "@/lib/useIsOnline"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

// Entering add mode unmounts the control that opened it; focus goes to the picker's filter box, or Cancel without one.
function focusAddView(element: HTMLDivElement | null): void {
	element?.querySelector<HTMLElement>("input, button:not([disabled])")?.focus()
}

// A side panel's add-participants view (the chat info panel's, the note participants panel's): the contacts picker
// over Cancel and Add. Mounted only in add mode, so its selection and filter start empty every time. `onAdd` runs the
// write and leaves add mode on success; Add shows a spinner until it settles.
export function ParticipantsAddView({
	contactsQuery,
	exclude,
	body,
	onAdd,
	onCancel
}: {
	contactsQuery: UseQueryResult<ContactsQueryData>
	// The target's current participants, left out of the candidates.
	exclude: readonly { userId: bigint }[]
	body: string
	onAdd: (contacts: Contact[]) => Promise<void>
	onCancel: () => void
}) {
	const { t } = useTranslation("common")
	const isOnline = useIsOnline()
	const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
	const [filter, setFilter] = useState("")
	const [pending, setPending] = useState(false)

	async function handleAdd(): Promise<void> {
		const chosen = resolveSelectedContacts(contactsQuery.data?.contacts ?? [], selected)

		if (chosen.length === 0) {
			return
		}

		setPending(true)
		await onAdd(chosen)
		setPending(false)
	}

	return (
		<div
			ref={focusAddView}
			className="flex min-h-0 flex-1 flex-col gap-3 px-3 pb-3"
		>
			<div className="px-1">
				<h3 className="text-sm font-medium">{t("participantsAddDialogTitle")}</h3>
				<p className="text-xs text-muted-foreground">{body}</p>
			</div>
			<ContactPickerList
				contactsQuery={contactsQuery}
				filter={filter}
				onFilterChange={setFilter}
				selected={selected}
				onToggle={uuid => {
					setSelected(prev => toggleInSet(prev, uuid))
				}}
				ariaLabel={t("participantsAddDialogTitle")}
				emptyTitle={t("participantsAddEmpty")}
				exclude={exclude}
			/>
			<div className="flex justify-end gap-2">
				<Button
					variant="outline"
					disabled={pending}
					onClick={onCancel}
				>
					{t("cancel")}
				</Button>
				<Button
					disabled={selected.size === 0 || pending || !isOnline}
					title={isOnline ? undefined : t("offlineActionDisabled")}
					onClick={() => {
						void handleAdd()
					}}
				>
					{pending && <Spinner data-icon="inline-start" />}
					{t("participantsAddSubmit")}
				</Button>
			</div>
		</div>
	)
}
