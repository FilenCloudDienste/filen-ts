import { run } from "@filen/shared"
import { Fragment, useState, useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { ScreenBody } from "@/components/ui/safeAreaView"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty, { NoResultsEmpty } from "@/components/ui/listEmpty"
import Button from "@/components/ui/button"
import alerts from "@/lib/alerts"
import { addContactFlow } from "@/features/contacts/contactsActions"
import useContactsStore, { type ContactListItemWithHeader } from "@/features/contacts/store/useContacts.store"
import { useFocusEffect } from "expo-router"
import events from "@/lib/events"
import Header from "@/features/contacts/components/contactsHeader"
import Contact from "@/features/contacts/components/contactRow"
import { ListRowSectionHeader } from "@/components/ui/listRow"
import { useSelectOptions } from "@/features/contacts/contactsSelect"
import useContactSections from "@/features/contacts/hooks/useContactSections"
import useOnUnmountWithLatest from "@/hooks/useOnUnmountWithLatest"
import { TAB_LIST_CONTENT_CLASS } from "@/constants"
import logger from "@/lib/logger"

const Contacts = () => {
	const { t } = useTranslation()
	const [searchQuery, setSearchQuery] = useState<string>("")
	const selectOptions = useSelectOptions()
	const { items, contactsQuery, contactRequestsQuery } = useContactSections({
		searchQuery,
		selectOptions
	})

	// When in picker mode, emit a cancellation on unmount so selectContacts()
	// resolves and removes its contactsSelect listener. Without this, dismissing
	// the modal via OS back gesture / header close (which emit no event) leaves
	// the awaiting promise pending forever and leaks the listener. A confirmed
	// selection emits its own event + removes the listener before this fires.
	useOnUnmountWithLatest(selectOptions, latestSelectOptions => {
		if (!latestSelectOptions) {
			return
		}

		events.emit("contactsSelect", {
			id: latestSelectOptions.id,
			cancelled: true
		})
	})

	const keyExtractor = (item: ContactListItemWithHeader) => {
		switch (item.type) {
			case "contact": {
				return `contact-${item.data.uuid}`
			}

			case "blocked": {
				return `blocked-${item.data.uuid}`
			}

			case "incomingRequest": {
				return `incomingRequest-${item.data.uuid}`
			}

			case "outgoingRequest": {
				return `outgoingRequest-${item.data.uuid}`
			}

			case "header": {
				return `header-${item.data.id}`
			}
		}
	}

	const renderItem = (info: ListRenderItemInfo<ContactListItemWithHeader>) => {
		if (info.item.type === "header") {
			return <ListRowSectionHeader title={info.item.data.title} />
		}

		return (
			<Contact
				info={info}
				nextItem={info.index < items.length - 1 ? items[info.index + 1] : undefined}
			/>
		)
	}

	const onRefresh = async () => {
		const result = await run(async () => {
			await Promise.all([contactsQuery.refetch(), contactRequestsQuery.refetch()])
		})

		if (!result.success) {
			logger.error("contacts", "Contacts list refresh failed", { error: result.error })
			alerts.error(result.error)
		}
	}

	const emptyComponent = () => {
		if (searchQuery.length > 0) {
			return (
				<NoResultsEmpty />
			)
		}

		return (
			<ListEmpty
				icon="people-outline"
				title={t("no_contacts")}
				description={t("no_contacts_description")}
				action={
					<Button
						onPress={() => void addContactFlow({ t })}
						requiresOnline
					>
						{t("add_contact")}
					</Button>
				}
			/>
		)
	}

	// When a search query becomes non-empty the visible list is filtered, so
	// any already-selected contacts may no longer appear in the list. Keeping
	// them selected produces a ghost count: the header shows "N selected" for
	// rows the user cannot see or deselect. Clear the selection (which also
	// exits bulk mode via clearSelectedContacts) whenever the user starts
	// typing a query.
	useEffect(() => {
		if (searchQuery.length > 0) {
			useContactsStore.getState().clearSelectedContacts()
		}
	}, [searchQuery])

	// Key the focus effect on a stable primitive, not the selectOptions object —
	// useSelectOptions deserializes a fresh object per render, and an object dep makes
	// useFocusEffect re-run (clearing the selection) on early param-churn re-renders.
	const inPickerMode = !!selectOptions

	useFocusEffect(
		useCallback(() => {
			// On focus, only keep selection if we're in bulkMode AND not in
			// picker mode. bulkMode is a user-driven state (Select menu item)
			// and surviving a re-focus keeps the selection alive while the
			// user works. Picker mode always starts fresh.
			if (inPickerMode || !useContactsStore.getState().bulkMode) {
				useContactsStore.getState().clearSelectedContacts()
			}

			return () => {
				useContactsStore.getState().clearSelectedContacts()
			}
		}, [inPickerMode])
	)

	return (
		<Fragment>
			<Header setSearchQuery={setSearchQuery} />
			<ScreenBody>
				<VirtualList
					className="flex-1 bg-background-secondary"
					contentContainerClassName={TAB_LIST_CONTENT_CLASS}
					keyExtractor={keyExtractor}
					data={items}
					renderItem={renderItem}
					loading={contactRequestsQuery.status === "pending" || contactsQuery.status === "pending"}
					requiresOnline={true}
					onRefresh={onRefresh}
					emptyComponent={emptyComponent}
				/>
			</ScreenBody>
		</Fragment>
	)
}

export default Contacts
