import Text from "@/components/ui/text"
import { Platform, ActivityIndicator } from "react-native"
import { router, useNavigation } from "expo-router"
import View from "@/components/ui/view"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import Header from "@/components/ui/header"
import { Fragment, memo, useRef, useState } from "react"
import { useResolveClassNames } from "uniwind"
import { run } from "@filen/utils"
import VirtualList from "@/components/ui/virtualList"
import { simpleDate } from "@/lib/time"
import alerts from "@/lib/alerts"
import { UserEventResult_Tags, type UserEvent, type UserEventKind, UserEventKind_Tags } from "@filen/sdk-rs"
import { PressableScale } from "@/components/ui/pressables"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import useEventsQuery, { fetchData, eventsQueryUpdate } from "@/queries/useEvents.query"
import { serialize } from "@/lib/serializer"
import { onlineManager } from "@tanstack/react-query"

const ON_END_REACHED_THRESHOLD = 0.5

export function eventKindToReadable(kind: UserEventKind): string {
	switch (kind.tag) {
		case UserEventKind_Tags.FileUploaded: {
			return "tbd_file_uploaded"
		}

		case UserEventKind_Tags.FileVersioned: {
			return "tbd_file_versioned"
		}

		case UserEventKind_Tags.FileRestored: {
			return "tbd_file_restored"
		}

		case UserEventKind_Tags.VersionedFileRestored: {
			return "tbd_versioned_file_restored"
		}

		case UserEventKind_Tags.FileMoved: {
			return "tbd_file_moved"
		}

		case UserEventKind_Tags.FileRenamed: {
			return "tbd_file_renamed"
		}

		case UserEventKind_Tags.FileMetadataChanged: {
			return "tbd_file_metadata_changed"
		}

		case UserEventKind_Tags.FileTrash: {
			return "tbd_file_trash"
		}

		case UserEventKind_Tags.FileRm: {
			return "tbd_file_rm"
		}

		case UserEventKind_Tags.FileShared: {
			return "tbd_file_shared"
		}

		case UserEventKind_Tags.FileLinkEdited: {
			return "tbd_file_link_edited"
		}

		case UserEventKind_Tags.DeleteFilePermanently: {
			return "tbd_delete_file_permanently"
		}

		case UserEventKind_Tags.FolderTrash: {
			return "tbd_directory_trash"
		}

		case UserEventKind_Tags.FolderShared: {
			return "tbd_directory_shared"
		}

		case UserEventKind_Tags.FolderMoved: {
			return "tbd_directory_moved"
		}

		case UserEventKind_Tags.FolderRenamed: {
			return "tbd_directory_renamed"
		}

		case UserEventKind_Tags.FolderMetadataChanged: {
			return "tbd_directory_metadata_changed"
		}

		case UserEventKind_Tags.SubFolderCreated: {
			return "tbd_sub_directory_created"
		}

		case UserEventKind_Tags.BaseFolderCreated: {
			return "tbd_base_directory_created"
		}

		case UserEventKind_Tags.FolderRestored: {
			return "tbd_directory_restored"
		}

		case UserEventKind_Tags.FolderColorChanged: {
			return "tbd_directory_color_changed"
		}

		case UserEventKind_Tags.DeleteFolderPermanently: {
			return "tbd_delete_directory_permanently"
		}

		case UserEventKind_Tags.FolderLinkEdited: {
			return "tbd_directory_link_edited"
		}

		case UserEventKind_Tags.Login: {
			return "tbd_login"
		}

		case UserEventKind_Tags.FailedLogin: {
			return "tbd_failed_login"
		}

		case UserEventKind_Tags.PasswordChanged: {
			return "tbd_password_changed"
		}

		case UserEventKind_Tags.TwoFaEnabled: {
			return "tbd_two_fa_enabled"
		}

		case UserEventKind_Tags.TwoFaDisabled: {
			return "tbd_two_fa_disabled"
		}

		case UserEventKind_Tags.RequestAccountDeletion: {
			return "tbd_request_account_deletion"
		}

		case UserEventKind_Tags.TrashEmptied: {
			return "tbd_trash_emptied"
		}

		case UserEventKind_Tags.DeleteAll: {
			return "tbd_delete_all"
		}

		case UserEventKind_Tags.DeleteVersioned: {
			return "tbd_delete_versioned"
		}

		case UserEventKind_Tags.DeleteUnfinished: {
			return "tbd_delete_unfinished"
		}

		case UserEventKind_Tags.CodeRedeemed: {
			return "tbd_code_redeemed"
		}

		case UserEventKind_Tags.EmailChanged: {
			return "tbd_email_changed"
		}

		case UserEventKind_Tags.EmailChangeAttempt: {
			return "tbd_email_change_attempt"
		}

		case UserEventKind_Tags.RemovedSharedInItems: {
			return "tbd_removed_shared_in_items"
		}

		case UserEventKind_Tags.RemovedSharedOutItems: {
			return "tbd_removed_shared_out_items"
		}

		case UserEventKind_Tags.ItemFavorite: {
			return "tbd_item_favorite"
		}
	}
}

const Event = memo(({ event }: { event: UserEvent }) => {
	return (
		<PressableScale
			className="flex-row items-center px-4 bg-transparent"
			onPress={() => {
				router.push({
					pathname: "/eventInfo",
					params: {
						event: serialize(event)
					}
				})
			}}
		>
			<View className="flex-row items-center gap-4 py-2 bg-transparent border-b border-border">
				<View className="flex-col bg-transparent flex-1 gap-0.5">
					<Text
						className="text-foreground"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{eventKindToReadable(event.kind)}
					</Text>
					<Text
						className="text-muted-foreground text-xs"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{simpleDate(Number(event.timestamp))}
					</Text>
				</View>
			</View>
		</PressableScale>
	)
})

const Events = memo(() => {
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")
	const textMutedForeground = useResolveClassNames("text-muted-foreground")
	const insets = useSafeAreaInsets()

	const eventsQuery = useEventsQuery()
	const [loadingMore, setLoadingMore] = useState<boolean>(false)
	const [hasMore, setHasMore] = useState<boolean>(true)
	const inflightRef = useRef<boolean>(false)
	const navigation = useNavigation()

	const events =
		eventsQuery.status === "success"
			? eventsQuery.data
					.filter(event => event.tag === UserEventResult_Tags.Ok)
					.sort((a, b) => Number(b.inner[0].timestamp) - Number(a.inner[0].timestamp))
			: []

	return (
		<Fragment>
			<Header
				title="tbd_events"
				transparent={Platform.OS === "ios"}
				shadowVisible={false}
				backVisible={Platform.OS === "android"}
				backgroundColor={Platform.select({
					ios: undefined,
					default: bgBackgroundSecondary.backgroundColor as string
				})}
				leftItems={Platform.select({
					ios: [
						{
							type: "button",
							icon: {
								name: "close",
								color: textForeground.color,
								size: 20
							},
							props: {
								onPress: () => {
									navigation.getParent()?.goBack()
								}
							}
						}
					],
					default: undefined
				})}
			/>
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					data={events}
					loading={eventsQuery.status !== "success"}
					contentInsetAdjustmentBehavior="automatic"
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
					onRefresh={async () => {
						const result = await run(async () => {
							setHasMore(true)

							return await eventsQuery.refetch()
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)
						}
					}}
					onEndReached={async () => {
						if (inflightRef.current || !hasMore || eventsQuery.status !== "success") {
							return
						}

						// Pagination calls fetchData → authedSdkClient.getUserEvents
						// outside TanStack, so offline it would throw a network
						// error and the existing alerts.error result handler would
						// banner. Return silently; hasMore stays true so once
						// connectivity returns, scrolling triggers the next page.
						if (!onlineManager.isOnline()) {
							return
						}

						const oldest = events.at(-1)

						if (!oldest) {
							return
						}

						const result = await run(async defer => {
							inflightRef.current = true

							defer(() => {
								inflightRef.current = false
							})

							setLoadingMore(true)

							defer(() => {
								setLoadingMore(false)
							})

							const next = await fetchData({
								timestamp: oldest.inner[0].timestamp
							})

							if (next.length === 0) {
								setHasMore(false)

								return
							}

							eventsQueryUpdate({
								updater: prev => {
									const existingIds = new Set<bigint>()

									for (const e of prev) {
										if (e.tag === UserEventResult_Tags.Ok) {
											existingIds.add(e.inner[0].id)
										}
									}

									const filtered = next.filter(e => {
										if (e.tag !== UserEventResult_Tags.Ok) {
											return true
										}

										return !existingIds.has(e.inner[0].id)
									})

									if (filtered.length === 0) {
										setHasMore(false)
									}

									return [...prev, ...filtered]
								}
							})
						})

						if (!result.success) {
							console.error(result.error)
							alerts.error(result.error)
						}
					}}
					onEndReachedThreshold={ON_END_REACHED_THRESHOLD}
					emptyComponent={() => (
						<ListEmpty
							icon="list-outline"
							title="tbd_no_events"
						/>
					)}
					footerComponent={() => {
						if (!loadingMore) {
							return null
						}

						return (
							<View className="py-4 items-center bg-transparent">
								<ActivityIndicator
									size="small"
									color={textMutedForeground.color as string}
								/>
							</View>
						)
					}}
					renderItem={({ item: event }) => {
						return <Event event={event.inner[0]} />
					}}
					keyExtractor={event => event.inner[0].id.toString()}
				/>
			</SafeAreaView>
		</Fragment>
	)
})

export default Events
