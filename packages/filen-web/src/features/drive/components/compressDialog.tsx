import { useId, useReducer, useRef, type SubmitEvent } from "react"
import { useTranslation } from "react-i18next"
import { useQuery } from "@tanstack/react-query"
import { toast } from "sonner"
import { ChevronDownIcon } from "lucide-react"
import type { AesStrength } from "@filen/sdk-rs"
import { cn } from "@filen/shared"
import type { ArchiveKey } from "@/lib/i18n"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { log } from "@/lib/log"
import { noDiskPersister } from "@/queries/persist"
import { useIsOnline } from "@/lib/useIsOnline"
import { useDebouncedValue } from "@/lib/useDebouncedValue"
import type { ArchiveFormatInfo } from "@/workers/sdk.worker"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import { cachedDirectoryName } from "@/features/drive/queries/drive"
import { useDriveStore } from "@/features/drive/store/useDriveStore"
import { archiveCodecMemBudget, archiveFormatInfos, archiveNameInfo, itemNameError } from "@/features/drive/lib/archiveHelpers"
import { ARCHIVE_PASSWORD_MAX_CHARS } from "@/features/drive/lib/archivePassword"
import {
	AES_STRENGTHS,
	choicesFor,
	effectiveLevel,
	formatChoice,
	hasLevels,
	isFormatRunnable,
	probeFormat,
	SEVENZ_METHODS,
	ZIP_METHODS,
	type SevenZMethodId,
	type ZipMethodId
} from "@/features/drive/lib/archiveFormats"
import {
	loadCompressPreferences,
	nextCompressPreferences,
	setCompressPreferences,
	type CompressPreferences
} from "@/features/drive/lib/compressPreferences"
import { archiveParentName, canDisposeSources, defaultJobDestination, ITEM_NAME_ERROR_KEYS } from "@/features/drive/lib/archiveTargets"
import { useArchiveNameInfo } from "@/features/drive/hooks/useArchiveNameInfo"
import { NAME_CHECK_DEBOUNCE_MS, useItemNameError } from "@/features/drive/hooks/useItemNameError"
import {
	CATALOGUE,
	catalogueLookup,
	compressDialogReducer,
	compressNameToCheck,
	initCompressDialog,
	methodOf,
	PAGE_QUERY_OPTIONS,
	validateCompress,
	visibleCompressErrors,
	type CompressStart,
	type CompressValidation
} from "@/features/drive/components/compressDialog.logic"
import { startCompressWithCard } from "@/features/transfers/lib/archiveToast"
import { ArchiveFormatSelect } from "@/features/drive/components/archiveFormatSelect"
import { ArchiveLevelField } from "@/features/drive/components/archiveLevelField"
import { AfterwardsField } from "@/features/drive/components/afterwardsField"
import { DestinationField } from "@/features/drive/components/destinationField"
import { ArchivePasswordInput } from "@/features/drive/components/archivePasswordInput"
import { FormDialog } from "@/components/dialogs/formDialog"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { LoadingState } from "@/components/loadingState"
import { PreviewErrorState } from "@/features/preview/components/previewErrorState"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { SecretInput } from "@/components/ui/secretInput"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

const METHOD_LABEL_KEYS: Record<ZipMethodId | SevenZMethodId, ArchiveKey> = {
	stored: "archiveMethodStored",
	deflate: "archiveMethodDeflate",
	bzip2: "archiveMethodBzip2",
	lzma2: "archiveMethodLzma2",
	lzma: "archiveMethodLzma",
	ppmd: "archiveMethodPpmd",
	copy: "archiveMethodCopy"
}

const AES_LABEL_KEYS: Record<AesStrength, ArchiveKey> = {
	aes128: "archiveAes128",
	aes192: "archiveAes192",
	aes256: "archiveAes256"
}

// Every format at each method in one worker call, kept for the page.
function fetchFormatCatalogue(): Promise<ArchiveFormatInfo[]> {
	return archiveFormatInfos(CATALOGUE.map(entry => entry.probe))
}

export interface CompressDialogProps {
	items: DriveItem[]
	variant: DriveVariant
	onClose: () => void
}

// Compress with every option. Mounted only while open (the dialog hosts); waits for the remembered
// options, the format catalogue and the codec budget, all held for the page after the first open.
export function CompressDialog({ items, variant, onClose }: CompressDialogProps) {
	const { t } = useTranslation(["archive", "common"])
	// Read again on every open (the memo answers at once), so a submit's write is what the next one sees.
	const prefsQuery = useQuery({
		queryKey: ["drive", "compressPreferences"],
		queryFn: loadCompressPreferences,
		...PAGE_QUERY_OPTIONS,
		gcTime: 0,
		persister: noDiskPersister
	})
	const catalogueQuery = useQuery({
		queryKey: ["archive", "formatCatalogue"],
		queryFn: fetchFormatCatalogue,
		...PAGE_QUERY_OPTIONS,
		persister: noDiskPersister
	})
	const budgetQuery = useQuery({
		queryKey: ["archive", "budget"],
		queryFn: archiveCodecMemBudget,
		...PAGE_QUERY_OPTIONS,
		persister: noDiskPersister
	})

	if (prefsQuery.data !== undefined && catalogueQuery.data !== undefined && budgetQuery.data !== undefined) {
		return (
			<CompressDialogForm
				items={items}
				variant={variant}
				prefs={prefsQuery.data}
				infos={catalogueQuery.data}
				budget={budgetQuery.data}
				onClose={onClose}
			/>
		)
	}

	const failed = [prefsQuery, catalogueQuery, budgetQuery].find(query => query.status === "error")

	return (
		<FormDialog
			open
			wide
			pending={false}
			title={t("archiveCompressTitle")}
			description={t("archiveCompressDescription")}
			submitLabel={t("archiveCompressSubmit")}
			cancelLabel={t("common:cancel")}
			canSubmit={false}
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
			onSubmit={e => {
				e.preventDefault()
			}}
		>
			{failed === undefined ? (
				<LoadingState
					size="md"
					className="min-h-40"
				/>
			) : (
				<PreviewErrorState
					message={errorLabel(failed.error)}
					onRetry={() => {
						void failed.refetch()
					}}
				/>
			)}
		</FormDialog>
	)
}

interface CompressDialogFormProps extends CompressDialogProps {
	prefs: CompressPreferences
	infos: readonly ArchiveFormatInfo[]
	budget: number
}

function CompressDialogForm({ items, variant, prefs, infos, budget, onClose }: CompressDialogFormProps) {
	const { t } = useTranslation(["archive", "drive", "common"])
	const isOnline = useIsOnline()
	const id = useId()
	const first = items[0]
	const singleFile = items.length === 1 && first !== undefined && !isDirectoryItem(first)
	const choices = choicesFor({ singleFile })
	const disposeAllowed = canDisposeSources(variant, items)
	const infoFor = catalogueLookup(infos)
	const [state, dispatch] = useReducer(compressDialogReducer, undefined, () =>
		initCompressDialog({
			prefs,
			naming: { items, parentName: archiveParentName(items, cachedDirectoryName), fallback: t("archiveDefaultName") },
			destination: defaultJobDestination(items, variant, t("drive:driveMyDrive"), cachedDirectoryName),
			allowed: choices.map(choice => choice.id)
		})
	)
	const choice = formatChoice(state.choice)
	const method = methodOf(state)
	const info = infoFor(state.choice, method)
	const encrypted = state.protect && choice.encryptable
	const single = choice.family === "single"
	const nameToCheck = compressNameToCheck(state, infoFor)
	// Asked once typing pauses; the last answer stays shown meanwhile, and a submit asks for the exact name.
	const checkedName = useDebouncedValue(nameToCheck, NAME_CHECK_DEBOUNCE_MS)
	const nameErrorQuery = useItemNameError(checkedName ?? "", checkedName !== null)
	const singleNameInfo = useArchiveNameInfo(checkedName ?? "", single && checkedName !== null)
	const validation = validateCompress(state, {
		infoFor,
		singleFile,
		disposeAllowed,
		nameError: nameErrorQuery.data,
		nameFormat: single ? singleNameInfo.data?.format : undefined
	})
	const errors = validation.ok ? {} : visibleCompressErrors(state, validation.errors)
	// The SDK could not be asked about the name; the field says why.
	const askFailed = nameErrorQuery.isError ? nameErrorQuery.error : single && singleNameInfo.isError ? singleNameInfo.error : null
	const nameError =
		errors.name === undefined || errors.name === "pending"
			? askFailed !== null && checkedName !== null
				? errorLabel(askFailed)
				: null
			: t(errors.name === "otherFormat" ? "archiveNameOtherFormat" : ITEM_NAME_ERROR_KEYS[errors.name])
	const passwordError =
		errors.password === undefined
			? null
			: errors.password === "tooLong"
				? t("archivePasswordTooLong", { max: ARCHIVE_PASSWORD_MAX_CHARS })
				: t("archivePasswordEmpty")
	const offlineTitle = !isOnline ? t("common:offlineActionDisabled") : undefined
	// One submit at a time while the exact name is asked about.
	const submitting = useRef(false)

	// The form as it stands, with the SDK's answers for exactly its name (memoised, so usually at once).
	async function checkedValidation(): Promise<CompressValidation> {
		const [nameError, nameInfo] = await Promise.all([
			nameToCheck === null ? null : itemNameError(nameToCheck),
			nameToCheck === null || !single ? undefined : archiveNameInfo(nameToCheck)
		])

		return validateCompress(state, { infoFor, singleFile, disposeAllowed, nameError, nameFormat: nameInfo?.format })
	}

	async function submitChecked(confirmed: boolean): Promise<void> {
		if (submitting.current || !isOnline) {
			return
		}

		submitting.current = true

		try {
			const checked = await checkedValidation()

			if (!checked.ok) {
				dispatch({ type: "cancelDelete" })
			}

			if (!confirmed || !checked.ok) {
				dispatch({ type: "requestSubmit", valid: checked.ok })
			}

			if (checked.ok && (confirmed || state.afterwards !== "deletePermanently")) {
				start(checked.start)
			}
		} catch (e) {
			toast.error(errorLabel(e))
		} finally {
			submitting.current = false
		}
	}

	function start(run: CompressStart): void {
		startCompressWithCard(
			{
				source: { kind: "items", items },
				destination: state.destination,
				name: run.name,
				format: run.format,
				encrypted: run.encrypted,
				dispose: run.dispose,
				itemCount: items.length
			},
			run.password
		)

		// Not awaited: the job doesn't wait on a preference write, and a failed one only loses the memory.
		setCompressPreferences(nextCompressPreferences(prefs, run.prefs)).catch((e: unknown) => {
			log.warn("archive", "saving compress preferences failed", e)
		})

		// The originals leave the listing once checked; a selection kept on them would count ghosts.
		if (run.dispose !== null) {
			useDriveStore.getState().removeFromSelection(items.map(item => item.data.uuid))
		}

		onClose()
	}

	function handleSubmit(e: SubmitEvent): void {
		// A nested dialog's form (the picker's new-directory prompt) bubbles its submit through the React
		// tree into this one; it is not this form's.
		if (e.target !== e.currentTarget) {
			return
		}

		e.preventDefault()
		void submitChecked(false)
	}

	const nameId = `${id}-name`
	const extensionId = `${id}-extension`
	const formatId = `${id}-format`
	const protectId = `${id}-protect`
	const passwordId = `${id}-password`
	const confirmId = `${id}-confirm`
	const encryptNamesId = `${id}-encrypt-names`
	const methodId = `${id}-method`
	const solidId = `${id}-solid`
	const aesId = `${id}-aes`
	const levelsShown = hasLevels(state.choice, method)
	const advancedShown = choice.family === "zip" || choice.family === "sevenZ"

	return (
		<FormDialog
			open
			wide
			pending={false}
			title={t("archiveCompressTitle")}
			description={t("archiveCompressDescription")}
			submitLabel={t("archiveCompressSubmit")}
			cancelLabel={t("common:cancel")}
			// Invalid fields say why on submit rather than leaving the button dead.
			canSubmit={isOnline}
			submitTitle={offlineTitle}
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
			onSubmit={handleSubmit}
		>
			<FieldGroup>
				<Field data-invalid={nameError !== null ? true : undefined}>
					<FieldLabel htmlFor={nameId}>{t("archiveCompressNameLabel")}</FieldLabel>
					<div className="flex items-center gap-2">
						<Input
							id={nameId}
							value={state.base}
							autoComplete="off"
							spellCheck={false}
							aria-invalid={nameError !== null ? true : undefined}
							aria-describedby={nameError !== null ? `${extensionId} ${nameId}-error` : extensionId}
							className="flex-1"
							onChange={e => {
								dispatch({ type: "setBase", value: e.target.value })
							}}
						/>
						<span
							id={extensionId}
							className="shrink-0 text-sm text-muted-foreground"
						>
							{info?.extension ?? choice.displayExtension}
						</span>
					</div>
					{nameError !== null ? <FieldError id={`${nameId}-error`}>{nameError}</FieldError> : null}
				</Field>
				<Field data-invalid={errors.format !== undefined ? true : undefined}>
					<FieldLabel htmlFor={formatId}>{t("archiveCompressFormatLabel")}</FieldLabel>
					<ArchiveFormatSelect
						id={formatId}
						value={state.choice}
						choices={choices}
						invalid={errors.format !== undefined}
						isRunnable={candidate => {
							const candidateInfo = infoFor(candidate, methodOf({ ...state, choice: candidate }))

							return candidateInfo !== undefined && isFormatRunnable(candidateInfo)
						}}
						onChange={next => {
							dispatch({ type: "setChoice", choice: next })
						}}
					/>
					{errors.format !== undefined ? (
						<FieldError>
							{t(errors.format === "needsOneFile" ? "archiveSingleNeedsOneFile" : "archiveFormatUnavailable")}
						</FieldError>
					) : null}
				</Field>
				<DestinationField
					label={t("archiveSaveInLabel")}
					destination={state.destination}
					sources={items}
					pickLabels={{ title: t("archiveCompressPickTitle"), confirm: t("archiveCompressPickConfirm") }}
					onChange={destination => {
						dispatch({ type: "setDestination", destination })
					}}
				/>
				{!levelsShown ? (
					<Field>
						<FieldLabel>{t("archiveLevelLabel")}</FieldLabel>
						<FieldDescription>{t("archiveLevelNone")}</FieldDescription>
					</Field>
				) : info?.levels !== undefined && info.levels !== null && info.maxLevel !== null ? (
					<ArchiveLevelField
						probe={probeFormat(state.choice, method ?? undefined)}
						levels={info.levels}
						maxLevel={info.maxLevel}
						value={effectiveLevel(info, state.levels[state.choice] ?? null) ?? info.levels.min}
						budget={budget}
						onChange={level => {
							dispatch({ type: "setLevel", level })
						}}
					/>
				) : null}
				<Field orientation="horizontal">
					<FieldContent>
						<FieldLabel htmlFor={protectId}>{t("archiveProtectLabel")}</FieldLabel>
						{!choice.encryptable ? <FieldDescription>{t("archiveProtectUnsupported")}</FieldDescription> : null}
					</FieldContent>
					<Switch
						id={protectId}
						checked={encrypted}
						disabled={!choice.encryptable}
						onCheckedChange={checked => {
							dispatch({ type: "setProtect", value: checked })
						}}
					/>
				</Field>
				{encrypted ? (
					<>
						<Field data-invalid={passwordError !== null ? true : undefined}>
							<FieldLabel htmlFor={passwordId}>{t("archivePasswordLabel")}</FieldLabel>
							<ArchivePasswordInput
								id={passwordId}
								revealed={state.reveal}
								revealControls={`${passwordId} ${confirmId}`}
								value={state.password}
								aria-invalid={passwordError !== null ? true : undefined}
								aria-describedby={passwordError !== null ? `${passwordId}-error` : undefined}
								onRevealedChange={() => {
									dispatch({ type: "toggleReveal" })
								}}
								onChange={e => {
									dispatch({ type: "setPassword", value: e.target.value })
								}}
							/>
							{passwordError !== null ? <FieldError id={`${passwordId}-error`}>{passwordError}</FieldError> : null}
						</Field>
						<Field data-invalid={errors.confirm !== undefined ? true : undefined}>
							<FieldLabel htmlFor={confirmId}>{t("archivePasswordConfirmLabel")}</FieldLabel>
							<SecretInput
								id={confirmId}
								revealed={state.reveal}
								value={state.confirm}
								aria-invalid={errors.confirm !== undefined ? true : undefined}
								aria-describedby={errors.confirm !== undefined ? `${confirmId}-error` : undefined}
								onChange={e => {
									dispatch({ type: "setConfirm", value: e.target.value })
								}}
							/>
							{errors.confirm !== undefined ? (
								<FieldError id={`${confirmId}-error`}>{t("archivePasswordMismatch")}</FieldError>
							) : null}
						</Field>
						{choice.family === "sevenZ" ? (
							<Field orientation="horizontal">
								<FieldContent>
									<FieldLabel htmlFor={encryptNamesId}>{t("archiveEncryptNames")}</FieldLabel>
								</FieldContent>
								<Switch
									id={encryptNamesId}
									checked={state.encryptNames}
									onCheckedChange={checked => {
										dispatch({ type: "setEncryptNames", value: checked })
									}}
								/>
							</Field>
						) : null}
					</>
				) : null}
				{disposeAllowed ? (
					<AfterwardsField
						kind="compress"
						value={state.afterwards}
						onChange={value => {
							dispatch({ type: "setAfterwards", value })
						}}
					/>
				) : null}
				{advancedShown ? (
					<Collapsible
						open={state.advancedOpen}
						onOpenChange={() => {
							dispatch({ type: "toggleAdvanced" })
						}}
					>
						<CollapsibleTrigger
							render={
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="-ml-3"
								/>
							}
						>
							{t("archiveAdvanced")}
							<ChevronDownIcon
								data-icon="inline-end"
								className={cn("transition-transform", state.advancedOpen && "rotate-180")}
							/>
						</CollapsibleTrigger>
						<CollapsibleContent>
							<FieldGroup className="pt-4">
								<Field>
									<FieldLabel htmlFor={methodId}>{t("archiveMethodLabel")}</FieldLabel>
									{choice.family === "zip" ? (
										<MethodSelect
											id={methodId}
											value={state.zipMethod}
											methods={ZIP_METHODS}
											onChange={next => {
												dispatch({ type: "setZipMethod", method: next })
											}}
										/>
									) : (
										<MethodSelect
											id={methodId}
											value={state.sevenZMethod}
											methods={SEVENZ_METHODS}
											onChange={next => {
												dispatch({ type: "setSevenZMethod", method: next })
											}}
										/>
									)}
								</Field>
								{choice.family === "sevenZ" && state.sevenZMethod !== "copy" ? (
									<Field orientation="horizontal">
										<FieldContent>
											<FieldLabel htmlFor={solidId}>{t("archiveSolidLabel")}</FieldLabel>
											<FieldDescription>{t("archiveSolidHint")}</FieldDescription>
										</FieldContent>
										<Switch
											id={solidId}
											checked={state.solid}
											onCheckedChange={checked => {
												dispatch({ type: "setSolid", value: checked })
											}}
										/>
									</Field>
								) : null}
								{choice.family === "zip" && encrypted ? (
									<Field>
										<FieldLabel htmlFor={aesId}>{t("archiveAesLabel")}</FieldLabel>
										<Select
											items={AES_STRENGTHS.map(strength => ({ value: strength, label: t(AES_LABEL_KEYS[strength]) }))}
											value={state.aes}
											onValueChange={next => {
												const strength = AES_STRENGTHS.find(candidate => candidate === next)

												if (strength !== undefined) {
													dispatch({ type: "setAes", value: strength })
												}
											}}
										>
											<SelectTrigger
												id={aesId}
												className="w-full"
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectGroup>
													{AES_STRENGTHS.map(strength => (
														<SelectItem
															key={strength}
															value={strength}
														>
															{t(AES_LABEL_KEYS[strength])}
														</SelectItem>
													))}
												</SelectGroup>
											</SelectContent>
										</Select>
									</Field>
								) : null}
							</FieldGroup>
						</CollapsibleContent>
					</Collapsible>
				) : null}
			</FieldGroup>
			<ConfirmDialog
				open={state.step === "confirmDelete"}
				pending={false}
				destructive
				title={t("archiveDeleteConfirmTitle")}
				body={
					encrypted
						? `${t("archiveDeleteConfirmBodyCompress", { count: items.length })} ${t("archiveDeleteConfirmPasswordNote")}`
						: t("archiveDeleteConfirmBodyCompress", { count: items.length })
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

interface MethodSelectProps<M extends ZipMethodId | SevenZMethodId> {
	id: string
	value: M
	methods: readonly M[]
	onChange: (method: M) => void
}

function MethodSelect<M extends ZipMethodId | SevenZMethodId>({ id, value, methods, onChange }: MethodSelectProps<M>) {
	const { t } = useTranslation("archive")

	return (
		<Select
			items={methods.map(method => ({ value: method, label: t(METHOD_LABEL_KEYS[method]) }))}
			value={value}
			onValueChange={next => {
				const method = methods.find(candidate => candidate === next)

				if (method !== undefined) {
					onChange(method)
				}
			}}
		>
			<SelectTrigger
				id={id}
				className="w-full"
			>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectGroup>
					{methods.map(method => (
						<SelectItem
							key={method}
							value={method}
						>
							{t(METHOD_LABEL_KEYS[method])}
						</SelectItem>
					))}
				</SelectGroup>
			</SelectContent>
		</Select>
	)
}
