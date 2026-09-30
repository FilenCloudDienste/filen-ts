import { Fragment } from "react"
import { useResolveClassNames } from "uniwind"
import { useTranslation } from "react-i18next"
import { ScreenBody } from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import { type HeaderItem } from "@/components/ui/header"
import { type MenuButton } from "@/components/ui/menu"
import { selectAllMenuButton } from "@/components/ui/selectAllMenuButton"
import SettingsHeader from "@/components/ui/settingsHeader"
import VirtualList from "@/components/ui/virtualList"
import ParticipantRow, { type ParticipantRowProps } from "@/components/participants/participantRow"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { router } from "@/lib/router"
import useIsOnline from "@/hooks/useIsOnline"

export type ParticipantListProps<T> = {
	title: string
	emptyTitle: string
	emptyDescription?: string
	participants: readonly T[]
	keyExtractor: (participant: T) => string
	toRowProps: (participant: T) => ParticipantRowProps
	// Owner-only: selection mode (bulk menu) and the add button.
	owner?: {
		selectedCount: number
		clearSelection: () => void
		selectAll: () => void
		bulkButtons: MenuButton[]
		onAdd: () => Promise<void>
	}
}

export const ParticipantList = <T,>(props: ParticipantListProps<T>) => {
	const { t } = useTranslation()
	const insets = useSafeAreaInsets()
	const textForeground = useResolveClassNames("text-foreground")
	const isOnline = useIsOnline()
	const owner = props.owner
	const inSelectionMode = owner !== undefined && owner.selectedCount > 0

	const headerLeftItems: HeaderItem[] | undefined = inSelectionMode
		? [
				{
					type: "clearSelection",
					onPress: owner.clearSelection
				}
			]
		: undefined

	const headerRightItems: HeaderItem[] | undefined = (() => {
		if (!owner) {
			return undefined
		}

		if (inSelectionMode) {
			const allSelected = owner.selectedCount === props.participants.length

			return [
				{
					type: "ellipsisMenu",
					buttons: [
						selectAllMenuButton({
							t,
							allSelected,
							onClear: owner.clearSelection,
							onSelectAll: owner.selectAll
						}),
						...owner.bulkButtons
					]
				}
			]
		}

		return [
			{
				type: "button",
				icon: {
					name: "add-outline",
					color: textForeground.color,
					size: 20
				},
				props: {
					enabled: isOnline,
					onPress: owner.onAdd
				}
			}
		]
	})()

	return (
		<Fragment>
			<SettingsHeader
				title={inSelectionMode ? t("selected", { count: owner.selectedCount }) : props.title}
				onDismiss={() => router.back()}
				leftItems={headerLeftItems}
				rightItems={headerRightItems}
			/>
			<ScreenBody>
				<VirtualList
					data={props.participants as T[]}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					emptyComponent={() => (
						<ListEmpty
							icon="people-outline"
							title={props.emptyTitle}
							description={props.emptyDescription}
						/>
					)}
					renderItem={({ item: participant }) => {
						return <ParticipantRow {...props.toRowProps(participant)} />
					}}
					keyExtractor={participant => props.keyExtractor(participant)}
				/>
			</ScreenBody>
		</Fragment>
	)
}

export default ParticipantList
