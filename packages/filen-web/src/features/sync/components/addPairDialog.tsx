import { useEffect, useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { FolderIcon } from "lucide-react"
import type { DesktopSyncMode, DesktopSyncPlan } from "@filen/shared/desktop"
import { cn } from "@filen/shared"
import { useAccountQuery } from "@/queries/account"
import { log } from "@/lib/log"
import { useDirectoryPicker } from "@/features/drive/hooks/useDirectoryPicker"
import { LIST_DIALOG_CLASS } from "@/components/dialogs/listDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { SURFACE_RING } from "@/components/ui/surface"
import { syncApi } from "@/features/sync/lib/syncStore"
import { syncErrorLabel } from "@/features/sync/lib/syncActions"
import { ROOT_WARNING_KEY } from "@/features/sync/lib/syncErrors.logic"
import { MODE_DESCRIPTION_KEY, MODE_KEY, MODES } from "@/features/sync/lib/syncStatus.logic"
import {
	ADD_PAIR_STEPS,
	addPairRequest,
	canAdvance,
	INITIAL_ADD_PAIR_FORM,
	localChoiceOutcome,
	nextStep,
	previousStep,
	remotePick,
	withLocalChoice,
	type AddPairForm,
	type AddPairStep
} from "@/features/sync/components/addPairDialog.logic"
import { RemoteDirectoryChooser } from "@/features/sync/components/remoteDirectoryChooser"
import { ReviewSummary } from "@/features/sync/components/reviewCard"
import { DesktopCallout } from "@/features/desktop/components/desktopCallout"

type Busy = "choosing" | "adding" | "starting" | "removing" | null

// The pair addPair created, paused, with its dry run; until it is started, closing the dialog removes it.
interface AddedPair {
	pairId: string
	plan: DesktopSyncPlan | null
}

const STEP_TITLE: Record<AddPairStep, "addLocalTitle" | "addRemoteTitle" | "addModeTitle" | "addNameTitle"> = {
	local: "addLocalTitle",
	remote: "addRemoteTitle",
	mode: "addModeTitle",
	name: "addNameTitle"
}

const STEP_DESCRIPTION: Record<AddPairStep, "addLocalDescription" | "addRemoteDescription" | "addModeDescription" | "addNameDescription"> =
	{
		local: "addLocalDescription",
		remote: "addRemoteDescription",
		mode: "addModeDescription",
		name: "addNameDescription"
	}

function releasePlan(plan: DesktopSyncPlan | null): void {
	if (plan !== null) {
		syncApi()
			.releasePlan(plan.planId)
			.catch((error: unknown) => {
				log.warn("sync", "plan could not be released", error)
			})
	}
}

// Removes a pair the user never started. Its files stay on both sides.
async function discardPair(added: AddedPair): Promise<void> {
	releasePlan(added.plan)

	try {
		const result = await syncApi().removePair(added.pairId)

		if (!result.ok) {
			toast.error(syncErrorLabel(result.error))
		}
	} catch (error) {
		log.warn("sync", "unstarted pair could not be removed", error)
	}
}

// The add-pair flow: local directory (chosen in main's own dialog; a refusal blocks, cloud-app warnings do not)
// → remote directory → mode → name → addPair, which adds the pair paused and dry-runs it → the review, where
// Start starts it and closing removes it again.
export function AddPairDialog({ onClose }: { onClose: () => void }) {
	const { t } = useTranslation(["sync", "common"])
	const navigate = useNavigate()
	const id = useId()
	const accountRoot = useAccountQuery().data?.rootDirUuid
	const picker = useDirectoryPicker()
	const [step, setStep] = useState<AddPairStep>("local")
	const [fields, setFields] = useState<Omit<AddPairForm, "remote">>(INITIAL_ADD_PAIR_FORM)
	const [refusal, setRefusal] = useState<{ path: string; message: string } | null>(null)
	const [addError, setAddError] = useState<string | null>(null)
	const [busy, setBusy] = useState<Busy>(null)
	const [added, setAdded] = useState<AddedPair | null>(null)
	// The unstarted pair, for the unmount cleanup: leaving the Sync section must not leave it behind, paused.
	const unstartedRef = useRef<AddedPair | null>(null)
	const remote = remotePick(picker.targetUuid, accountRoot)
	const form: AddPairForm = { ...fields, remote }
	const remoteName = remote === null ? null : (picker.namesQuery.data?.[remote] ?? null)

	useEffect(() => {
		return () => {
			const unstarted = unstartedRef.current

			if (unstarted !== null) {
				unstartedRef.current = null
				void discardPair(unstarted)
			}
		}
	}, [])

	async function close(): Promise<void> {
		const unstarted = unstartedRef.current

		if (unstarted !== null) {
			setBusy("removing")
			unstartedRef.current = null
			await discardPair(unstarted)
		}

		onClose()
	}

	async function chooseLocal(): Promise<void> {
		setBusy("choosing")

		try {
			const outcome = localChoiceOutcome(await syncApi().chooseLocalDirectory())

			if (outcome.kind === "refused") {
				setRefusal({ path: outcome.path, message: t(outcome.key) })
				setFields(previous => ({ ...previous, local: null }))
			} else if (outcome.kind === "ok") {
				setRefusal(null)
				setAddError(null)
				setFields(previous => {
					const next = withLocalChoice({ ...previous, remote: null }, outcome.choice)

					return { local: next.local, mode: next.mode, name: next.name }
				})
			}
		} catch (error) {
			log.warn("sync", "local directory could not be chosen", error)
			toast.error(t("errorUnknown"))
		} finally {
			setBusy(null)
		}
	}

	async function create(): Promise<void> {
		const request = addPairRequest(form)

		if (request === null) {
			return
		}

		setBusy("adding")
		setAddError(null)

		try {
			const result = await syncApi().addPair(request)

			if (result.ok) {
				unstartedRef.current = result.value
				setAdded(result.value)
			} else {
				// The shell spends the chosen directory's id on every attempt, so it has to be chosen again.
				setAddError(syncErrorLabel(result.error))
				setFields(previous => ({ ...previous, local: null }))
				setStep("local")
			}
		} catch (error) {
			log.warn("sync", "pair could not be added", error)
			setAddError(t("errorUnknown"))
			setFields(previous => ({ ...previous, local: null }))
			setStep("local")
		} finally {
			setBusy(null)
		}
	}

	async function start(): Promise<void> {
		if (added === null) {
			return
		}

		setBusy("starting")

		try {
			const result = await syncApi().startPair(added.pairId)

			if (!result.ok) {
				toast.error(syncErrorLabel(result.error))

				return
			}

			unstartedRef.current = null
			releasePlan(added.plan)
			toast.success(t("addStarted"))
			onClose()
			void navigate({ to: "/sync/$pairId", params: { pairId: added.pairId } })
		} catch (error) {
			log.warn("sync", "pair could not be started", error)
			toast.error(t("errorUnknown"))
		} finally {
			setBusy(null)
		}
	}

	const stepIndex = ADD_PAIR_STEPS.indexOf(step)
	const back = previousStep(step)
	const forward = nextStep(step)

	function renderStep() {
		switch (step) {
			case "local": {
				const warnings = fields.local === null ? [] : fields.local.warnings

				return (
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
						{fields.local === null ? null : (
							<div
								className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5", SURFACE_RING)}
								title={fields.local.path}
							>
								<FolderIcon
									aria-hidden="true"
									className="size-4 shrink-0 text-muted-foreground"
								/>
								<span className="min-w-0 flex-1 truncate text-sm">{fields.local.path}</span>
							</div>
						)}
						<Button
							variant={fields.local === null ? "default" : "outline"}
							className="self-start"
							disabled={busy !== null}
							onClick={() => {
								void chooseLocal()
							}}
						>
							{busy === "choosing" ? <Spinner data-icon="inline-start" /> : null}
							{fields.local === null ? t("addChooseLocal") : t("addChooseOtherLocal")}
						</Button>
						{refusal === null ? null : (
							<DesktopCallout tone="error">
								<span className="block truncate font-medium">{refusal.path}</span>
								{refusal.message}
							</DesktopCallout>
						)}
						{addError === null ? null : <DesktopCallout tone="error">{addError}</DesktopCallout>}
						{warnings.map(warning => (
							<DesktopCallout
								key={warning}
								tone="warning"
							>
								{t(ROOT_WARNING_KEY[warning])}
							</DesktopCallout>
						))}
					</div>
				)
			}
			case "remote":
				return (
					<>
						<RemoteDirectoryChooser
							picker={picker}
							disabled={busy !== null}
						/>
						<p className="text-xs text-muted-foreground">
							{remote === null ? t("addRemoteRootHint") : t("addRemotePick", { name: remoteName ?? "…" })}
						</p>
					</>
				)
			case "mode":
				return (
					<RadioGroup
						aria-label={t("addModeTitle")}
						name={`${id}-mode`}
						value={fields.mode}
						className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto"
						onValueChange={(next: unknown) => {
							const mode = MODES.find(candidate => candidate === next)

							if (mode !== undefined) {
								setFields(previous => ({ ...previous, mode }))
							}
						}}
					>
						{MODES.map((mode: DesktopSyncMode) => (
							<label
								key={mode}
								htmlFor={`${id}-${mode}`}
								className={cn(
									"flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted/60",
									fields.mode === mode && "bg-muted"
								)}
							>
								<RadioGroupItem
									id={`${id}-${mode}`}
									value={mode}
									className="mt-0.5"
								/>
								<span className="flex min-w-0 flex-col gap-0.5">
									<span className="text-sm font-medium">{t(MODE_KEY[mode])}</span>
									<span className="text-sm text-muted-foreground">{t(MODE_DESCRIPTION_KEY[mode])}</span>
								</span>
							</label>
						))}
					</RadioGroup>
				)
			case "name":
				return (
					<div className="flex flex-col gap-2">
						<Label htmlFor={`${id}-name`}>{t("addNameTitle")}</Label>
						<Input
							id={`${id}-name`}
							value={fields.name}
							maxLength={255}
							autoFocus
							disabled={busy !== null}
							className="leading-5"
							onChange={event => {
								const name = event.target.value

								setFields(previous => ({ ...previous, name }))
							}}
							onKeyDown={event => {
								if (event.key === "Enter" && canAdvance("name", form) && busy === null) {
									event.preventDefault()
									void create()
								}
							}}
						/>
					</div>
				)
		}
	}

	return (
		<Dialog
			open
			// pendingGuardedOpenChange's gate, inline: close() reads the unstarted-pair ref, so it may only run from
			// the event, never be handed to a call made during render.
			onOpenChange={(next, details) => {
				if (next) {
					return
				}

				if (busy !== null) {
					details.cancel()

					return
				}

				void close()
			}}
		>
			<DialogContent
				closeButtonDisabled={busy !== null}
				className={LIST_DIALOG_CLASS}
			>
				{added === null ? (
					<>
						<DialogHeader>
							<p className="text-xs font-medium text-muted-foreground">
								{t("syncAddPair")} · {t("addStep", { step: stepIndex + 1, total: ADD_PAIR_STEPS.length })}
							</p>
							<DialogTitle>{t(STEP_TITLE[step])}</DialogTitle>
							<DialogDescription>{t(STEP_DESCRIPTION[step])}</DialogDescription>
						</DialogHeader>
						{renderStep()}
						<DialogFooter className="mt-auto">
							{back === null ? null : (
								<Button
									variant="outline"
									disabled={busy !== null}
									onClick={() => {
										setStep(back)
									}}
								>
									{t("addBack")}
								</Button>
							)}
							{forward === null ? (
								<Button
									disabled={busy !== null || !canAdvance(step, form)}
									onClick={() => {
										void create()
									}}
								>
									{busy === "adding" ? <Spinner data-icon="inline-start" /> : null}
									{t("addCreate")}
								</Button>
							) : (
								<Button
									disabled={busy !== null || !canAdvance(step, form)}
									onClick={() => {
										setStep(forward)
									}}
								>
									{t("addNext")}
								</Button>
							)}
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader>
							<DialogTitle>{t("reviewTitleNew")}</DialogTitle>
							<DialogDescription>{t("reviewDescriptionNew")}</DialogDescription>
						</DialogHeader>
						<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
							<ReviewSummary
								summary={added.plan?.summary ?? null}
								findings={[]}
								planId={added.plan?.planId ?? null}
							/>
						</div>
						<DialogFooter className="mt-auto">
							<Button
								variant="outline"
								disabled={busy !== null}
								onClick={() => {
									void close()
								}}
							>
								{busy === "removing" ? <Spinner data-icon="inline-start" /> : null}
								{t("reviewRemove")}
							</Button>
							<Button
								disabled={busy !== null}
								onClick={() => {
									void start()
								}}
							>
								{busy === "starting" ? <Spinner data-icon="inline-start" /> : null}
								{t("reviewStart")}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	)
}
