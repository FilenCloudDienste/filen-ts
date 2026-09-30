import { useRef } from "react"
import { useTranslation } from "react-i18next"
import { type ListRenderItemInfo } from "@/components/ui/virtualList"
import View from "@/components/ui/view"
import Menu, { type MenuButton } from "@/components/ui/menu"
import alerts from "@/lib/alerts"
import Avatar from "@/components/ui/avatar"
import Ionicons from "@expo/vector-icons/Ionicons"
import { PressableScale } from "@/components/ui/pressables"
import contacts from "@/features/contacts/contacts"
import chatsLib from "@/features/chats/chats"
import { router } from "@/lib/router"
import { runWithLoading } from "@/components/ui/fullScreenLoadingModal"
import prompts from "@/lib/prompts"
import { confirmedAction } from "@/lib/confirmedAction"
import { buildBlockToggleMenuAction } from "@/features/contacts/contactsActions"
import useContactsStore, { type ContactListItemWithHeader } from "@/features/contacts/store/useContacts.store"
import { useShallow } from "zustand/shallow"
import { run, contactDisplayName } from "@filen/shared"
import { useSelectOptions } from "@/features/contacts/contactsSelect"
import ListRow, { ListRowSectionHeader } from "@/components/ui/listRow"
import EllipsisMenuTrigger from "@/components/ui/ellipsisMenuTrigger"
import useIsOnline from "@/hooks/useIsOnline"
import logger from "@/lib/logger"

export const Contact = ({
	info,
	nextItem
}: {
	info: ListRenderItemInfo<ContactListItemWithHeader>
	nextItem?: ContactListItemWithHeader
}) => {
	const { t } = useTranslation()
	const selectOptions = useSelectOptions()
	const isOnline = useIsOnline()
	const inFlightRef = useRef(false)
	const { isSelected, bulkMode } = useContactsStore(
		useShallow(state => ({
			isSelected: state.selectedContacts.some(c => c.type === info.item.type && c.data.uuid === info.item.data.uuid),
			bulkMode: state.bulkMode
		}))
	)
	const showCheckbox = !!selectOptions || bulkMode

	const onAccept = async () => {
		if (inFlightRef.current) {
			return
		}

		inFlightRef.current = true

		const result = await runWithLoading(async () => {
			if (info.item.type !== "incomingRequest") {
				throw new Error("Invalid contact request type")
			}

			await contacts.acceptRequest({
				uuid: info.item.data.uuid
			})
		})

		inFlightRef.current = false

		if (!result.success) {
			logger.error("contacts", "acceptRequest failed", { error: result.error })
			alerts.error(result.error)

			return
		}
	}

	const onDeny = async () => {
		if (inFlightRef.current) {
			return
		}

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
			logger.warn("contacts", "deny/cancel request prompt failed", { error: promptResponse.error })
			alerts.error(promptResponse.error)

			return
		}

		if (promptResponse.data.cancelled) {
			return
		}

		inFlightRef.current = true

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

		inFlightRef.current = false

		if (!result.success) {
			logger.error("contacts", "deny/cancel request failed", { error: result.error })
			alerts.error(result.error)

			return
		}
	}

	const baseMenuButtons = (() => {
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

		// Picker mode (selectOptions) is selection-only — the same guard the select button
		// carries. Without it the ellipsis exposed Message (navigates away, cancelling the
		// pick) and the destructive Remove/Block mid-pick.
		if (!selectOptions && info.item.type === "contact") {
			const contactItem = info.item

			buttons.push({
				id: "message",
				requiresOnline: true,
				title: t("message"),
				icon: "reply",
				onPress: async () => {
					const result = await runWithLoading(async () => {
						return await chatsLib.create({
							contacts: [contactItem.data]
						})
					})

					if (!result.success) {
						logger.error("contacts", "create chat failed", { error: result.error })
						alerts.error(result.error)

						return
					}

					router.push(`/chat/${result.data.uuid}`)
				}
			})

			// Remove first (less harsh: drops them from your contact list).
			// Block last (most harsh: also prevents them from contacting you).
			buttons.push({
				id: "remove",
				requiresOnline: true,
				title: t("remove"),
				destructive: true,
				icon: "delete",
				onPress: confirmedAction({
					promptTitle: t("remove_contact"),
					promptMessage: t("remove_contact_confirmation"),
					promptOkText: t("remove"),
					action: () =>
						contacts.delete({
							uuid: contactItem.data.uuid
						})
				})
			})

			buttons.push(
				buildBlockToggleMenuAction({
					t,
					isBlocked: false,
					target: contactItem.data
				})
			)
		}

		if (info.item.type === "blocked") {
			buttons.push(
				buildBlockToggleMenuAction({
					t,
					isBlocked: true,
					target: info.item.data
				})
			)
		}

		return buttons
	})()

	// Kept apart from baseMenuButtons and only ever handed to JSX: onAccept/onDeny read inFlightRef,
	// and the refs lint rejects passing them to a call or reading a structure holding them in render.
	const requestMenuButtons: MenuButton[] =
		info.item.type === "incomingRequest"
			? [
					{
						id: "accept",
						requiresOnline: true,
						title: t("accept"),
						icon: "checkmark",
						onPress: onAccept
					},
					{
						id: "deny",
						requiresOnline: true,
						title: t("deny"),
						destructive: true,
						icon: "delete",
						onPress: onDeny
					}
				]
			: info.item.type === "outgoingRequest"
				? [
						{
							id: "cancel",
							requiresOnline: true,
							title: t("cancel"),
							destructive: true,
							icon: "cancel",
							onPress: onDeny
						}
					]
				: []

	const disabled = (() => {
		if (!selectOptions) {
			return false
		}

		const item = info.item

		if (item.type !== "contact") {
			return false
		}

		return selectOptions.userIdsToExclude?.some(c => c === Number(item.data.userId)) ?? false
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

		useContactsStore.getState().toggleSelectedContact(item)
	}

	if (info.item.type === "header") {
		return <ListRowSectionHeader title={info.item.data.title} />
	}

	const showMenu = info.item.type === "incomingRequest" || info.item.type === "outgoingRequest" || baseMenuButtons.length > 0

	return (
		<ListRow
			separator={!!(nextItem && nextItem.type !== "header")}
			disabled={disabled}
			selectable={showCheckbox}
			selected={isSelected}
			onSelectedChange={onPress}
			onPress={onPress}
			leading={
				<Avatar
					className="shrink-0"
					source={info.item.data.avatar}
					size={32}
					lastActive={info.item.type === "contact" ? Number(info.item.data.lastActive) : undefined}
				/>
			}
			title={contactDisplayName(info.item.data)}
			subtitle={info.item.data.email}
			trailing={
				showMenu ? (
					<View className="flex-row items-center gap-3 bg-transparent">
						{info.item.type === "incomingRequest" && (
							<PressableScale
								className="bg-green-500 size-8 rounded-full flex-row items-center justify-center"
								style={{ opacity: isOnline ? 1 : 0.4 }}
								rippleColor="transparent"
								onPress={onAccept}
								enabled={isOnline}
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
								style={{ opacity: isOnline ? 1 : 0.4 }}
								rippleColor="transparent"
								onPress={onDeny}
								enabled={isOnline}
								hitSlop={10}
							>
								<Ionicons
									name="close-outline"
									size={20}
									color="white"
								/>
							</PressableScale>
						)}
						{showMenu && (
							<Menu
								type="dropdown"
								isAnchoredToRight={true}
								buttons={[...baseMenuButtons, ...requestMenuButtons]}
							>
								<EllipsisMenuTrigger />
							</Menu>
						)}
					</View>
				) : undefined
			}
		/>
	)
}

export default Contact
