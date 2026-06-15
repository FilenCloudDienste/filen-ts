import { Platform } from "react-native"
import { useTranslation } from "react-i18next"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import { type MenuButton } from "@/components/ui/menu"
import { useResolveClassNames } from "uniwind"
import contacts from "@/features/contacts/contacts"
import { addContactFlow } from "@/features/contacts/contactsActions"
import useContactsStore, { type ContactListItem } from "@/features/contacts/store/useContacts.store"
import { runBulk } from "@/lib/bulkOps"
import { queryClient } from "@/queries/client"
import { router, useNavigation } from "expo-router"
import type { Contact as TContact } from "@filen/sdk-rs"
import events from "@/lib/events"
import { useShallow } from "zustand/shallow"
import { useSelectOptions } from "@/features/contacts/contactsSelect"

export const Header = ({ setSearchQuery }: { setSearchQuery: React.Dispatch<React.SetStateAction<string>> }) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const textBlue500 = useResolveClassNames("text-blue-500")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const selectOptions = useSelectOptions()
	const navigation = useNavigation()
	const selectedContacts = useContactsStore(
		useShallow(state => state.selectedContacts.filter(c => c.type === "contact").map(c => c.data as TContact))
	)
	const selectedAll = useContactsStore(useShallow(state => state.selectedContacts))
	const bulkMode = useContactsStore(useShallow(state => state.bulkMode))

	const inBulkMode = bulkMode && !selectOptions && selectedAll.length > 0

	const selectedByType = {
		contacts: selectedAll.filter((c): c is Extract<ContactListItem, { type: "contact" }> => c.type === "contact"),
		incoming: selectedAll.filter((c): c is Extract<ContactListItem, { type: "incomingRequest" }> => c.type === "incomingRequest"),
		outgoing: selectedAll.filter((c): c is Extract<ContactListItem, { type: "outgoingRequest" }> => c.type === "outgoingRequest"),
		blocked: selectedAll.filter((c): c is Extract<ContactListItem, { type: "blocked" }> => c.type === "blocked")
	}

	const headerRightItems = (() => {
		if (selectOptions && selectedContacts.length > 0) {
			return [
				{
					type: "button",
					icon: {
						name: "checkmark-outline",
						color: textBlue500.color,
						size: 20
					},
					props: {
						onPress: () => {
							events.emit("contactsSelect", {
								id: selectOptions.id,
								selectedContacts,
								cancelled: false
							})

							navigation.getParent()?.goBack()
						}
					}
				}
			] satisfies HeaderItem[]
		}

		const items: HeaderItem[] = []
		const menuButtons: MenuButton[] = []

		if (inBulkMode) {
			menuButtons.push({
				id: "selectAll",
				title: t("deselect_all"),
				icon: "select",
				onPress: () => {
					useContactsStore.getState().clearSelectedContacts()
				}
			})

			// Order: affirmative actions first (unblock / accept), then less-harsh
			// removals (remove from contacts), then most-harsh destructive (block,
			// deny request, cancel sent request).

			if (selectedByType.blocked.length > 0) {
				menuButtons.push({
					id: "bulkUnblock",
					title: t("bulk_unblock", { count: selectedByType.blocked.length }),
					icon: "restore",
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedByType.blocked,
							clearSelection: () => useContactsStore.getState().clearSelectedContacts(),
							confirm: {
								title: t("unblock"),
								message: t("unblock_selected_confirmation"),
								okText: t("unblock"),
								cancelText: t("cancel")
							},
							op: c => contacts.unblock({ uuid: c.data.uuid })
						})
					}
				})
			}

			if (selectedByType.incoming.length > 0) {
				menuButtons.push({
					id: "bulkAcceptIncoming",
					title: t("bulk_accept", { count: selectedByType.incoming.length }),
					icon: "checkmark",
					requiresOnline: true,
					onPress: async () => {
						const ok = await runBulk({
							items: selectedByType.incoming,
							clearSelection: () => useContactsStore.getState().clearSelectedContacts(),
							op: c => contacts.acceptRequest({ uuid: c.data.uuid })
						})

						// Single amortized invalidation instead of N refetches
						// triggered by per-call contactsQueryUpdate(). Accepted
						// requests promote to contacts, so both queries need a
						// fresh fetch.
						if (ok) {
							queryClient.invalidateQueries({ queryKey: ["contacts"] })
							queryClient.invalidateQueries({ queryKey: ["contactRequests"] })
						}
					}
				})
			}

			if (selectedByType.incoming.length > 0) {
				menuButtons.push({
					id: "bulkDenyIncoming",
					title: t("bulk_deny", { count: selectedByType.incoming.length }),
					icon: "delete",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedByType.incoming,
							clearSelection: () => useContactsStore.getState().clearSelectedContacts(),
							confirm: {
								title: t("deny"),
								message: t("deny_selected_requests_confirmation"),
								okText: t("deny"),
								cancelText: t("cancel"),
								destructive: true
							},
							op: c => contacts.denyRequest({ uuid: c.data.uuid })
						})
					}
				})
			}

			if (selectedByType.outgoing.length > 0) {
				menuButtons.push({
					id: "bulkCancelOutgoing",
					title: t("bulk_cancel_request", { count: selectedByType.outgoing.length }),
					icon: "cancel",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedByType.outgoing,
							clearSelection: () => useContactsStore.getState().clearSelectedContacts(),
							confirm: {
								title: t("cancel_request"),
								message: t("cancel_selected_outgoing_confirmation"),
								okText: t("cancel_request"),
								cancelText: t("cancel"),
								destructive: true
							},
							op: c => contacts.cancelRequest({ uuid: c.data.uuid })
						})
					}
				})
			}

			if (selectedByType.contacts.length > 0) {
				menuButtons.push({
					id: "bulkRemoveContacts",
					title: t("bulk_remove", { count: selectedByType.contacts.length }),
					icon: "delete",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedByType.contacts,
							clearSelection: () => useContactsStore.getState().clearSelectedContacts(),
							confirm: {
								title: t("remove"),
								message: t("remove_selected_contacts_confirmation"),
								okText: t("remove"),
								cancelText: t("cancel"),
								destructive: true
							},
							op: c => contacts.delete({ uuid: c.data.uuid })
						})
					}
				})

				menuButtons.push({
					id: "bulkBlockContacts",
					title: t("bulk_block", { count: selectedByType.contacts.length }),
					icon: "block",
					destructive: true,
					requiresOnline: true,
					onPress: async () => {
						await runBulk({
							items: selectedByType.contacts,
							clearSelection: () => useContactsStore.getState().clearSelectedContacts(),
							confirm: {
								title: t("block"),
								message: t("block_selected_contacts_confirmation"),
								okText: t("block"),
								cancelText: t("cancel"),
								destructive: true
							},
							op: c => {
								const contact = c.data as TContact

								return contacts.block({
									userId: contact.userId,
									email: contact.email,
									avatar: contact.avatar,
									nickName: contact.nickName,
									timestamp: contact.timestamp
								})
							}
						})
					}
				})
			}
		} else {
			menuButtons.push({
				id: "add",
				title: t("add_contact"),
				icon: "plus",
				requiresOnline: true,
				onPress: async () => {
					await addContactFlow({ t })
				}
			})
		}

		if (menuButtons.length > 0) {
			items.push({
				type: "menu",
				props: {
					type: "dropdown",
					hitSlop: 20,
					buttons: menuButtons
				},
				triggerProps: {
					hitSlop: 20
				},
				icon: {
					name: "ellipsis-horizontal",
					size: 24,
					color: textForeground.color
				}
			})
		}

		return items
	})()

	const headerLeftItems = (() => {
		if (inBulkMode) {
			return [
				{
					type: "button",
					icon: {
						name: "close-outline",
						color: textForeground.color,
						size: 20
					},
					props: {
						onPress: () => {
							useContactsStore.getState().clearSelectedContacts()
						}
					}
				}
			] satisfies HeaderItem[]
		}

		return [
			{
				type: "button",
				icon: {
					name: "close",
					color: textForeground.color,
					size: 20
				},
				props: {
					onPress: () => {
						if (!router.canGoBack()) {
							return
						}

						router.back()
					}
				}
			}
		] satisfies HeaderItem[]
	})()

	const title = inBulkMode ? t("selected", { count: selectedAll.length }) : t("contacts")

	return (
		<StackHeader
			transparent={Platform.OS === "ios"}
			title={title}
			leftItems={headerLeftItems}
			backgroundColor={Platform.select({
				ios: undefined,
				default: bgBackgroundSecondary.backgroundColor as string
			})}
			shadowVisible={false}
			rightItems={headerRightItems}
			searchBarOptions={{
				placement: "integratedButton",
				placeholder: t("search_contacts"),
				onChangeText: e => setSearchQuery(e.nativeEvent.text),
				onCancelButtonPress: () => setSearchQuery(""),
				onClose: () => setSearchQuery(""),
				onOpen: () => setSearchQuery(""),
				allowToolbarIntegration: false,
				headerIconColor: textForeground.color,
				textColor: textForeground.color,
				barTintColor: "transparent",
				tintColor: textForeground.color,
				hintTextColor: textMutedForeground.color,
				shouldShowHintSearchIcon: true,
				hideNavigationBar: false,
				hideWhenScrolling: false,
				inputType: "text"
			}}
		/>
	)
}

export default Header
