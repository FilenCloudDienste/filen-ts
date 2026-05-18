import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import { Platform, ScrollView } from "react-native"
import { useLocalSearchParams, router } from "expo-router"
import { deserialize } from "@/lib/serializer"
import View from "@/components/ui/view"
import Header from "@/components/ui/header"
import { Fragment, memo } from "react"
import { useResolveClassNames } from "uniwind"
import { simpleDate } from "@/lib/time"
import { type UserEvent, type FileMeta, type DirMeta, FileMeta_Tags, DirMeta_Tags, UserEventKind_Tags } from "@filen/sdk-rs"
import { eventKindToReadable } from "@/routes/events"
import DismissStack from "@/components/dismissStack"

function extractFileMetaName(meta: FileMeta): string {
	if (meta.tag === FileMeta_Tags.Decoded) {
		return meta.inner[0].name
	}

	return "tbd_encrypted"
}

function extractDirMetaName(meta: DirMeta): string {
	if (meta.tag === DirMeta_Tags.Decoded) {
		return meta.inner[0].name
	}

	return "tbd_encrypted"
}

function buildEventDetails(event: UserEvent): {
	title: string
	value: string
}[] {
	const rows: {
		title: string
		value: string
	}[] = [
		{
			title: "tbd_event_type",
			value: eventKindToReadable(event.kind)
		},
		{
			title: "tbd_timestamp",
			value: simpleDate(Number(event.timestamp))
		},
		{
			title: "tbd_ip",
			value: event.kind.inner[0].ip
		},
		{
			title: "tbd_user_agent",
			value: event.kind.inner[0].userAgent
		}
	]

	switch (event.kind.tag) {
		case UserEventKind_Tags.FileUploaded:
		case UserEventKind_Tags.FileVersioned:
		case UserEventKind_Tags.FileRestored:
		case UserEventKind_Tags.VersionedFileRestored:
		case UserEventKind_Tags.FileMoved:
		case UserEventKind_Tags.FileTrash:
		case UserEventKind_Tags.FileRm:
		case UserEventKind_Tags.FileLinkEdited:
		case UserEventKind_Tags.DeleteFilePermanently: {
			rows.push({
				title: "tbd_name",
				value: extractFileMetaName(event.kind.inner[0].metadata)
			})

			break
		}

		case UserEventKind_Tags.FileRenamed:
		case UserEventKind_Tags.FileMetadataChanged: {
			rows.push({
				title: "tbd_name",
				value: extractFileMetaName(event.kind.inner[0].metadata)
			})

			rows.push({
				title: "tbd_old_name",
				value: extractFileMetaName(event.kind.inner[0].oldMetadata)
			})

			break
		}

		case UserEventKind_Tags.FileShared: {
			rows.push({
				title: "tbd_name",
				value: extractFileMetaName(event.kind.inner[0].metadata)
			})

			rows.push({
				title: "tbd_receiver_email",
				value: event.kind.inner[0].receiverEmail
			})

			break
		}

		case UserEventKind_Tags.FolderTrash:
		case UserEventKind_Tags.FolderMoved:
		case UserEventKind_Tags.SubFolderCreated:
		case UserEventKind_Tags.BaseFolderCreated:
		case UserEventKind_Tags.FolderRestored:
		case UserEventKind_Tags.FolderColorChanged:
		case UserEventKind_Tags.DeleteFolderPermanently: {
			rows.push({
				title: "tbd_name",
				value: extractDirMetaName(event.kind.inner[0].name)
			})

			break
		}

		case UserEventKind_Tags.FolderRenamed:
		case UserEventKind_Tags.FolderMetadataChanged: {
			rows.push({
				title: "tbd_name",
				value: extractDirMetaName(event.kind.inner[0].name)
			})

			rows.push({
				title: "tbd_old_name",
				value: extractDirMetaName(event.kind.inner[0].oldName)
			})

			break
		}

		case UserEventKind_Tags.FolderShared: {
			rows.push({
				title: "tbd_name",
				value: extractDirMetaName(event.kind.inner[0].name)
			})

			rows.push({
				title: "tbd_receiver_email",
				value: event.kind.inner[0].receiverEmail
			})

			break
		}

		case UserEventKind_Tags.FolderLinkEdited: {
			rows.push({
				title: "tbd_link_uuid",
				value: event.kind.inner[0].linkUuid
			})

			break
		}

		case UserEventKind_Tags.CodeRedeemed: {
			rows.push({
				title: "tbd_code",
				value: event.kind.inner[0].code
			})

			break
		}

		case UserEventKind_Tags.EmailChanged: {
			rows.push({
				title: "tbd_email",
				value: event.kind.inner[0].email
			})

			break
		}

		case UserEventKind_Tags.EmailChangeAttempt: {
			rows.push({
				title: "tbd_email",
				value: event.kind.inner[0].email
			})

			rows.push({
				title: "tbd_old_email",
				value: event.kind.inner[0].oldEmail
			})

			rows.push({
				title: "tbd_new_email",
				value: event.kind.inner[0].newEmail
			})

			break
		}

		case UserEventKind_Tags.ItemFavorite: {
			rows.push({
				title: "tbd_name",
				value: extractFileMetaName(event.kind.inner[0].metadata)
			})

			rows.push({
				title: "tbd_favorited",
				value: event.kind.inner[0].value ? "tbd_yes" : "tbd_no"
			})

			break
		}

		case UserEventKind_Tags.RemovedSharedInItems: {
			rows.push({
				title: "tbd_count",
				value: event.kind.inner[0].count.toString()
			})

			rows.push({
				title: "tbd_sharer_email",
				value: event.kind.inner[0].sharerEmail
			})

			break
		}

		case UserEventKind_Tags.RemovedSharedOutItems: {
			rows.push({
				title: "tbd_count",
				value: event.kind.inner[0].count.toString()
			})

			rows.push({
				title: "tbd_receiver_email",
				value: event.kind.inner[0].receiverEmail
			})

			break
		}

		case UserEventKind_Tags.Login:
		case UserEventKind_Tags.FailedLogin:
		case UserEventKind_Tags.PasswordChanged:
		case UserEventKind_Tags.TwoFaEnabled:
		case UserEventKind_Tags.TwoFaDisabled:
		case UserEventKind_Tags.RequestAccountDeletion:
		case UserEventKind_Tags.TrashEmptied:
		case UserEventKind_Tags.DeleteAll:
		case UserEventKind_Tags.DeleteVersioned:
		case UserEventKind_Tags.DeleteUnfinished: {
			break
		}
	}

	return rows
}

const EventInfo = memo(() => {
	const { event: eventSerialized } = useLocalSearchParams<{
		event?: string
	}>()
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")

	const event = (() => {
		if (!eventSerialized) {
			return null
		}

		try {
			return deserialize(eventSerialized) as UserEvent
		} catch {
			return null
		}
	})()

	if (!event) {
		return <DismissStack />
	}

	const rows = buildEventDetails(event)

	return (
		<Fragment>
			<Header
				title="tbd_event_info"
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
									router.back()
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
				<ScrollView
					contentContainerClassName="bg-transparent px-4 flex-col pb-40"
					showsHorizontalScrollIndicator={false}
					showsVerticalScrollIndicator={false}
					contentInsetAdjustmentBehavior="automatic"
				>
					<View className="bg-transparent flex-col gap-2">
						{rows.map(({ title, value }) => (
							<View
								key={title}
								className="bg-transparent border-b border-border pb-2 flex-row items-center justify-between gap-4"
							>
								<Text
									className="text-muted-foreground shrink-0"
									numberOfLines={1}
									ellipsizeMode="middle"
								>
									{title}
								</Text>
								<View className="bg-transparent flex-1 justify-end items-center flex-row gap-2">
									<Text
										className="text-foreground flex-1 text-right"
										numberOfLines={1}
										ellipsizeMode="middle"
									>
										{value}
									</Text>
								</View>
							</View>
						))}
					</View>
				</ScrollView>
			</SafeAreaView>
		</Fragment>
	)
})

export default EventInfo
