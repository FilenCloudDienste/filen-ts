import { Platform, ActivityIndicator } from "react-native"
import { useNavigation } from "expo-router"
import { router } from "@/lib/router"
import View from "@/components/ui/view"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import Header from "@/components/ui/header"
import { Fragment, useRef, useState } from "react"
import { useResolveClassNames } from "uniwind"
import { run } from "@filen/utils"
import VirtualList from "@/components/ui/virtualList"
import { formatRelativeTime } from "@/lib/time"
import alerts from "@/lib/alerts"
import { UserEventResult_Tags, type UserEvent, type UserEventResult } from "@filen/sdk-rs"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import ListRow from "@/components/ui/listRow"
import useEventsQuery, { fetchData, eventsQueryUpdate } from "@/features/events/queries/useEvents.query"
import { eventKindToReadable } from "@/features/events/eventDetails"
import { serialize } from "@/lib/serializer"
import { onlineManager } from "@tanstack/react-query"
import { useTranslation } from "react-i18next"
import logger from "@/lib/logger"

const ON_END_REACHED_THRESHOLD = 0.5

/**
 * Pure pagination helper. Given the set of already-loaded Ok event ids and the
 * raw next page from the server, returns only the new Ok items (unknown-key Err
 * entries are discarded — they have no id, cannot be deduped, and must not be
 * persisted) plus a flag indicating that pagination should terminate.
 *
 * Termination fires when the page delivers zero new decryptable events, which
 * covers: an empty page, an all-Err page, and a page where all Ok ids were
 * already seen (full dedup). This prevents Err-only pages from causing an
 * infinite refetch loop.
 */
export function computeNextPage(existingOkIds: Set<bigint>, next: UserEventResult[]): { newOk: UserEventResult[]; terminate: boolean } {
	const newOk = next.filter(e => e.tag === UserEventResult_Tags.Ok && !existingOkIds.has(e.inner[0].id))

	return { newOk, terminate: newOk.length === 0 }
}

const Event = ({ event }: { event: UserEvent }) => {
	const { t } = useTranslation()

	return (
		<ListRow
			separator={true}
			title={eventKindToReadable(event.kind)}
			subtitle={formatRelativeTime(Number(event.timestamp), t)}
			onPress={() => {
				router.push({
					pathname: "/eventInfo",
					params: {
						event: serialize(event)
					}
				})
			}}
		/>
	)
}

const Events = () => {
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

	// When the first page came back but every result was undecryptable, show a
	// distinct subtitle so the user knows events exist but couldn't be read —
	// rather than the misleading "No events" empty state.
	const firstPageErrCount =
		eventsQuery.status === "success" && events.length === 0
			? eventsQuery.data.filter(e => e.tag === UserEventResult_Tags.Err).length
			: 0

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
					loading={eventsQuery.status === "pending"}
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
							logger.error("events", "pull-to-refresh failed", { error: result.error instanceof Error ? result.error.message : String(result.error) })
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

							// Build the existing-id set from the already-Ok-filtered events
							// computed outside the updater, so Err items can never satisfy
							// a dedup check and cannot prevent termination.
							const existingOkIds = new Set<bigint>()

							for (const e of events) {
								existingOkIds.add(e.inner[0].id)
							}

							const { newOk, terminate } = computeNextPage(existingOkIds, next)

							if (terminate) {
								logger.warn("events", "pagination page had no new decryptable events — terminating", { pageSize: next.length, errCount: next.filter(e => e.tag !== UserEventResult_Tags.Ok).length, existingOkCount: existingOkIds.size })
								setHasMore(false)

								return
							}

							// Only persist Ok items — Err entries have no stable id, cannot
							// be deduped, and would cause unbounded cache growth.
							eventsQueryUpdate({
								updater: prev => [...prev, ...newOk]
							})
						})

						if (!result.success) {
							logger.error("events", "pagination fetch failed", { timestamp: oldest.inner[0].timestamp?.toString(), error: result.error instanceof Error ? result.error.message : String(result.error) })
							alerts.error(result.error)
						}
					}}
					onEndReachedThreshold={ON_END_REACHED_THRESHOLD}
					emptyComponent={() => (
						<ListEmpty
							icon="list-outline"
							title={t("no_events")}
							description={
								firstPageErrCount > 0 ? t("events_undecryptable", { count: firstPageErrCount }) : t("no_events_description")
							}
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
}

export default Events
