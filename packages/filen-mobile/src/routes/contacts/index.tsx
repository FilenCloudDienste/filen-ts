import useContactsQuery from "@/queries/useContacts.query"
import useContactRequestsQuery from "@/queries/useContactRequests.query"
import { onlineManager } from "@tanstack/react-query"
import { fastLocaleCompare, run, cn } from "@filen/utils"
import { Fragment, useState, memo, useCallback } from "react"
import { Platform } from "react-native"
import { useTranslation } from "react-i18next"
import SafeAreaView from "@/components/ui/safeAreaView"
import View from "@/components/ui/view"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import ListEmpty from "@/components/ui/listEmpty"
import StackHeader, { type HeaderItem } from "@/components/ui/header"
import Menu, { type MenuButton } from "@/components/ui/menu"
import { useResolveClassNames } from "uniwind"
import alerts from "@/lib/alerts"
import Text from "@/components/ui/text"
import { contactDisplayName } from "@/lib/utils"
import Avatar from "@/components/ui/avatar"
import Ionicons from "@expo/vector-icons/Ionicons"
import { PressableScale } from "@/components/ui/pressables"
import contacts from "@/lib/contacts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import useContactsStore, { type ContactListItem, type ContactListItemWithHeader } from "@/stores/useContacts.store"
import { runBulk } from "@/lib/bulkOps"
import { queryClient } from "@/queries/client"
import { router, useLocalSearchParams, useFocusEffect, useNavigation } from "expo-router"
import type { Contact as TContact } from "@filen/sdk-rs"
import { randomUUID } from "expo-crypto"
import events from "@/lib/events"
import { serialize, deserialize } from "@/lib/serializer"
import { Checkbox } from "@/components/ui/checkbox"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { useShallow } from "zustand/shallow"

export type SelectOptions = {
	id: string
	multiple: boolean
	userIdsToExclude: number[]
}

export async function selectContacts(options: Omit<SelectOptions, "id">): Promise<
	| {
			cancelled: true
	  }
	| {
			cancelled: false
			selectedContacts: TContact[]
	  }
> {
	return new Promise(resolve => {
		const id = randomUUID()

		// Ensure clean state when entering picker mode. If the user had bulk
		// mode active before (long-press → Select on the standalone contacts
		// screen), the picker would otherwise render checkboxes on the first
		// paint with stale bulk state. clearSelectedContacts() resets BOTH
		// selectedContacts and bulkMode.
		useContactsStore.getState().clearSelectedContacts()

		const sub = events.subscribe("contactsSelect", data => {
			if (data.id === id) {
				sub.remove()

				if (data.cancelled || data.selectedContacts.length === 0) {
					resolve({
						cancelled: true
					})

					return
				}

				resolve({
					cancelled: false,
					selectedContacts: data.selectedContacts
				})
			}
		})

		router.push({
			pathname: "/contacts",
			params: {
				selectOptions: serialize({
					...options,
					id
				} satisfies SelectOptions)
			}
		})
	})
}

function useSelectOptions() {
	const searchParams = useLocalSearchParams<{
		selectOptions?: string
	}>()

	const selectOptions = ((): SelectOptions | null => {
		if (searchParams && searchParams.selectOptions) {
			try {
				const parsed = deserialize(searchParams.selectOptions) as SelectOptions

				return {
					multiple: parsed.multiple,
					id: parsed.id,
					userIdsToExclude: parsed.userIdsToExclude
				}
			} catch {
				return null
			}
		}

		return null
	})()

	return selectOptions
}

const Header = memo(({ setSearchQuery }: { setSearchQuery: React.Dispatch<React.SetStateAction<string>> }) => {
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
					icon: "select",
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
					icon: "delete",
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
							op: c => contacts.block({ email: (c.data as TContact).email })
						})
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
		} else {
			menuButtons.push({
				id: "add",
				title: t("add_contact"),
				icon: "plus",
				requiresOnline: true,
				onPress: async () => {
					const promptResult = await run(async () => {
						return await prompts.input({
							title: t("add_contact"),
							message: t("enter_contact_filen_email"),
							cancelText: t("cancel"),
							okText: t("add")
						})
					})

					if (!promptResult.success) {
						console.error(promptResult.error)
						alerts.error(promptResult.error)

						return
					}

					if (promptResult.data.cancelled || promptResult.data.type !== "string") {
						return
					}

					const email = promptResult.data.value.trim()

					if (email.length === 0) {
						return
					}

					const result = await runWithLoading(async () => {
						await contacts.sendRequest({
							email
						})
					})

					if (!result.success) {
						console.error(result.error)
						alerts.error(result.error)

						return
					}
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
})

const Contact = memo(
	({
		info,
		nextItem,
		prevItem
	}: {
		info: ListRenderItemInfo<ContactListItemWithHeader>
		nextItem?: ContactListItemWithHeader
		prevItem?: ContactListItemWithHeader
	}) => {
		const { t } = useTranslation()
		const selectOptions = useSelectOptions()
		const isSelected = useContactsStore(
			useShallow(state => state.selectedContacts.some(c => c.type === info.item.type && c.data.uuid === info.item.data.uuid))
		)
		const selectedCount = useContactsStore(useShallow(state => state.selectedContacts.length))
		const bulkMode = useContactsStore(useShallow(state => state.bulkMode))
		const showCheckbox = !!selectOptions || bulkMode

		const onAccept = async () => {
			const result = await runWithLoading(async () => {
				if (info.item.type !== "incomingRequest") {
					throw new Error("Invalid contact request type")
				}

				await contacts.acceptRequest({
					uuid: info.item.data.uuid
				})
			})

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				return
			}
		}

		const onDeny = async () => {
			const promptResponse = await run(async () => {
				switch (info.item.type) {
					case "incomingRequest": {
						return await prompts.alert({
							title: t("deny_request_contact"),
							message: t("deny_request_contact_confirmation"),
							cancelText: t("cancel"),
							okText: t("deny_request"),
							destructive: true
						})
					}

					case "outgoingRequest": {
						return await prompts.alert({
							title: t("cancel_request_contact"),
							message: t("cancel_request_contact_confirmation"),
							cancelText: t("cancel"),
							okText: t("cancel_request"),
							destructive: true
						})
					}

					case "blocked": {
						return await prompts.alert({
							title: t("unblock_contact"),
							message: t("unblock_contact_confirmation"),
							cancelText: t("cancel"),
							okText: t("unblock")
						})
					}

					default: {
						return {
							cancelled: false
						}
					}
				}
			})

			if (!promptResponse.success) {
				console.error(promptResponse.error)
				alerts.error(promptResponse.error)

				return
			}

			if (promptResponse.data.cancelled) {
				return
			}

			const result = await runWithLoading(async () => {
				switch (info.item.type) {
					case "incomingRequest": {
						await contacts.denyRequest({
							uuid: info.item.data.uuid
						})

						break
					}

					case "outgoingRequest": {
						await contacts.cancelRequest({
							uuid: info.item.data.uuid
						})

						break
					}

					case "blocked": {
						await contacts.unblock({
							uuid: info.item.data.uuid
						})

						break
					}

					default: {
						throw new Error("Invalid contact request type")
					}
				}
			})

			if (!result.success) {
				console.error(result.error)
				alerts.error(result.error)

				return
			}
		}

		const menuButtons = (() => {
			const buttons: MenuButton[] = []

			if (!selectOptions && info.item.type !== "header") {
				const target = info.item
				buttons.push({
					id: isSelected ? "deselect" : "select",
					title: isSelected ? t("deselect") : t("select"),
					icon: "select",
					checked: isSelected,
					onPress: () => {
						useContactsStore.getState().setBulkMode(true)
						useContactsStore.getState().toggleSelectedContact(target)
					}
				})
			}

			if (info.item.type === "contact") {
				// Remove first (less harsh: drops them from your contact list).
				// Block last (most harsh: also prevents them from contacting you).
				buttons.push({
					id: "remove",
					requiresOnline: true,
					title: t("remove"),
					destructive: true,
					icon: "delete",
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: t("remove_contact"),
								message: t("remove_contact_confirmation"),
								cancelText: t("cancel"),
								okText: t("remove"),
								destructive: true
							})
						})

						if (!promptResponse.success) {
							console.error(promptResponse.error)
							alerts.error(promptResponse.error)

							return
						}

						if (promptResponse.data.cancelled) {
							return
						}

						const result = await runWithLoading(async () => {
							if (info.item.type !== "contact") {
								throw new Error("Invalid contact type")
							}

							await contacts.delete({
								uuid: info.item.data.uuid
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})

				buttons.push({
					id: "block",
					requiresOnline: true,
					title: t("block"),
					destructive: true,
					icon: "delete",
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: t("block_contact"),
								message: t("block_contact_confirmation"),
								cancelText: t("cancel"),
								okText: t("block"),
								destructive: true
							})
						})

						if (!promptResponse.success) {
							console.error(promptResponse.error)
							alerts.error(promptResponse.error)

							return
						}

						if (promptResponse.data.cancelled) {
							return
						}

						const result = await runWithLoading(async () => {
							if (info.item.type !== "contact") {
								throw new Error("Invalid contact type")
							}

							await contacts.block({
								email: info.item.data.email
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})
			}

			if (info.item.type === "blocked") {
				// Unblock is constructive (lifts a restriction), not destructive.
				buttons.push({
					id: "unblock",
					requiresOnline: true,
					title: t("unblock"),
					icon: "select",
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: t("unblock_contact"),
								message: t("unblock_contact_confirmation"),
								cancelText: t("cancel"),
								okText: t("unblock")
							})
						})

						if (!promptResponse.success) {
							console.error(promptResponse.error)
							alerts.error(promptResponse.error)

							return
						}

						if (promptResponse.data.cancelled) {
							return
						}

						const result = await runWithLoading(async () => {
							if (info.item.type !== "blocked") {
								throw new Error("Invalid contact type")
							}

							await contacts.unblock({
								uuid: info.item.data.uuid
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})
			}

			if (info.item.type === "incomingRequest") {
				buttons.push({
					id: "accept",
					requiresOnline: true,
					title: t("accept"),
					icon: "checkmark",
					onPress: async () => {
						const result = await runWithLoading(async () => {
							if (info.item.type !== "incomingRequest") {
								throw new Error("Invalid contact type")
							}

							await contacts.acceptRequest({
								uuid: info.item.data.uuid
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})

				buttons.push({
					id: "deny",
				requiresOnline: true,
					title: t("deny"),
					destructive: true,
					icon: "delete",
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: t("deny_contact"),
								message: t("deny_contact_confirmation"),
								cancelText: t("cancel"),
								okText: t("deny"),
								destructive: true
							})
						})

						if (!promptResponse.success) {
							console.error(promptResponse.error)
							alerts.error(promptResponse.error)

							return
						}

						if (promptResponse.data.cancelled) {
							return
						}

						const result = await runWithLoading(async () => {
							if (info.item.type !== "incomingRequest") {
								throw new Error("Invalid contact type")
							}

							await contacts.denyRequest({
								uuid: info.item.data.uuid
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})
			}

			if (info.item.type === "outgoingRequest") {
				buttons.push({
					id: "cancel",
					requiresOnline: true,
					title: t("cancel"),
					destructive: true,
					icon: "cancel",
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: t("cancel_contact"),
								message: t("cancel_contact_confirmation"),
								cancelText: t("cancel"),
								okText: t("cancel"),
								destructive: true
							})
						})

						if (!promptResponse.success) {
							console.error(promptResponse.error)
							alerts.error(promptResponse.error)

							return
						}

						if (promptResponse.data.cancelled) {
							return
						}

						const result = await runWithLoading(async () => {
							if (info.item.type !== "outgoingRequest") {
								throw new Error("Invalid contact type")
							}

							await contacts.cancelRequest({
								uuid: info.item.data.uuid
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)

							return
						}
					}
				})
			}

			return buttons
		})()

		const disabled = (() => {
			if (!selectOptions) {
				return false
			}

			const item = info.item

			if (item.type !== "contact") {
				return false
			}

			if (selectOptions.userIdsToExclude.some(c => c === Number(item.data.userId))) {
				return true
			}

			return selectOptions.multiple ? false : selectedCount >= 1 && !isSelected
		})()

		const onPress = () => {
			if (disabled) {
				return
			}

			const item = info.item

			if (item.type === "header") {
				return
			}

			useContactsStore.getState().setSelectedContacts(prev => {
				const prevSelected = prev.some(i => i.data.uuid === item.data.uuid && i.type === item.type)

				if (prevSelected) {
					return prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type))
				}

				return [...prev.filter(i => !(i.data.uuid === item.data.uuid && i.type === item.type)), item]
			})
		}

		return (
			<View
				className={cn(
					"w-full h-auto px-4 bg-transparent",
					info.item.type === "header" ? "py-2 pt-4" : "pb-0",
					disabled && "opacity-50"
				)}
			>
				{info.item.type === "header" ? (
					<Text className="text-lg">{info.item.data.title}</Text>
				) : (
					<Menu
						className="flex-row w-full h-auto"
						type="context"
						isAnchoredToRight={true}
						buttons={menuButtons}
					>
						<PressableScale
							className={cn(
								"bg-background-tertiary px-4 flex-row items-center",
								// Sectioned list (incoming / outgoing / contacts / blocked) — the
								// row's rounded corners follow its position within its section.
								// "First" / "last" means the neighbor is a section header or the
								// list edge. Solo rows (first AND last) get all corners.
								(!prevItem || prevItem.type === "header") && "rounded-t-4xl",
								(!nextItem || nextItem.type === "header") && "rounded-b-4xl"
							)}
							onPress={onPress}
						>
							<View
								className={cn(
									"bg-transparent flex-row items-center gap-3 py-3",
									nextItem && nextItem.type !== "header" && "border-b border-border"
								)}
							>
								{showCheckbox && (
									<AnimatedView
										className="flex-row h-full items-center justify-center bg-transparent shrink-0"
										entering={FadeIn}
										exiting={FadeOut}
									>
										<Checkbox
											value={isSelected}
											onValueChange={onPress}
											hitSlop={16}
										/>
									</AnimatedView>
								)}
								<View className="flex-row items-center justify-center bg-transparent">
									<Avatar
										source={info.item.data.avatar}
										size={38}
										className="bg-background-secondary"
										lastActive={info.item.type === "contact" ? Number(info.item.data.lastActive) : undefined}
									/>
								</View>
								<View className="flex-row items-center gap-4 bg-transparent flex-1 justify-between">
									<View className="flex-col justify-center bg-transparent flex-1">
										<Text
											numberOfLines={1}
											ellipsizeMode="middle"
										>
											{contactDisplayName(info.item.data)}
										</Text>
										<Text
											className="text-xs text-muted-foreground"
											numberOfLines={1}
											ellipsizeMode="middle"
										>
											{info.item.data.email}
										</Text>
									</View>
									<View className="flex-row items-center justify-center bg-transparent gap-4">
										{info.item.type === "incomingRequest" && (
											<PressableScale
												className="bg-green-500 size-8 rounded-full flex-row items-center justify-center"
												rippleColor="transparent"
												onPress={onAccept}
												hitSlop={10}
											>
												<Ionicons
													name="checkmark-outline"
													size={20}
													color="white"
												/>
											</PressableScale>
										)}
										{(info.item.type === "outgoingRequest" || info.item.type === "incomingRequest") && (
											<PressableScale
												className="bg-red-500 size-8 rounded-full flex-row items-center justify-center"
												rippleColor="transparent"
												onPress={onDeny}
												hitSlop={10}
											>
												<Ionicons
													name="close-outline"
													size={20}
													color="white"
												/>
											</PressableScale>
										)}
									</View>
								</View>
							</View>
						</PressableScale>
					</Menu>
				)}
			</View>
		)
	}
)

const Contacts = memo(() => {
	const { t } = useTranslation()
	const contactsQuery = useContactsQuery()
	const contactRequestsQuery = useContactRequestsQuery()
	const [searchQuery, setSearchQuery] = useState<string>("")
	const selectOptions = useSelectOptions()

	const itemsSorted = (() => {
		if (contactsQuery.status !== "success" || contactRequestsQuery.status !== "success") {
			return []
		}

		let items = [
			...(contactRequestsQuery.data.incoming.length > 0
				? [
						{
							type: "header",
							data: {
								id: "requests",
								title: t("contacts_requests")
							}
						} satisfies ContactListItemWithHeader
					]
				: []),
			...contactRequestsQuery.data.incoming
				.map(request => ({
					type: "incomingRequest" as const,
					data: request
				}))
				.sort((a, b) => fastLocaleCompare(a.data.email, b.data.email)),
			...(contactRequestsQuery.data.outgoing.length > 0
				? [
						{
							type: "header",
							data: {
								id: "pending",
								title: t("contacts_pending")
							}
						} satisfies ContactListItemWithHeader
					]
				: []),
			...contactRequestsQuery.data.outgoing
				.map(request => ({
					type: "outgoingRequest" as const,
					data: request
				}))
				.sort((a, b) => fastLocaleCompare(a.data.email, b.data.email)),
			...(contactsQuery.data.contacts.length > 0
				? [
						{
							type: "header",
							data: {
								id: "contacts",
								title: t("contact_contacts")
							}
						} satisfies ContactListItemWithHeader
					]
				: []),
			...contactsQuery.data.contacts
				.map(contact => ({
					type: "contact" as const,
					data: contact
				}))
				.sort((a, b) => fastLocaleCompare(a.data.email, b.data.email)),
			...(contactsQuery.data.blocked.length > 0
				? [
						{
							type: "header",
							data: {
								id: "blocked",
								title: t("contact_blocked")
							}
						} satisfies ContactListItemWithHeader
					]
				: []),
			...contactsQuery.data.blocked
				.map(blocked => ({
					type: "blocked" as const,
					data: blocked
				}))
				.sort((a, b) => fastLocaleCompare(a.data.email, b.data.email))
		] satisfies ContactListItemWithHeader[]

		if (selectOptions) {
			items = items.filter(item => item.type === "contact" || (item.type === "header" && item.data.id === "contacts"))
		}

		return items
	})()

	const items = (() => {
		const searchQueryNormalized = searchQuery.trim().toLowerCase()

		if (searchQueryNormalized.length === 0) {
			return itemsSorted
		}

		return itemsSorted.filter(item => {
			if (item.type === "header") {
				return false
			}

			const email = item.data.email.toLowerCase().trim()
			const displayName = contactDisplayName(item.data).toLowerCase().trim()

			return email.includes(searchQueryNormalized) || displayName.includes(searchQueryNormalized)
		})
	})()

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
		return (
			<Contact
				info={info}
				nextItem={items.at(info.index + 1)}
				prevItem={items.at(info.index - 1)}
			/>
		)
	}

	const onRefresh = async () => {
		if (!onlineManager.isOnline()) {
			return
		}

		const result = await run(async () => {
			await Promise.all([contactsQuery.refetch(), contactRequestsQuery.refetch()])
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}

	const emptyComponent = () => (
		<ListEmpty
			icon="people-outline"
			title={t("no_contacts")}
		/>
	)

	useFocusEffect(
		useCallback(() => {
			// On focus, only keep selection if we're in bulkMode AND not in
			// picker mode. bulkMode is a user-driven state (Select menu item)
			// and surviving a re-focus keeps the selection alive while the
			// user works. Picker mode always starts fresh.
			if (selectOptions || !useContactsStore.getState().bulkMode) {
				useContactsStore.getState().clearSelectedContacts()
			}

			return () => {
				useContactsStore.getState().clearSelectedContacts()
			}
		}, [selectOptions])
	)

	return (
		<Fragment>
			<Header setSearchQuery={setSearchQuery} />
			<SafeAreaView
				edges={["left", "right"]}
				className="bg-background-secondary"
			>
				<VirtualList
					className="flex-1 bg-background-secondary"
					contentInsetAdjustmentBehavior="automatic"
					contentContainerClassName={cn("pb-40", Platform.OS === "android" && "pb-96")}
					keyExtractor={keyExtractor}
					data={items}
					renderItem={renderItem}
					loading={contactRequestsQuery.status !== "success" || contactsQuery.status !== "success"}
					onRefresh={onRefresh}
					emptyComponent={emptyComponent}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default Contacts
