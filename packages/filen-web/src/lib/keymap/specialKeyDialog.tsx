import { useState } from "react"
import { useTranslation } from "react-i18next"
import { formatChord, keyLabel } from "@filen/shared/keymap"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"

const IS_MAC = isMacPlatform()

// Keys the recorder cannot take (Escape is its cancel key, Tab moves focus) or that are awkward to press on purpose.
const SPECIAL_KEYS = [
	"escape",
	"tab",
	"enter",
	"space",
	"backspace",
	"delete",
	"insert",
	"home",
	"end",
	"pageup",
	"pagedown",
	"arrowup",
	"arrowdown",
	"arrowleft",
	"arrowright",
	"contextmenu",
	...Array.from({ length: 12 }, (_, index) => `f${String(index + 1)}`)
] as const

type Modifier = "mod" | "ctrl" | "alt" | "shift"

// On a Mac Mod is Command and Control is its own key; elsewhere Mod is Control.
const MODIFIERS: readonly Modifier[] = IS_MAC ? ["ctrl", "alt", "shift", "mod"] : ["mod", "alt", "shift"]

// The special keys picker: a key from a list and the modifiers held with it, for keys the recorder cannot take and
// for anyone who would rather pick keys than press them (a screen reader in browse mode hands keys to itself).
export function SpecialKeyDialog({
	actionName,
	open,
	onOpenChange,
	onAdd
}: {
	actionName: string
	open: boolean
	onOpenChange: (open: boolean) => void
	onAdd: (chord: string) => void
}) {
	const { t } = useTranslation("settings")
	const [key, setKey] = useState<string>("escape")
	const [held, setHeld] = useState<ReadonlySet<Modifier>>(new Set())

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("keyboardSpecialTitle")}</DialogTitle>
					<DialogDescription>
						{actionName}. {t("keyboardSpecialDescription")}
					</DialogDescription>
				</DialogHeader>
				<FieldGroup>
					<Field>
						<FieldLabel htmlFor="special-key">{t("keyboardSpecialKey")}</FieldLabel>
						<Select
							items={SPECIAL_KEYS.map(token => ({ value: token, label: keyLabel(token, IS_MAC) }))}
							value={key}
							onValueChange={value => {
								if (value !== null) {
									setKey(value)
								}
							}}
						>
							<SelectTrigger
								id="special-key"
								className="w-full"
							>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{SPECIAL_KEYS.map(token => (
										<SelectItem
											key={token}
											value={token}
										>
											{keyLabel(token, IS_MAC)}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</Field>
					<Field>
						<FieldLabel id="special-modifiers">{t("keyboardSpecialModifiers")}</FieldLabel>
						<div
							role="group"
							aria-labelledby="special-modifiers"
							className="flex flex-wrap gap-1"
						>
							{MODIFIERS.map(modifier => {
								const pressed = held.has(modifier)

								return (
									<Button
										key={modifier}
										type="button"
										variant={pressed ? "secondary" : "outline"}
										size="sm"
										aria-pressed={pressed}
										onClick={() => {
											setHeld(current => {
												const next = new Set(current)

												if (pressed) {
													next.delete(modifier)
												} else {
													next.add(modifier)
												}

												return next
											})
										}}
									>
										{keyLabel(modifier, IS_MAC)}
									</Button>
								)
							})}
						</div>
					</Field>
				</FieldGroup>
				<DialogFooter>
					<Button
						type="button"
						onClick={() => {
							onAdd(
								formatChord({
									mod: held.has("mod"),
									meta: false,
									ctrl: held.has("ctrl"),
									alt: held.has("alt"),
									shift: held.has("shift"),
									key
								})
							)
							setHeld(new Set())
						}}
					>
						{t("keyboardSpecialAdd")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
