import { useId, useReducer, useRef } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ChevronRightIcon } from "lucide-react"
import type { EntryNameErrorKindJS } from "@filen/sdk-rs"
import { cn, driveItemName } from "@filen/shared"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { canDisposeArchive, extractHereDestination, extractRequest, ITEM_NAME_ERROR_KEYS } from "@/features/drive/lib/archiveTargets"
import { itemNameError } from "@/features/drive/lib/archiveHelpers"
import { ARCHIVE_PASSWORD_MAX_CHARS } from "@/features/drive/lib/archivePassword"
import { cachedDirectoryName } from "@/features/drive/queries/drive"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { useArchiveNameInfo } from "@/features/drive/hooks/useArchiveNameInfo"
import { NAME_CHECK_DEBOUNCE_MS, useItemNameError } from "@/features/drive/hooks/useItemNameError"
import {
	archiveNeededPassword,
	extractDialogReducer,
	extractSubmitStep,
	folderNameToCheck,
	initExtractDialog,
	shownFolderName,
	validateExtract,
	type ExtractStart
} from "@/features/drive/components/extractDialog.logic"
import { DestinationField } from "@/features/drive/components/destinationField"
import { AfterwardsField } from "@/features/drive/components/afterwardsField"
import { ArchivePasswordInput } from "@/features/drive/components/archivePasswordInput"
import { startExtractWithCard } from "@/features/transfers/lib/archiveToast"
import { useDriveJobsStore } from "@/features/transfers/store/useDriveJobsStore"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { useIsOnline } from "@/lib/useIsOnline"
import { useDebouncedValue } from "@/lib/useDebouncedValue"
import { FormDialog } from "@/components/dialogs/formDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

export interface ExtractDialogProps {
	item: DriveItem
	variant: DriveVariant
	// The archive is known to have a password (its listing said so), so the field starts open.
	knownEncrypted?: boolean | undefined
	onClose: () => void
}

// Extract with options — mounted-when-active by the item's dialog host. Starts the job with its card and
// closes; a password the archive turns out to need is asked for by the prompt (extractPasswordDialog.tsx).
export function ExtractDialog({ item, variant, knownEncrypted, onClose }: ExtractDialogProps) {
	const { t } = useTranslation(["archive", "common", "drive"])
	const isOnline = useIsOnline()
	const id = useId()
	const name = driveItemName(item)
	const nameInfo = useArchiveNameInfo(name)
	const info = nameInfo.data
	const [state, dispatch] = useReducer(extractDialogReducer, undefined, () =>
		initExtractDialog({
			destination: extractHereDestination(variant, item, t("drive:driveMyDrive"), cachedDirectoryName) ?? {
				uuid: null,
				name: t("drive:driveMyDrive")
			},
			// One scan, at mount: an earlier run on this archive that stopped for its password.
			passwordOpen: knownEncrypted === true || archiveNeededPassword(useDriveJobsStore.getState().jobs, item.data.uuid)
		})
	)
	const single = info?.format?.type === "single"
	const disposeAllowed = canDisposeArchive(variant, item, "all")
	const folderName = shownFolderName(state, info?.defaultName ?? "")
	const nameToCheck = folderNameToCheck(state)
	// Asked once typing pauses; the last answer stays shown meanwhile, and a submit asks for the exact name.
	const checkedName = useDebouncedValue(nameToCheck, NAME_CHECK_DEBOUNCE_MS)
	const nameErrorQuery = useItemNameError(checkedName ?? "", checkedName !== null)
	const validation = validateExtract(state, { disposeAllowed, folderNameError: nameErrorQuery.data })
	const errors = validation.ok ? {} : validation.errors
	const folderNameError =
		errors.folderName === undefined || errors.folderName === "pending"
			? nameErrorQuery.isError && checkedName !== null
				? errorLabel(nameErrorQuery.error)
				: null
			: t(ITEM_NAME_ERROR_KEYS[errors.folderName])
	const passwordError = errors.password === "tooLong" ? t("archivePasswordTooLong", { max: ARCHIVE_PASSWORD_MAX_CHARS }) : null
	// One submit at a time while the exact name is asked about.
	const submitting = useRef(false)

	function start(options: ExtractStart): void {
		if (info === undefined) {
			return
		}

		startExtractWithCard(
			extractRequest(item, info, state.destination, {
				root: options.root,
				folderName: options.folderName,
				skipMacMetadata: options.skipMacMetadata,
				dispose: options.dispose
			}),
			options.password
		)

		// The archive leaves the listing once its contents are checked; a selection kept on it would count a ghost.
		if (options.dispose !== null) {
			useDriveStore.getState().removeFromSelection([item.data.uuid])
		}

		onClose()
	}

	// The SDK's answer for exactly the typed name (memoised, so usually at once), then on.
	async function submitChecked(confirmed: boolean): Promise<void> {
		if (info === undefined || !isOnline || submitting.current) {
			return
		}

		submitting.current = true

		// No finally, nor a conditional inside the try: the React Compiler skips a component holding either.
		let folderNameError: EntryNameErrorKindJS | null = null

		if (nameToCheck !== null) {
			try {
				folderNameError = await itemNameError(nameToCheck)
			} catch (e) {
				submitting.current = false
				toast.error(errorLabel(e))

				return
			}
		}

		submitting.current = false

		const checked = validateExtract(state, { disposeAllowed, folderNameError })

		// Every error shows at its field already; one only the exact name's answer found shows there too
		// once it is asked about.
		if (!checked.ok) {
			dispatch({ type: "cancelDelete" })
		} else if (!confirmed && extractSubmitStep(state, checked) === "confirmDelete") {
			dispatch({ type: "askDeleteConfirm" })
		} else {
			start(checked.start)
		}
	}

	return (
		<FormDialog
			open
			pending={false}
			wide
			title={t("archiveExtractTitle")}
			description={t("archiveExtractDescription")}
			submitLabel={t("archiveExtractSubmit")}
			cancelLabel={t("common:cancel")}
			// Invalid fields say why on submit rather than leaving the button dead.
			canSubmit={info !== undefined && isOnline}
			submitTitle={!isOnline ? t("common:offlineActionDisabled") : undefined}
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
			onSubmit={e => {
				// The picker's new-directory prompt bubbles its submit through the React tree into this form.
				if (e.target !== e.currentTarget) {
					return
				}

				e.preventDefault()
				void submitChecked(false)
			}}
		>
			{info === undefined ? (
				nameInfo.isError ? (
					<div className="flex flex-col items-start gap-2">
						<FieldError>{errorLabel(nameInfo.error)}</FieldError>
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => {
								void nameInfo.refetch()
							}}
						>
							{t("common:tryAgain")}
						</Button>
					</div>
				) : (
					<div className="flex justify-center py-6">
						<Spinner />
					</div>
				)
			) : (
				<FieldGroup>
					<DestinationField
						label={t("archiveExtractToLabel")}
						destination={state.destination}
						sources={[]}
						pickLabels={{ title: t("archiveExtractPickTitle"), confirm: t("archiveExtractPickConfirm") }}
						onChange={destination => {
							dispatch({ type: "setDestination", destination })
						}}
					/>
					<div className="flex flex-col gap-3">
						<Label id={`${id}-root-label`}>{t("archiveExtractRootLabel")}</Label>
						<RadioGroup
							aria-labelledby={`${id}-root-label`}
							value={state.root}
							onValueChange={(value: unknown) => {
								if (value === "newFolder" || value === "destination") {
									dispatch({ type: "setRoot", root: value })
								}
							}}
						>
							<div className="flex items-start gap-3">
								<RadioGroupItem
									id={`${id}-new`}
									value="newFolder"
									className="mt-0.5"
								/>
								<div className="flex min-w-0 flex-1 flex-col gap-2">
									<Label
										htmlFor={`${id}-new`}
										className="leading-snug"
									>
										{t("archiveExtractRootNewFolder")}
									</Label>
									<Input
										aria-label={t("archiveExtractFolderNameLabel")}
										value={folderName}
										disabled={state.root !== "newFolder"}
										aria-invalid={folderNameError !== null}
										aria-describedby={folderNameError === null ? undefined : `${id}-name-error`}
										onChange={e => {
											dispatch({ type: "setFolderName", folderName: e.target.value })
										}}
									/>
									{folderNameError === null ? null : <FieldError id={`${id}-name-error`}>{folderNameError}</FieldError>}
								</div>
							</div>
							<div className="flex items-start gap-3">
								<RadioGroupItem
									id={`${id}-destination`}
									value="destination"
									className="mt-0.5"
								/>
								<Label
									htmlFor={`${id}-destination`}
									className="min-w-0 leading-snug"
								>
									<span className="truncate">
										{t("archiveExtractRootDestination", { destination: state.destination.name })}
									</span>
								</Label>
							</div>
						</RadioGroup>
						{single ? (
							<p className="text-sm text-muted-foreground">
								{t("archiveExtractSingleNote", { defaultName: info.defaultName })}
							</p>
						) : null}
					</div>
					<Collapsible
						open={state.passwordOpen}
						onOpenChange={open => {
							dispatch({ type: "setPasswordOpen", open })
						}}
					>
						<CollapsibleTrigger
							render={
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="-ml-2"
								/>
							}
						>
							<ChevronRightIcon
								data-icon="inline-start"
								className={cn("transition-transform", state.passwordOpen && "rotate-90")}
							/>
							{t("archiveExtractHasPassword")}
						</CollapsibleTrigger>
						<CollapsibleContent className="pt-2">
							<Field data-invalid={passwordError !== null ? true : undefined}>
								<FieldLabel htmlFor={`${id}-password`}>{t("archivePasswordLabel")}</FieldLabel>
								<ArchivePasswordInput
									id={`${id}-password`}
									value={state.password}
									revealed={state.reveal}
									aria-invalid={passwordError !== null ? true : undefined}
									aria-describedby={passwordError !== null ? `${id}-password-error` : undefined}
									onRevealedChange={() => {
										dispatch({ type: "toggleReveal" })
									}}
									onChange={e => {
										dispatch({ type: "setPassword", password: e.target.value })
									}}
								/>
								{passwordError !== null ? <FieldError id={`${id}-password-error`}>{passwordError}</FieldError> : null}
							</Field>
						</CollapsibleContent>
					</Collapsible>
					<Field orientation="horizontal">
						<FieldContent>
							<FieldLabel htmlFor={`${id}-mac`}>{t("archiveSkipMacLabel")}</FieldLabel>
							<FieldDescription>{t("archiveSkipMacHint")}</FieldDescription>
						</FieldContent>
						<Switch
							id={`${id}-mac`}
							checked={state.skipMacMetadata}
							onCheckedChange={skip => {
								dispatch({ type: "setSkipMacMetadata", skip })
							}}
						/>
					</Field>
					{disposeAllowed ? (
						<AfterwardsField
							kind="extract"
							value={state.afterwards}
							onChange={afterwards => {
								dispatch({ type: "setAfterwards", afterwards })
							}}
						/>
					) : null}
				</FieldGroup>
			)}
			<ConfirmDialog
				open={state.step === "confirmDelete"}
				pending={false}
				destructive
				title={t("archiveDeleteConfirmTitle")}
				body={
					state.skipMacMetadata
						? `${t("archiveDeleteConfirmBodyExtract")} ${t("archiveDeleteConfirmMacNote")}`
						: t("archiveDeleteConfirmBodyExtract")
				}
				confirmLabel={t("archiveDeleteConfirmAction")}
				cancelLabel={t("common:cancel")}
				onOpenChange={open => {
					if (!open) {
						dispatch({ type: "cancelDelete" })
					}
				}}
				onConfirm={() => {
					void submitChecked(true)
				}}
			/>
		</FormDialog>
	)
}
