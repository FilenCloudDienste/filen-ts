import { useTranslation } from "react-i18next"
import { type ListRenderItemInfo } from "@/components/ui/virtualList"
import View from "@/components/ui/view"
import Menu, { type MenuButton } from "@/components/ui/menu"
import alerts from "@/lib/alerts"
import Text from "@/components/ui/text"
import { contactDisplayName } from "@/lib/utils"
import Avatar from "@/components/ui/avatar"
import Ionicons from "@expo/vector-icons/Ionicons"
import { PressableScale } from "@/components/ui/pressables"
import contacts from "@/features/contacts/contacts"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import useContactsStore, { type ContactListItemWithHeader } from "@/features/contacts/store/useContacts.store"
import { Checkbox } from "@/components/ui/checkbox"
import { AnimatedView } from "@/components/ui/animated"
import { FadeIn, FadeOut } from "react-native-reanimated"
import { useShallow } from "zustand/shallow"
import { run, cn } from "@filen/utils"
import { useSelectOptions } from "@/features/contacts/contactsSelect"

export const Contact = ({
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

export default Contact
