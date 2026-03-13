import { memo, useMemo, useCallback } from "@/lib/memo"
import useContactsQuery from "@/queries/useContacts.query"
import useContactRequestsQuery from "@/queries/useContactRequests.query"
import { fastLocaleCompare, run, cn } from "@filen/utils"
import { Fragment, useState } from "react"
import { Platform } from "react-native"
import SafeAreaView from "@/components/ui/safeAreaView"
import View from "@/components/ui/view"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
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
import useContactsStore, { type ContactListItemWithHeader } from "@/stores/useContacts.store"
import { router, useLocalSearchParams, useFocusEffect } from "expo-router"
import type { Contact as TContact } from "@filen/sdk-rs"
import { randomUUID } from "expo-crypto"
import events from "@/lib/events"
import { pack, unpack } from "@/lib/msgpack"
import { Buffer } from "react-native-quick-crypto"
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
				selectOptions: Buffer.from(
					pack({
						...options,
						id
					} satisfies SelectOptions)
				).toString("base64")
			}
		})
	})
}

function useSelectOptions() {
	const searchParams = useLocalSearchParams<{
		selectOptions?: string
	}>()

	const selectOptions = useMemo((): SelectOptions | null => {
		if (searchParams && searchParams.selectOptions) {
			try {
				const parsed = unpack(Buffer.from(searchParams.selectOptions, "base64")) as SelectOptions

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
	}, [searchParams])

	return selectOptions
}

const Header = memo(() => {
	const textForeground = useResolveClassNames("text-foreground")
	const textBlue500 = useResolveClassNames("text-blue-500")
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const selectOptions = useSelectOptions()
	const selectedContacts = useContactsStore(
		useShallow(state => state.selectedContacts.filter(c => c.type === "contact").map(c => c.data as TContact))
	)

	const headerRightItems = useMemo(() => {
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

							if (router.canGoBack()) {
								router.back()
							}
						}
					}
				}
			] satisfies HeaderItem[]
		}

		const items: HeaderItem[] = []
		const menuButtons: MenuButton[] = []

		menuButtons.push({
			id: "add",
			title: "tbd_add_contact",
			icon: "plus",
			onPress: async () => {
				const promptResult = await run(async () => {
					return await prompts.input({
						title: "tbd_add_contact",
						message: "tbd_enter_contact_filen_email",
						cancelText: "tbd_cancel",
						okText: "tbd_add"
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
	}, [textBlue500.color, selectedContacts, selectOptions, textForeground.color])

	const headerLeftItems = useMemo(() => {
		return [
			{
				type: "button",
				icon: {
					name: "chevron-back-outline",
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
	}, [textForeground.color])

	return (
		<StackHeader
			transparent={Platform.OS === "ios"}
			title="tbd_contacts"
			leftItems={headerLeftItems}
			backgroundColor={Platform.select({
				ios: undefined,
				default: bgBackgroundSecondary.backgroundColor as string
			})}
			rightItems={headerRightItems}
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
		const selectOptions = useSelectOptions()
		const isSelected = useContactsStore(
			useShallow(state => state.selectedContacts.some(c => c.type === info.item.type && c.data.uuid === info.item.data.uuid))
		)
		const selectedCount = useContactsStore(useShallow(state => state.selectedContacts.length))

		const roundedCn = useMemo(() => {
			return cn(
				nextItem?.type !== "header" && prevItem?.type !== "header" && "rounded-none",
				nextItem?.type === "header" && prevItem?.type !== "header" && "rounded-b-4xl rounded-t-none",
				nextItem?.type !== "header" && prevItem?.type === "header" && "rounded-t-4xl rounded-b-none",
				nextItem?.type === "header" && prevItem?.type === "header" && "rounded-4xl",
				!nextItem && prevItem?.type === "header" && "rounded-4xl",
				!prevItem && nextItem?.type !== "header" && "rounded-t-4xl rounded-b-none",
				!nextItem && prevItem?.type !== "header" && "rounded-b-4xl rounded-t-none",
				!nextItem && !prevItem && "rounded-4xl"
			)
		}, [nextItem, prevItem])

		const onAccept = useCallback(async () => {
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
		}, [info.item])

		const onDeny = useCallback(async () => {
			const promptResponse = await run(async () => {
				switch (info.item.type) {
					case "incomingRequest": {
						return await prompts.alert({
							title: "tbd_deny_request_contact",
							message: "tbd_deny_request_contact_confirmation",
							cancelText: "tbd_cancel",
							okText: "tbd_deny_request"
						})
					}

					case "outgoingRequest": {
						return await prompts.alert({
							title: "tbd_cancel_request_contact",
							message: "tbd_cancel_request_contact_confirmation",
							cancelText: "tbd_cancel",
							okText: "tbd_cancel_request"
						})
					}

					case "blocked": {
						return await prompts.alert({
							title: "tbd_unblock_contact",
							message: "tbd_unblock_contact_confirmation",
							cancelText: "tbd_cancel",
							okText: "tbd_unblock"
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
		}, [info.item])

		const menuButtons = useMemo(() => {
			const buttons: MenuButton[] = []

			if (info.item.type === "contact") {
				buttons.push({
					id: "block",
					title: "tbd_block",
					destructive: true,
					icon: "delete",
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: "tbd_block_contact",
								message: "tbd_block_contact_confirmation",
								cancelText: "tbd_cancel",
								okText: "tbd_block"
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

				buttons.push({
					id: "remove",
					title: "tbd_remove",
					destructive: true,
					icon: "delete",
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: "tbd_remove_contact",
								message: "tbd_remove_contact_confirmation",
								cancelText: "tbd_cancel",
								okText: "tbd_remove"
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
			}

			if (info.item.type === "blocked") {
				buttons.push({
					id: "unblock",
					title: "tbd_unblock",
					destructive: true,
					icon: "delete",
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: "tbd_unblock_contact",
								message: "tbd_unblock_contact_confirmation",
								cancelText: "tbd_cancel",
								okText: "tbd_unblock"
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
					title: "tbd_accept",
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
					title: "tbd_deny",
					destructive: true,
					icon: "delete",
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: "tbd_deny_contact",
								message: "tbd_deny_contact_confirmation",
								cancelText: "tbd_cancel",
								okText: "tbd_deny"
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
					title: "tbd_cancel",
					destructive: true,
					icon: "delete",
					onPress: async () => {
						const promptResponse = await run(async () => {
							return await prompts.alert({
								title: "tbd_cancel_contact",
								message: "tbd_cancel_contact_confirmation",
								cancelText: "tbd_cancel",
								okText: "tbd_cancel"
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
		}, [info.item])

		const disabled = useMemo(() => {
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
		}, [selectOptions, info.item, selectedCount, isSelected])

		const onPress = useCallback(() => {
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
		}, [info.item, disabled])

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
							className={cn("bg-background-tertiary px-4 flex-row items-center", roundedCn)}
							onPress={onPress}
						>
							<View
								className={cn(
									"bg-transparent flex-row items-center gap-3 py-3",
									nextItem && nextItem.type !== "header" && "border-b border-border"
								)}
							>
								{selectOptions && (
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
	const contactsQuery = useContactsQuery()
	const contactRequestsQuery = useContactRequestsQuery()
	const [searchQuery, setSearchQuery] = useState<string>("")
	const selectOptions = useSelectOptions()

	const itemsSorted = useMemo(() => {
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
								title: "tbd_contacts_requests"
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
								title: "tbd_contacts_pending"
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
								title: "tbd_contact_contacts"
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
								title: "tbd_contact_blocked"
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
	}, [contactsQuery.status, contactsQuery.data, contactRequestsQuery.status, contactRequestsQuery.data, selectOptions])

	const items = useMemo(() => {
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
	}, [searchQuery, itemsSorted])

	const keyExtractor = useCallback((item: ContactListItemWithHeader) => {
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
	}, [])

	const renderItem = useCallback(
		(info: ListRenderItemInfo<ContactListItemWithHeader>) => {
			return (
				<Contact
					info={info}
					nextItem={items.at(info.index + 1)}
					prevItem={items.at(info.index - 1)}
				/>
			)
		},
		[items]
	)

	const onRefresh = useCallback(async () => {
		const result = await run(async () => {
			await Promise.all([contactsQuery.refetch(), contactRequestsQuery.refetch()])
		})

		if (!result.success) {
			console.error(result.error)
			alerts.error(result.error)
		}
	}, [contactsQuery, contactRequestsQuery])

	useFocusEffect(
		useCallback(() => {
			useContactsStore.getState().setSelectedContacts([])

			return () => {
				useContactsStore.getState().setSelectedContacts([])
			}
		}, [])
	)

	return (
		<Fragment>
			<Header />
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
					emptyComponent={() => {
						return (
							<View className="flex-1 items-center justify-center bg-transparent">
								<Text>tbd</Text>
							</View>
						)
					}}
					searchBar={{
						onChangeText: setSearchQuery,
						placeholder: "tbd_search_contacts"
					}}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default Contacts
