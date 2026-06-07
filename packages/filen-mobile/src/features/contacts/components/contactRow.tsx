import { useTranslation } from "react-i18next"
import { type ListRenderItemInfo } from "@/components/ui/virtualList"
import View, { CrossGlassContainerView } from "@/components/ui/view"
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
import { useResolveClassNames } from "uniwind"

export const ContactSectionHeader = ({ title }: { title: string }) => {
	return (
		<View className={cn("w-full h-auto px-4 bg-transparent", "py-2 pt-4")}>
			<Text className="text-lg">{title}</Text>
		</View>
	)
}

export const Contact = ({
	info,
	nextItem
}: {
	info: ListRenderItemInfo<ContactListItemWithHeader>
	nextItem?: ContactListItemWithHeader
}) => {
	const { t } = useTranslation()
	const selectOptions = useSelectOptions()
	const textForeground = useResolveClassNames("text-foreground")
	const { isSelected, selectedCount, bulkMode } = useContactsStore(
		useShallow(state => ({
			isSelected: state.selectedContacts.some(c => c.type === info.item.type && c.data.uuid === info.item.data.uuid),
			selectedCount: state.selectedContacts.length,
			bulkMode: state.bulkMode
		}))
	)
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

				default: {
					// Blocked contacts are unblocked exclusively via the context-menu "unblock" button.
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
		// Tapping a row only selects while in selection mode (picker or bulk) — mirrors the
		// participant row, and avoids a stray selection-tint on an otherwise inert tap.
		if (disabled || !showCheckbox) {
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

	// Flat row style matching the shared participant row: transparent rows on the screen's
	// secondary background, inset bottom-border separators between rows of the same section,
	// and a selection tint on the whole row while multi-selecting.
	return info.item.type === "header" ? (
		<ContactSectionHeader title={info.item.data.title} />
	) : (
		<View
			className={cn(
				"flex-row items-center px-4 bg-transparent",
				isSelected && "bg-background-tertiary",
				disabled && "opacity-50"
			)}
		>
			<View
				className={cn(
					"flex-row items-center gap-4 py-2 bg-transparent flex-1",
					// Separator between consecutive rows in a section; the last row before a section
					// header (or the list edge) gets none, so sections read as visually grouped.
					nextItem && nextItem.type !== "header" && "border-b border-border"
				)}
			>
				{showCheckbox && (
					<AnimatedView
						className="flex-row h-full items-center justify-center bg-transparent pr-1 shrink-0"
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
				<PressableScale
					className="flex-row bg-transparent flex-1"
					onPress={onPress}
				>
					<View className="flex-row bg-transparent flex-1 gap-3 items-center">
						<Avatar
							className="shrink-0"
							source={info.item.data.avatar}
							size={32}
							lastActive={info.item.type === "contact" ? Number(info.item.data.lastActive) : undefined}
						/>
						<View className="flex-col bg-transparent gap-0.5 flex-1">
							<Text
								className="text-foreground"
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{contactDisplayName(info.item.data)}
							</Text>
							<Text
								className="text-muted-foreground text-xs"
								numberOfLines={1}
								ellipsizeMode="middle"
							>
								{info.item.data.email}
							</Text>
						</View>
					</View>
				</PressableScale>
				<View className="flex-row items-center gap-3 bg-transparent">
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
					{menuButtons.length > 0 && (
						<Menu
							type="dropdown"
							isAnchoredToRight={true}
							buttons={menuButtons}
						>
							<CrossGlassContainerView>
								<PressableScale className="size-9 items-center justify-center">
									<Ionicons
										name="ellipsis-horizontal"
										size={20}
										color={textForeground.color}
									/>
								</PressableScale>
							</CrossGlassContainerView>
						</Menu>
					)}
				</View>
			</View>
		</View>
	)
}

export default Contact
