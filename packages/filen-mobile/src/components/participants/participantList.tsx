import { Platform, ActivityIndicator } from "react-native"
import { Fragment } from "react"
import { useResolveClassNames } from "uniwind"
import View from "@/components/ui/view"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import Header, { type HeaderItem } from "@/components/ui/header"
import VirtualList from "@/components/ui/virtualList"
import ParticipantRow, { type ParticipantRowProps } from "@/components/participants/participantRow"
import { useSafeAreaInsets } from "react-native-safe-area-context"

export type ParticipantListProps<T> = {
	title: string
	emptyTitle: string
	participants: readonly T[]
	keyExtractor: (participant: T) => string
	toRowProps: (participant: T) => ParticipantRowProps
	headerLeftItems?: HeaderItem[]
	headerRightItems?: HeaderItem[]
	isLoading?: boolean
}

export const ParticipantList = <T,>(props: ParticipantListProps<T>) => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const insets = useSafeAreaInsets()

	return (
		<Fragment>
			<Header
				title={props.title}
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={props.headerLeftItems}
				rightItems={props.headerRightItems}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				{props.isLoading ? (
					<View className="flex-1 bg-transparent items-center justify-center">
						<ActivityIndicator
							size="large"
							color={textForeground.color as string}
						/>
					</View>
				) : (
					<VirtualList
						data={props.participants as T[]}
						contentInsetAdjustmentBehavior="automatic"
						contentContainerStyle={{
							paddingBottom: insets.bottom
						}}
						emptyComponent={() => (
							<ListEmpty
								icon="people-outline"
								title={props.emptyTitle}
							/>
						)}
						renderItem={({ item: participant }) => {
							return <ParticipantRow {...props.toRowProps(participant)} />
						}}
						keyExtractor={participant => props.keyExtractor(participant)}
					/>
				)}
			</SafeAreaView>
		</Fragment>
	)
}

export default ParticipantList
