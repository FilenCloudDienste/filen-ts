import { useTranslation } from "react-i18next"
import { ClipboardCopyIcon, ScissorsIcon, SparklesIcon } from "lucide-react"
import type { TransformLanguage } from "@filen/shared/assistant"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { recentTransformLanguages, TRANSFORM_LANGUAGE_CODES, uiTransformLanguage } from "@/features/assistant/transform/transform.logic"
import { noteTransformLanguage, useRecentTransformLanguages } from "@/features/assistant/transform/recentLanguages"
import {
	DROPDOWN_PARTS,
	TRANSFORM_KIND_LABELS,
	useTransformLanguageName,
	type TransformMenuParts,
	type TransformPick
} from "@/features/assistant/transform/transformMenuParts"

// The rewrite menu: Rewrite, Shorten, Fix grammar, Translate ▸ (the recently used languages, then all of them). The
// same entries in a menu of their own (the button beside a selection, the shortcut, a right click in a note or the
// composer) and inside the Word document editor's context menu.

const PLAIN_KINDS = ["rewrite", "shorten", "fix_grammar"] as const

export function TransformMenuEntries({ parts, onPick }: { parts: TransformMenuParts; onPick: (pick: TransformPick) => void }) {
	const { t, i18n } = useTranslation("assistant")
	const languageName = useTransformLanguageName()
	const ui = uiTransformLanguage(i18n.language)
	const recent = recentTransformLanguages(useRecentTransformLanguages(), ui)
	const { Item, Sub, SubTrigger, SubContent, Separator } = parts
	const translate = (language: TransformLanguage) => {
		noteTransformLanguage(language)
		onPick({ kind: "translate", language })
	}

	return (
		<>
			{PLAIN_KINDS.map(kind => (
				<Item
					key={kind}
					onClick={() => {
						onPick({ kind, language: ui })
					}}
				>
					{t(TRANSFORM_KIND_LABELS[kind])}
				</Item>
			))}
			<Sub>
				<SubTrigger>{t("assistantTransformTranslate")}</SubTrigger>
				<SubContent>
					{recent.map(language => (
						<Item
							key={language}
							onClick={() => {
								translate(language)
							}}
						>
							{languageName(language)}
						</Item>
					))}
					<Separator />
					<Sub>
						<SubTrigger>{t("assistantTransformAllLanguages")}</SubTrigger>
						<SubContent>
							{TRANSFORM_LANGUAGE_CODES.map(language => (
								<Item
									key={language}
									onClick={() => {
										translate(language)
									}}
								>
									{languageName(language)}
								</Item>
							))}
						</SubContent>
					</Sub>
				</SubContent>
			</Sub>
		</>
	)
}

// The entry a context menu opens the entries from: "✨ Rewrite with assistant ▸".
export function TransformSubmenu({ parts, onPick }: { parts: TransformMenuParts; onPick: (pick: TransformPick) => void }) {
	const { t } = useTranslation("assistant")
	const { Sub, SubTrigger, SubContent } = parts

	return (
		<Sub>
			<SubTrigger>
				<SparklesIcon aria-hidden="true" />
				{t("assistantTransformOpen")}
			</SubTrigger>
			<SubContent>
				<TransformMenuEntries
					parts={parts}
					onPick={onPick}
				/>
			</SubContent>
		</Sub>
	)
}

// The menu at a point: the button beside the selection, the shortcut, a right click (`clipboard`: Cut and Copy too, as
// the browser's menu it stands in for had them).
export function TransformMenu({
	anchor,
	onPick,
	onClose,
	clipboard
}: {
	anchor: { getBoundingClientRect: () => DOMRect }
	onPick: (pick: TransformPick) => void
	onClose: () => void
	clipboard?: { cut: (() => void) | null; copy: () => void }
}) {
	const { t } = useTranslation("assistant")

	return (
		<DropdownMenu
			open
			onOpenChange={open => {
				if (!open) {
					onClose()
				}
			}}
		>
			<DropdownMenuContent
				anchor={anchor}
				aria-label={t("assistantTransformOpen")}
			>
				{clipboard === undefined ? (
					<TransformMenuEntries
						parts={DROPDOWN_PARTS}
						onPick={onPick}
					/>
				) : (
					<>
						<TransformSubmenu
							parts={DROPDOWN_PARTS}
							onPick={onPick}
						/>
						<DropdownMenuSeparator />
						{clipboard.cut === null ? null : (
							<DropdownMenuItem onClick={clipboard.cut}>
								<ScissorsIcon aria-hidden="true" />
								{t("assistantTransformCut")}
							</DropdownMenuItem>
						)}
						<DropdownMenuItem onClick={clipboard.copy}>
							<ClipboardCopyIcon aria-hidden="true" />
							{t("assistantTransformCopy")}
						</DropdownMenuItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
