import { Fragment } from "react"
import { type TFunction } from "i18next"
import Text from "@/components/ui/text"
import SafeAreaView from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import { Platform } from "react-native"
import { useShallow } from "zustand/shallow"
import useTransfersStore, {
	type Transfer as TTransfer,
	type FinishedTransfer as TFinishedTransfer
} from "@/features/transfers/store/useTransfers.store"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import View, { CrossGlassContainerView } from "@/components/ui/view"
import { PressableScale } from "@/components/ui/pressables"
import Header, { type HeaderItem } from "@/components/ui/header"
import { useResolveClassNames } from "uniwind"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { router } from "expo-router"
import { useTranslation } from "react-i18next"
import Ionicons from "@expo/vector-icons/Ionicons"
import Menu from "@/components/ui/menu"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import { DirectoryIcon, FileIcon } from "@/components/itemIcons"
import { DirColor } from "@filen/sdk-rs"
import transfersLib from "@/features/transfers/transfers"
import { driveItemDisplayName } from "@/lib/decryption"
import { run } from "@filen/utils"
import prompts from "@/lib/prompts"
import alerts from "@/lib/alerts"

// Discriminated wrapper so the list can hold both still-running ("active") transfers and
// settled ("finished") snapshots and the renderer can branch on `kind`.
export type TransfersListItem = { kind: "active"; transfer: TTransfer } | { kind: "finished"; finished: TFinishedTransfer }

// Pure, unit-testable builder for the merged display list: active transfers on top ordered by
// startedAt ascending (insertion order), finished transfers below ordered by finishedAt descending
// (most recently finished first). Does not mutate its inputs.
export function buildTransfersDisplayList(args: { transfers: TTransfer[]; finishedTransfers: TFinishedTransfer[] }): TransfersListItem[] {
	const { transfers, finishedTransfers } = args

	const active: TransfersListItem[] = [...transfers]
		.sort((a, b) => a.startedAt - b.startedAt)
		.map(transfer => ({
			kind: "active",
			transfer
		}))

	const finished: TransfersListItem[] = [...finishedTransfers]
		.sort((a, b) => b.finishedAt - a.finishedAt)
		.map(finished => ({
			kind: "finished",
			finished
		}))

	return [...active, ...finished]
}

// Pure, unit-testable subtitle for a finished-transfer row. Errored rows prefer the captured
// error message; completedWithErrors rows (resolved Ok but with per-entry failures) render the
// localized error count so a partially-failed directory transfer is never presented as a clean
// success; everything else is a plain "Completed".
export function finishedTransferSubtitle(finished: TFinishedTransfer, t: TFunction): string {
	if (finished.outcome === "errored") {
		return finished.errorMessage ?? t("transfer_failed")
	}

	if (finished.outcome === "completedWithErrors") {
		return t("transfer_completed_with_errors", { count: finished.errorCount })
	}

	return t("transfer_completed")
}

const ActiveTransferRow = ({ transfer, target }: { transfer: TTransfer; target: ListRenderItemInfo<TransfersListItem>["target"] }) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<View className="bg-transparent px-4 flex-col py-2">
			<View className="bg-transparent items-center justify-between flex-row gap-4">
				<View className="flex-row items-center gap-3 bg-transparent flex-1">
					{transfer.type === "uploadDirectory" || transfer.type === "uploadFile" ? (
						<Fragment>
							{transfer.type === "uploadDirectory" ? (
								<DirectoryIcon
									color={DirColor.Default.new()}
									width={32}
									height={32}
								/>
							) : (
								<FileIcon
									name={transfer.localFileOrDir.name}
									width={32}
									height={32}
								/>
							)}
						</Fragment>
					) : (
						<Thumbnail
							item={transfer.item}
							target={target}
							size={{
								icon: 32,
								thumbnail: 32
							}}
							contentFit="cover"
							className="rounded-lg"
						/>
					)}
					<Text
						className="text-foreground flex-1"
						numberOfLines={1}
						ellipsizeMode="middle"
					>
						{transfer.type === "uploadDirectory" || transfer.type === "uploadFile"
							? transfer.localFileOrDir.name
							: driveItemDisplayName(transfer.item)}
					</Text>
				</View>
				<View className="flex-row items-center bg-transparent gap-3 shrink-0">
					{transfer.paused ? (
						<Ionicons
							name="pause-circle-outline"
							size={20}
							color={textForeground.color}
						/>
					) : (
						<Text>
							{transfer.size > 0
								? `${Math.min(100, Math.max(0, (transfer.bytesTransferred / transfer.size) * 100)).toFixed(0)}%`
								: "0%"}
						</Text>
					)}
					<Menu
						type="dropdown"
						buttons={[
							...(transfer.paused
								? [
										{
											id: "resume",
											title: t("resume"),
											icon: "play" as const,
											onPress: () => {
												transfer.resume()
											}
										}
									]
								: [
										{
											id: "pause",
											title: t("pause"),
											icon: "pause" as const,
											onPress: () => {
												transfer.pause()
											}
										}
									]),
							{
								id: "cancel",
								title: t("cancel"),
								icon: "cancel",
								destructive: true,
								onPress: async () => {
									const promptResult = await run(async () => {
										return await prompts.alert({
											title: t("cancel_transfer"),
											message: t("confirm_cancel_transfer"),
											cancelText: t("cancel"),
											okText: t("cancel_transfer"),
											destructive: true
										})
									})

									if (!promptResult.success) {
										console.error(promptResult.error)
										alerts.error(promptResult.error)

										return
									}

									if (promptResult.data.cancelled) {
										return
									}

									transfer.abort()
								}
							}
						]}
					>
						<CrossGlassContainerView>
							<PressableScale className="size-9 flex-row items-center justify-center">
								<Ionicons
									name="ellipsis-horizontal"
									size={20}
									color={textForeground.color}
								/>
							</PressableScale>
						</CrossGlassContainerView>
					</Menu>
				</View>
			</View>
		</View>
	)
}

const FinishedTransferRow = ({ finished }: { finished: TFinishedTransfer }) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")
	const removeFinishedTransfer = useTransfersStore(state => state.removeFinishedTransfer)

	return (
		<View className="bg-transparent px-4 flex-col py-2">
			<View className="bg-transparent items-center justify-between flex-row gap-4">
				<View className="flex-row items-center gap-3 bg-transparent flex-1">
					{finished.type === "uploadDirectory" || finished.type === "downloadDirectory" ? (
						<DirectoryIcon
							color={DirColor.Default.new()}
							width={32}
							height={32}
						/>
					) : (
						<FileIcon
							name={finished.name}
							width={32}
							height={32}
						/>
					)}
					<View className="flex-col bg-transparent flex-1">
						<Text
							className="text-foreground"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{finished.name}
						</Text>
						<Text
							className="text-muted-foreground text-xs"
							numberOfLines={1}
							ellipsizeMode="middle"
						>
							{finishedTransferSubtitle(finished, t)}
						</Text>
					</View>
				</View>
				<View className="flex-row items-center bg-transparent gap-3 shrink-0">
					<Menu
						type="dropdown"
						buttons={[
							{
								id: "removeFromList",
								title: t("transfer_remove_from_list"),
								icon: "trash",
								destructive: true,
								onPress: () => {
									removeFinishedTransfer(finished.id)
								}
							}
						]}
					>
						<CrossGlassContainerView>
							<PressableScale className="size-9 flex-row items-center justify-center">
								<Ionicons
									name="ellipsis-horizontal"
									size={20}
									color={textForeground.color}
								/>
							</PressableScale>
						</CrossGlassContainerView>
					</Menu>
				</View>
			</View>
		</View>
	)
}

const TransfersRow = ({ info }: { info: ListRenderItemInfo<TransfersListItem> }) => {
	const item = info.item

	if (item.kind === "finished") {
		return <FinishedTransferRow finished={item.finished} />
	}

	return (
		<ActiveTransferRow
			transfer={item.transfer}
			target={info.target}
		/>
	)
}

const TransfersHeader = () => {
	const { t } = useTranslation()
	// Subscribe only to the header-relevant derivations, not the whole transfers array. Byte-progress
	// updates replace the array reference ~10x/s but leave count/allPaused/hasFinished unchanged, so
	// useShallow skips header re-renders. count + allPaused stay scoped to ACTIVE transfers only.
	const { count, allPaused, hasFinished } = useTransfersStore(
		useShallow(state => ({
			count: state.transfers.length,
			allPaused: state.transfers.length > 0 && state.transfers.every(transfer => transfer.paused),
			hasFinished: state.finishedTransfers.length > 0
		}))
	)
	const bgBackgroundSecondary = useResolveClassNames("bg-background-secondary")
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<Header
			title={t("transfers")}
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
				] satisfies HeaderItem[],
				default: undefined
			})}
			rightItems={
				count > 0 || hasFinished
					? [
							{
								type: "menu",
								props: {
									type: "dropdown",
									hitSlop: 20,
									buttons: [
										...(count > 0
											? allPaused
												? [
														{
															id: "resumeAll",
															title: t("resume_all"),
															icon: "play" as const,
															onPress: () => {
																// Iterate per-transfer instead of resuming the
																// global signal: the store's `paused` flag is
																// driven by the per-transfer signal, so a global
																// resume would leave individually-paused transfers
																// stuck (store says resumed, SDK still paused).
																// Read the live array imperatively to avoid a stale
																// closure (the header no longer subscribes to it).
																for (const transfer of useTransfersStore.getState().transfers) {
																	transfer.resume()
																}
															}
														}
													]
												: [
														{
															id: "pauseAll",
															title: t("pause_all"),
															icon: "pause" as const,
															onPress: () => {
																// Same reason — iterate per-transfer so the
																// per-transfer signal stays in sync with the store
																// and so the global pause signal doesn't stay
																// sticky and silently pause future uploads.
																for (const transfer of useTransfersStore.getState().transfers) {
																	transfer.pause()
																}
															}
														}
													]
											: []),
										...(count > 0
											? [
													{
														id: "abortAll",
														title: t("cancel_all"),
														icon: "cancel" as const,
														destructive: true,
														onPress: async () => {
															const promptResult = await run(async () => {
																return await prompts.alert({
																	title: t("cancel_all_transfers"),
																	message: t("confirm_cancel_all_transfers"),
																	cancelText: t("cancel"),
																	okText: t("cancel_all"),
																	destructive: true
																})
															})

															if (!promptResult.success) {
																console.error(promptResult.error)
																alerts.error(promptResult.error)

																return
															}

															if (promptResult.data.cancelled) {
																return
															}

															transfersLib.cancelAll()
														}
													}
												]
											: []),
										...(hasFinished
											? [
													{
														// Not destructive — finished entries are just session UI bookkeeping, so no
														// confirmation prompt.
														id: "clearFinished",
														title: t("transfers_clear_finished"),
														icon: "trash" as const,
														onPress: () => {
															useTransfersStore.getState().clearFinishedTransfers()
														}
													}
												]
											: [])
									]
								},
								triggerProps: {
									hitSlop: 20
								},
								icon: {
									name: "ellipsis-horizontal",
									size: 24,
									color: textForeground.color
								}
							}
						]
					: undefined
			}
		/>
	)
}

const Transfers = () => {
	const { t } = useTranslation()
	const { transfers, finishedTransfers } = useTransfersStore(
		useShallow(state => ({
			transfers: state.transfers,
			finishedTransfers: state.finishedTransfers
		}))
	)
	const insets = useSafeAreaInsets()
	const items = buildTransfersDisplayList({
		transfers,
		finishedTransfers
	})

	return (
		<Fragment>
			<TransfersHeader />
			<SafeAreaView
				className="flex-1 bg-background-secondary"
				edges={["left", "right"]}
			>
				<VirtualList
					className="flex-1 bg-transparent"
					contentInsetAdjustmentBehavior="automatic"
					keyExtractor={item =>
						item.kind === "active" ? `active-${item.transfer.type}-${item.transfer.id}` : `finished-${item.finished.id}`
					}
					data={items}
					renderItem={info => <TransfersRow info={info} />}
					emptyComponent={() => (
						<ListEmpty
							icon="sync-outline"
							title={t("no_transfers")}
							description={t("no_transfers_description")}
						/>
					)}
					contentContainerStyle={{
						paddingBottom: insets.bottom
					}}
				/>
			</SafeAreaView>
		</Fragment>
	)
}

export default Transfers
