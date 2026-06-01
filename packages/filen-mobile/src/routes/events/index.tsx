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
import { useTranslation } from "react-i18next"
import i18n from "@/lib/i18n"
import { type en } from "@/locales/en"

const ON_END_REACHED_THRESHOLD = 0.5

// Maps each SDK event kind to a translation key. `satisfies` checks completeness + key validity
// while preserving each value's literal type, so indexing the map yields a narrow key that i18n.t
// accepts. Resolved with the module-level i18n.t because eventKindToReadable() is a plain
// (non-React) function shared with eventInfo and cannot use the useTranslation() hook.
const EVENT_KIND_KEY = {
	[UserEventKind_Tags.FileUploaded]: "file_uploaded",
	[UserEventKind_Tags.FileVersioned]: "file_versioned",
	[UserEventKind_Tags.FileRestored]: "file_restored",
	[UserEventKind_Tags.VersionedFileRestored]: "versioned_file_restored",
	[UserEventKind_Tags.FileMoved]: "file_moved",
	[UserEventKind_Tags.FileRenamed]: "file_renamed",
	[UserEventKind_Tags.FileMetadataChanged]: "file_metadata_changed",
	[UserEventKind_Tags.FileTrash]: "file_trash",
	[UserEventKind_Tags.FileRm]: "file_rm",
	[UserEventKind_Tags.FileShared]: "file_shared",
	[UserEventKind_Tags.FileLinkEdited]: "file_link_edited",
	[UserEventKind_Tags.DeleteFilePermanently]: "delete_file_permanently",
	[UserEventKind_Tags.FolderTrash]: "directory_trash",
	[UserEventKind_Tags.FolderShared]: "directory_shared",
	[UserEventKind_Tags.FolderMoved]: "directory_moved",
	[UserEventKind_Tags.FolderRenamed]: "directory_renamed",
	[UserEventKind_Tags.FolderMetadataChanged]: "directory_metadata_changed",
	[UserEventKind_Tags.SubFolderCreated]: "sub_directory_created",
	[UserEventKind_Tags.BaseFolderCreated]: "base_directory_created",
	[UserEventKind_Tags.FolderRestored]: "directory_restored",
	[UserEventKind_Tags.FolderColorChanged]: "directory_color_changed",
	[UserEventKind_Tags.DeleteFolderPermanently]: "delete_directory_permanently",
	[UserEventKind_Tags.FolderLinkEdited]: "directory_link_edited",
	[UserEventKind_Tags.Login]: "login",
	[UserEventKind_Tags.FailedLogin]: "failed_login",
	[UserEventKind_Tags.PasswordChanged]: "password_changed",
	[UserEventKind_Tags.TwoFaEnabled]: "two_fa_enabled",
	[UserEventKind_Tags.TwoFaDisabled]: "two_fa_disabled",
	[UserEventKind_Tags.RequestAccountDeletion]: "request_account_deletion",
	[UserEventKind_Tags.TrashEmptied]: "trash_emptied",
	[UserEventKind_Tags.DeleteAll]: "all_files_deleted",
	[UserEventKind_Tags.DeleteVersioned]: "delete_versioned",
	[UserEventKind_Tags.DeleteUnfinished]: "delete_unfinished",
	[UserEventKind_Tags.CodeRedeemed]: "code_redeemed",
	[UserEventKind_Tags.EmailChanged]: "email_changed",
	[UserEventKind_Tags.EmailChangeAttempt]: "email_change_attempt",
	[UserEventKind_Tags.RemovedSharedInItems]: "removed_shared_in_items",
	[UserEventKind_Tags.RemovedSharedOutItems]: "removed_shared_out_items",
	[UserEventKind_Tags.ItemFavorite]: "item_favorite"
} satisfies Record<UserEventKind_Tags, keyof typeof en>

export function eventKindToReadable(kind: UserEventKind): string {
	return i18n.t(EVENT_KIND_KEY[kind.tag])
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
	const { t } = useTranslation()

	const events =
		eventsQuery.status === "success"
			? eventsQuery.data
					.filter(event => event.tag === UserEventResult_Tags.Ok)
					.sort((a, b) => Number(b.inner[0].timestamp) - Number(a.inner[0].timestamp))
			: []

	return (
		<Fragment>
			<Header
				title={t("events")}
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
						if (!onlineManager.isOnline()) {
							return
						}

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
							title={t("no_events")}
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
