import { useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { parseCombo } from "@filen/shared/keymap"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { downloadBlob } from "@/lib/downloadBlob"
import { currentCatalog } from "@/lib/keymap/actions"
import { chordText } from "@/lib/keymap/keyText"
import { useKeyboardLayout } from "@/lib/keymap/layout"
import { currentKeymapRecord, resetOverrides, updateOverrides, useCharacterKeys, useOverrides } from "@/lib/keymap/registry"
import { SHORTCUT_NAMESPACES } from "@/lib/keymap/shortcutsCatalog"
import { KEYMAP_IMPORT_MAX_BYTES, keymapExport, planKeymapImport, type KeymapImportPlan } from "@/lib/keymap/transfer"

// Settings → Keyboard's page actions: export the user's shortcuts to a JSON file, import one (previewed, then merged),
// and reset every shortcut.
export function KeyboardActions() {
	const { t } = useTranslation([...SHORTCUT_NAMESPACES])
	const overrides = useOverrides()
	const characterKeys = useCharacterKeys()
	const layout = useKeyboardLayout()
	const fileRef = useRef<HTMLInputElement>(null)
	const [resetOpen, setResetOpen] = useState(false)
	const [plan, setPlan] = useState<KeymapImportPlan | null>(null)
	const changed = Object.keys(overrides).length > 0

	const comboText = (combo: string): string =>
		combo === ""
			? t("common:shortcutsUnbound")
			: parseCombo(combo)
					.map(chord => chordText(chord, layout))
					.join(" / ")

	const readImport = async (file: File): Promise<void> => {
		const text = file.size > KEYMAP_IMPORT_MAX_BYTES ? "" : await file.text()
		const record = currentKeymapRecord()
		const next = planKeymapImport(text, currentCatalog(record).actions, record)

		if (next === null) {
			toast.error(t("settings:keyboardImportInvalid"))

			return
		}

		setPlan(next)
	}

	return (
		<div className="flex flex-wrap items-center gap-1">
			<Button
				variant="outline"
				size="sm"
				disabled={!changed && characterKeys}
				onClick={() => {
					downloadBlob(
						`${t("settings:keyboardExportFileName")}.json`,
						new Blob([keymapExport(currentKeymapRecord())], { type: "application/json" })
					)
					toast.success(t("settings:keyboardExported"))
				}}
			>
				{t("settings:keyboardExport")}
			</Button>
			<Button
				variant="outline"
				size="sm"
				onClick={() => {
					fileRef.current?.click()
				}}
			>
				{t("settings:keyboardImport")}
			</Button>
			<Button
				variant="outline"
				size="sm"
				disabled={!changed}
				onClick={() => {
					setResetOpen(true)
				}}
			>
				{t("settings:keyboardResetAll")}
			</Button>
			<input
				ref={fileRef}
				type="file"
				accept="application/json,.json"
				className="hidden"
				onChange={event => {
					const file = event.target.files?.[0]

					// Reset, so choosing the same file again fires a change.
					event.target.value = ""

					if (file !== undefined) {
						void readImport(file)
					}
				}}
			/>
			<ConfirmDialog
				open={resetOpen}
				pending={false}
				title={t("settings:keyboardResetAllTitle")}
				body={t("settings:keyboardResetAllBody")}
				confirmLabel={t("settings:keyboardResetAllConfirm")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={setResetOpen}
				onConfirm={() => {
					setResetOpen(false)
					void resetOverrides()
				}}
			/>
			<Dialog
				open={plan !== null}
				onOpenChange={open => {
					if (!open) {
						setPlan(null)
					}
				}}
			>
				<DialogContent className="flex max-h-[85svh] flex-col sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{t("settings:keyboardImportTitle")}</DialogTitle>
						<DialogDescription>
							{plan === null || (plan.changes.length === 0 && plan.characterKeys === undefined)
								? t("settings:keyboardImportNothing")
								: t("settings:keyboardImportBody", { count: plan.changes.length })}
						</DialogDescription>
					</DialogHeader>
					{plan !== null && (
						<div className="flex min-h-0 flex-col gap-2 overflow-y-auto text-sm">
							{plan.characterKeys !== undefined && (
								<p>
									{t("settings:keyboardImportCharacterKeys", {
										state: plan.characterKeys ? t("settings:keyboardOn") : t("settings:keyboardOff")
									})}
								</p>
							)}
							{plan.changes.length > 0 && (
								<ul className="flex flex-col divide-y divide-border/60">
									{plan.changes.map(change => {
										const action = currentCatalog(currentKeymapRecord()).byId.get(change.id)

										return (
											<li
												key={change.id}
												className="flex flex-col gap-0.5 py-1.5"
											>
												<span>{action === undefined ? change.id : t(action.descriptionKey)}</span>
												<span className="text-xs text-muted-foreground">
													{comboText(change.before)} → {comboText(change.after)}
												</span>
											</li>
										)
									})}
								</ul>
							)}
							{plan.skipped > 0 && (
								<p className="text-xs text-muted-foreground">
									{t("settings:keyboardImportUnknown", { count: plan.skipped })}
								</p>
							)}
						</div>
					)}
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								setPlan(null)
							}}
						>
							{t("common:cancel")}
						</Button>
						<Button
							disabled={plan === null || (plan.changes.length === 0 && plan.characterKeys === undefined)}
							onClick={() => {
								if (plan === null) {
									return
								}

								setPlan(null)
								void updateOverrides(plan.overrides, plan.characterKeys).then(() => {
									toast.success(t("settings:keyboardImported"))
								})
							}}
						>
							{t("settings:keyboardImportConfirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}
