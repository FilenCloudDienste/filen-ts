import { useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { CopyIcon, LinkIcon } from "lucide-react"
import type { DialogRoot } from "@base-ui/react/dialog"
import type { PublicLinkExpiration } from "@filen/sdk-rs"
import type { DriveItem } from "@/features/drive/lib/item"
import { createLink, disableLink, updateLink } from "@/features/drive/lib/actions"
import { useDriveItemLinkStatusQuery, type DriveItemLinkStatus } from "@/features/drive/queries/drive"
import { buildLinkUpdate, buildPublicLinkUrl, readLinkForm, type LinkFormEdits } from "@/features/drive/components/linkDialog.logic"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { asErrorDTO } from "@/lib/sdk/errors"
import { useIsOnline } from "@/lib/useIsOnline"
import type { DriveKey } from "@/lib/i18n"
import { shouldForwardOpenChange } from "@/components/dialogs/dismissal.logic"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export interface LinkDialogProps {
	item: DriveItem
	onClose: () => void
}

// Fixed 8-value enum -> a select (module scope: a genuinely static list, mirrors colorDialog.tsx's
// own SWATCHES constant).
const EXPIRATION_OPTIONS: { value: PublicLinkExpiration; labelKey: DriveKey }[] = [
	{ value: "never", labelKey: "driveLinkExpirationNever" },
	{ value: "1h", labelKey: "driveLinkExpirationOneHour" },
	{ value: "6h", labelKey: "driveLinkExpirationSixHours" },
	{ value: "1d", labelKey: "driveLinkExpirationOneDay" },
	{ value: "3d", labelKey: "driveLinkExpirationThreeDays" },
	{ value: "7d", labelKey: "driveLinkExpirationOneWeek" },
	{ value: "14d", labelKey: "driveLinkExpirationTwoWeeks" },
	{ value: "30d", labelKey: "driveLinkExpirationThirtyDays" }
]

// Public-link management panel — mounted-when-active by the listing's dialog host. Handles BOTH item
// types in one component (unlike color/versions, which are type-specific): status-check first
// (no link yet vs. an existing one to configure), each field edit applies immediately (no batched
// "save" step, matching color-dialog's immediate-apply convention rather than the mobile screen's
// staged-edit-then-header-checkmark one — this is a modal, not a full screen with its own header
// action slot). A single shared `pending` flag gates the whole form during any in-flight write,
// rather than one per field: two concurrent updates would both read the same stale status and the
// second to resolve would silently clobber the first's change.
export function LinkDialog({ item, onClose }: LinkDialogProps) {
	const { t } = useTranslation(["drive", "common"])
	const linkStatusQuery = useDriveItemLinkStatusQuery(item)
	const isOnline = useIsOnline()
	const [pending, setPending] = useState(false)
	const [createProgress, setCreateProgress] = useState<{ downloaded: number; total: number | undefined } | null>(null)
	const [passwordEditing, setPasswordEditing] = useState(false)
	const [passwordDraft, setPasswordDraft] = useState("")

	function handleOpenChange(next: boolean, details: DialogRoot.ChangeEventDetails): void {
		if (!shouldForwardOpenChange(next, pending)) {
			// Also stops Base UI's own store from flipping (it closes itself after this callback
			// unless the event is canceled) — see dismissal.logic.ts.
			details.cancel()
			return
		}

		if (!next) {
			onClose()
		}
	}

	async function handleCreate(): Promise<void> {
		setPending(true)
		setCreateProgress(null)
		const outcome = await createLink(item, (downloaded, total) => {
			setCreateProgress({ downloaded, total })
		})
		setPending(false)
		setCreateProgress(null)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
		// createLink already patched the link-status cache on success — this component re-renders
		// into the config-form branch via that query's own observer, nothing further to do here.
	}

	async function handleUpdate(current: DriveItemLinkStatus, edits: LinkFormEdits): Promise<void> {
		setPending(true)
		const outcome = await updateLink(item, buildLinkUpdate(current, edits))
		setPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleSavePassword(current: DriveItemLinkStatus): Promise<void> {
		const plaintext = passwordDraft.trim()

		if (plaintext.length === 0) {
			return
		}

		await handleUpdate(current, { password: { kind: "new", plaintext } })
		setPasswordEditing(false)
		setPasswordDraft("")
	}

	async function handleDisable(current: DriveItemLinkStatus): Promise<void> {
		setPending(true)
		const outcome = await disableLink(item, current)
		setPending(false)

		if (outcome.status === "error") {
			toast.error(errorLabel(outcome.dto))
		}
	}

	async function handleCopy(url: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(url)
			toast.success(t("driveLinkUrlCopiedToast"))
		} catch (e) {
			toast.error(errorLabel(asErrorDTO(e)))
		}
	}

	const current = linkStatusQuery.status === "success" ? linkStatusQuery.data : undefined
	const form = current ? readLinkForm(current.status) : null
	const url = current ? buildPublicLinkUrl(item, current) : null
	const createProgressPercent =
		createProgress?.total !== undefined && createProgress.total > 0
			? Math.round((createProgress.downloaded / createProgress.total) * 100)
			: null

	return (
		<Dialog
			open
			onOpenChange={handleOpenChange}
		>
			<DialogContent closeButtonDisabled={pending}>
				<DialogHeader>
					<DialogTitle>{t("driveLinkDialogTitle")}</DialogTitle>
				</DialogHeader>
				{linkStatusQuery.status === "pending" ? (
					<div className="flex justify-center py-8">
						<Spinner />
					</div>
				) : linkStatusQuery.status === "error" ? (
					<p className="text-sm text-destructive">{errorLabel(asErrorDTO(linkStatusQuery.error))}</p>
				) : current === null ? (
					<Empty className="p-6">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<LinkIcon />
							</EmptyMedia>
							<EmptyTitle>{t("driveLinkNoLinkTitle")}</EmptyTitle>
							<EmptyDescription>{t("driveLinkNoLinkDescription")}</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button
								disabled={pending || !isOnline}
								onClick={() => {
									void handleCreate()
								}}
							>
								{pending && <Spinner data-icon="inline-start" />}
								{t("driveLinkEnableAction")}
							</Button>
							{createProgressPercent !== null ? (
								<p className="text-xs text-muted-foreground">
									{t("driveLinkCreatingProgress", { percent: createProgressPercent })}
								</p>
							) : null}
						</EmptyContent>
					</Empty>
				) : current && form ? (
					<FieldGroup>
						<Field orientation="horizontal">
							<FieldContent>
								<FieldLabel htmlFor="link-downloadable">{t("driveLinkDownloadableLabel")}</FieldLabel>
							</FieldContent>
							<Switch
								id="link-downloadable"
								checked={form.downloadEnabled}
								disabled={pending || !isOnline}
								onCheckedChange={checked => {
									void handleUpdate(current, { downloadEnabled: checked })
								}}
							/>
						</Field>
						<Field>
							<FieldLabel htmlFor="link-expiration">{t("driveLinkExpirationLabel")}</FieldLabel>
							<Select
								items={EXPIRATION_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) }))}
								value={form.expiration}
								disabled={pending || !isOnline}
								onValueChange={value => {
									// The select is never rendered with a null/placeholder entry (EXPIRATION_OPTIONS
									// covers every PublicLinkExpiration value), so a null callback value can't occur
									// in practice — the check exists only to satisfy Select's general-purpose type,
									// which allows "no selection" for the cases that do use a placeholder.
									if (value !== null) {
										void handleUpdate(current, { expiration: value })
									}
								}}
							>
								<SelectTrigger id="link-expiration">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectGroup>
										{EXPIRATION_OPTIONS.map(option => (
											<SelectItem
												key={option.value}
												value={option.value}
											>
												{t(option.labelKey)}
											</SelectItem>
										))}
									</SelectGroup>
								</SelectContent>
							</Select>
						</Field>
						<Field>
							<FieldLabel>{t("driveLinkPasswordLabel")}</FieldLabel>
							{passwordEditing ? (
								<div className="flex items-center gap-2">
									<Input
										type="password"
										autoFocus
										value={passwordDraft}
										disabled={pending || !isOnline}
										placeholder={t("driveLinkPasswordPlaceholder")}
										className="flex-1"
										onChange={e => {
											setPasswordDraft(e.target.value)
										}}
									/>
									<Button
										size="sm"
										disabled={pending || !isOnline || passwordDraft.trim().length === 0}
										onClick={() => {
											void handleSavePassword(current)
										}}
									>
										{pending && <Spinner data-icon="inline-start" />}
										{t("driveLinkPasswordSaveAction")}
									</Button>
									<Button
										size="sm"
										variant="ghost"
										disabled={pending || !isOnline}
										onClick={() => {
											setPasswordEditing(false)
											setPasswordDraft("")
										}}
									>
										{t("common:cancel")}
									</Button>
								</div>
							) : (
								<div className="flex items-center gap-2">
									<span className="text-sm text-muted-foreground">
										{form.passwordSet ? t("driveLinkPasswordSetStatus") : t("driveLinkPasswordPlaceholder")}
									</span>
									<Button
										size="sm"
										variant="outline"
										disabled={pending || !isOnline}
										onClick={() => {
											setPasswordEditing(true)
										}}
									>
										{form.passwordSet ? t("driveLinkPasswordChangeAction") : t("driveLinkPasswordSetAction")}
									</Button>
									{form.passwordSet ? (
										<Button
											size="sm"
											variant="ghost"
											disabled={pending || !isOnline}
											onClick={() => {
												void handleUpdate(current, { password: { kind: "cleared" } })
											}}
										>
											{t("driveLinkPasswordRemoveAction")}
										</Button>
									) : null}
								</div>
							)}
						</Field>
						<Field>
							<FieldLabel htmlFor="link-url">{t("driveLinkUrlLabel")}</FieldLabel>
							<div className="flex items-center gap-2">
								<Input
									id="link-url"
									readOnly
									value={url ?? ""}
									className="flex-1"
								/>
								<Button
									type="button"
									variant="outline"
									size="icon"
									disabled={url === null}
									aria-label={t("driveActionCopyLink")}
									onClick={() => {
										if (url !== null) {
											void handleCopy(url)
										}
									}}
								>
									<CopyIcon />
								</Button>
							</div>
						</Field>
					</FieldGroup>
				) : null}
				{current ? (
					<DialogFooter>
						<Button
							variant="destructive"
							disabled={pending || !isOnline}
							onClick={() => {
								void handleDisable(current)
							}}
						>
							{pending && <Spinner data-icon="inline-start" />}
							{t("driveLinkDisableAction")}
						</Button>
					</DialogFooter>
				) : null}
			</DialogContent>
		</Dialog>
	)
}
