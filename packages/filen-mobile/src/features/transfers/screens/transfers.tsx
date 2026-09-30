import { Fragment, type ReactNode } from "react"
import { type TFunction } from "i18next"
import Text from "@/components/ui/text"
import { ScreenBody } from "@/components/ui/safeAreaView"
import ListEmpty from "@/components/ui/listEmpty"
import { useShallow } from "zustand/shallow"
import useTransfersStore, {
	type Transfer as TTransfer,
	type FinishedTransfer as TFinishedTransfer
} from "@/features/transfers/store/useTransfers.store"
import VirtualList, { type ListRenderItemInfo } from "@/components/ui/virtualList"
import View from "@/components/ui/view"
import EllipsisMenuTrigger from "@/components/ui/ellipsisMenuTrigger"
import SettingsHeader from "@/components/ui/settingsHeader"
import { useResolveClassNames } from "uniwind"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { router } from "@/lib/router"
import { useTranslation } from "react-i18next"
import Ionicons from "@expo/vector-icons/Ionicons"
import Menu, { type MenuButton } from "@/components/ui/menu"
import Thumbnail from "@/features/drive/components/item/thumbnail"
import { ItemGlyph } from "@/components/itemIcons"
import transfersLib from "@/features/transfers/transfers"
import { driveItemDisplayName } from "@/lib/decryption"
import { clampedRatio } from "@filen/shared"
import { confirmPrompt } from "@/lib/promptFlow"
import logger from "@/lib/logger"
import useCopyJobsStore from "@/features/copy/store/useCopyJobs.store"
import copyRunner from "@/features/copy/copyRunner"
import { copyFinishedTitle, copyNotesText, copyRowStatus } from "@/features/copy/copyRowText"
import { stopCopyWithChoice } from "@/features/copy/copyCancel"

type CopyTransfer = Extract<TTransfer, { type: "copy" }>

// The list holds the store's row objects themselves, never wrappers: FlashList's cell memo compares item
// identity, so an unpatched row keeps its cell un-rendered across progress events. Only FinishedTransfer
// carries finishedAt, which is what tells the two apart.
export type TransfersListItem = TTransfer | TFinishedTransfer

// Active transfers render on top in startedAt ascending (insertion) order. Does not mutate its input.
export function sortActiveTransfers(transfers: TTransfer[]): TTransfer[] {
	return transfers.slice().sort((a, b) => a.startedAt - b.startedAt)
}

// Finished transfers render below, most recently finished first. Kept apart from the active sort so the
// compiler caches it on finishedTransfers, which progress events leave untouched. Does not mutate its input.
export function sortFinishedTransfers(finishedTransfers: TFinishedTransfer[]): TFinishedTransfer[] {
	return finishedTransfers.slice().sort((a, b) => b.finishedAt - a.finishedAt)
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

function pauseResumeButton(transfer: Pick<TTransfer, "paused" | "pause" | "resume">, t: TFunction): MenuButton {
	return transfer.paused
		? {
				id: "resume",
				title: t("resume"),
				icon: "play",
				onPress: () => {
					transfer.resume()
				}
			}
		: {
				id: "pause",
				title: t("pause"),
				icon: "pause",
				onPress: () => {
					transfer.pause()
				}
			}
}

// children = leading icon + text, actions = trailing content.
const TransferRowShell = ({ actions, children }: { actions: ReactNode; children: ReactNode }) => {
	return (
		<View className="bg-transparent px-4 flex-col py-2">
			<View className="bg-transparent items-center justify-between flex-row gap-4">
				<View className="flex-row items-center gap-3 bg-transparent flex-1">{children}</View>
				<View className="flex-row items-center bg-transparent gap-3 shrink-0">{actions}</View>
			</View>
		</View>
	)
}

// Same layout as an upload row, with the state as text under the title instead of a second icon.
const CopyActiveRow = ({ transfer }: { transfer: CopyTransfer }) => {
	const { t } = useTranslation()
	const job = useCopyJobsStore(state => state.jobs[transfer.id])

	return (
		<TransferRowShell
			actions={
				<Menu
					type="dropdown"
					buttons={[
						pauseResumeButton(transfer, t),
						{
							id: "cancel",
							title: t("cancel"),
							icon: "cancel",
							destructive: true,
							onPress: () => {
								void stopCopyWithChoice(transfer.id, t)
							}
						}
					]}
				>
					<EllipsisMenuTrigger />
				</Menu>
			}
		>
			<ItemGlyph
				isDirectory={transfer.glyph !== "file"}
				name={transfer.name}
			/>
			<View className="flex-col bg-transparent flex-1">
				<Text
					className="text-foreground"
					numberOfLines={1}
					ellipsizeMode="middle"
				>
					{t("copy_row_title", { name: transfer.name })}
				</Text>
				<Text
					className="text-muted-foreground text-xs"
					numberOfLines={1}
				>
					{copyRowStatus(job, transfer.paused, t)}
				</Text>
			</View>
		</TransferRowShell>
	)
}

const CopyFinishedRow = ({ finished }: { finished: TFinishedTransfer }) => {
	const { t } = useTranslation()
	const removeFinishedTransfer = useTransfersStore(state => state.removeFinishedTransfer)
	const trashFailed = finished.copyTrashFailed ?? 0
	// A re-copy of failures is never offered while copied items still wait to go to the trash.
	const canRetry = useCopyJobsStore(state => trashFailed === 0 && (state.jobs[finished.id]?.retryable.length ?? 0) > 0)
	const notes = copyNotesText(finished.copyNotes, t)

	return (
		<TransferRowShell
			actions={
				<Menu
					type="dropdown"
					buttons={[
						...(trashFailed > 0
							? [
									{
										id: "retryTrash",
										title: t("retry"),
										icon: "restore" as const,
										requiresOnline: true,
										onPress: () => {
											copyRunner.retryTrash(finished.id).catch(err => {
												logger.error("copy", "retrying move to trash failed", { id: finished.id, error: err })
											})
										}
									}
								]
							: []),
						...(canRetry
							? [
									{
										id: "retryFailed",
										title: t("copy_retry_failed"),
										icon: "restore" as const,
										requiresOnline: true,
										onPress: () => {
											// The retry is a new row; this one would only repeat its failures.
											if (copyRunner.retryFailed(finished.id) !== null) {
												removeFinishedTransfer(finished.id)
											}
										}
									}
								]
							: []),
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
					<EllipsisMenuTrigger />
				</Menu>
			}
		>
			<ItemGlyph
				isDirectory={finished.copyGlyph !== "file"}
				name={finished.name}
			/>
			<View className="flex-col bg-transparent flex-1">
				<Text
					className="text-foreground"
					numberOfLines={1}
					ellipsizeMode="middle"
				>
					{copyFinishedTitle(finished, t)}
				</Text>
				<Text
					className="text-muted-foreground text-xs"
					numberOfLines={1}
					ellipsizeMode="middle"
				>
					{trashFailed > 0 ? t("copy_trash_failed", { count: trashFailed }) : finishedTransferSubtitle(finished, t)}
				</Text>
				{notes ? (
					<Text
						className="text-muted-foreground text-xs"
						numberOfLines={2}
					>
						{notes}
					</Text>
				) : null}
			</View>
		</TransferRowShell>
	)
}

const ActiveTransferRow = ({
	transfer,
	target
}: {
	transfer: Exclude<TTransfer, { type: "copy" }>
	target: ListRenderItemInfo<TransfersListItem>["target"]
}) => {
	const { t } = useTranslation()
	const textForeground = useResolveClassNames("text-foreground")

	return (
		<TransferRowShell
			actions={
				<Fragment>
					{transfer.paused ? (
						<Ionicons
							name="pause-circle-outline"
							size={20}
							color={textForeground.color}
						/>
					) : (
						<Text>{`${clampedRatio(transfer.bytesTransferred, transfer.size, 100).toFixed(0)}%`}</Text>
					)}
					<Menu
						type="dropdown"
						buttons={[
							pauseResumeButton(transfer, t),
							{
								id: "cancel",
								title: t("cancel"),
								icon: "cancel",
								destructive: true,
								onPress: async () => {
									const confirmed = await confirmPrompt(
										{
											title: t("cancel_transfer"),
											message: t("confirm_cancel_transfer"),
											cancelText: t("cancel"),
											okText: t("cancel_transfer"),
											destructive: true
										},
										{ tag: "transfers", message: "Transfer cancel prompt failed" }
									)

									if (!confirmed) {
										return
									}

									transfer.abort()
								}
							}
						]}
					>
						<EllipsisMenuTrigger />
					</Menu>
				</Fragment>
			}
		>
			{transfer.type === "uploadDirectory" || transfer.type === "uploadFile" ? (
				<ItemGlyph
					isDirectory={transfer.type === "uploadDirectory"}
					name={transfer.name}
				/>
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
				{transfer.type === "uploadDirectory" || transfer.type === "uploadFile" ? transfer.name : driveItemDisplayName(transfer.item)}
			</Text>
		</TransferRowShell>
	)
}

const FinishedTransferRow = ({ finished }: { finished: TFinishedTransfer }) => {
	const { t } = useTranslation()
	const removeFinishedTransfer = useTransfersStore(state => state.removeFinishedTransfer)

	return (
		<TransferRowShell
			actions={
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
					<EllipsisMenuTrigger />
				</Menu>
			}
		>
			<ItemGlyph
				isDirectory={finished.type === "uploadDirectory" || finished.type === "downloadDirectory"}
				name={finished.name}
			/>
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
		</TransferRowShell>
	)
}

const TransfersRow = ({ info }: { info: ListRenderItemInfo<TransfersListItem> }) => {
	const item = info.item

	if ("finishedAt" in item) {
		return item.type === "copy" ? <CopyFinishedRow finished={item} /> : <FinishedTransferRow finished={item} />
	}

	if (item.type === "copy") {
		return <CopyActiveRow transfer={item} />
	}

	return (
		<ActiveTransferRow
			transfer={item}
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

	return (
		<SettingsHeader
			title={t("transfers")}
			icon="close"
			onDismiss={() => {
				router.back()
			}}
			rightItems={
				count > 0 || hasFinished
					? [
							{
								type: "ellipsisMenu",
								buttons: [
									...(count > 0
										? allPaused
											? [
													{
														id: "resumeAll",
														title: t("resume_all"),
														icon: "play" as const,
														onPress: () => {
															transfersLib.resumeAll()
														}
													}
												]
											: [
													{
														id: "pauseAll",
														title: t("pause_all"),
														icon: "pause" as const,
														onPress: () => {
															transfersLib.pauseAll()
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
														const confirmed = await confirmPrompt(
															{
																title: t("cancel_all_transfers"),
																message: t("confirm_cancel_all_transfers"),
																cancelText: t("cancel"),
																okText: t("cancel_all"),
																destructive: true
															},
															{ tag: "transfers", message: "Cancel-all prompt failed" }
														)
	
														if (!confirmed) {
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
	const active = sortActiveTransfers(transfers)
	const finished = sortFinishedTransfers(finishedTransfers)
	const items: TransfersListItem[] = [...active, ...finished]

	return (
		<Fragment>
			<TransfersHeader />
			<ScreenBody>
				<VirtualList
					className="flex-1 bg-transparent"
					keyExtractor={item => ("finishedAt" in item ? `finished-${item.id}` : `active-${item.type}-${item.id}`)}
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
			</ScreenBody>
		</Fragment>
	)
}

export default Transfers
