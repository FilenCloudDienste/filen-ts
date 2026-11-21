import type { ComponentType, ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { TRANSFORM_LANGUAGES, type TransformKind, type TransformLanguage } from "@filen/shared/assistant"
import { languageDisplayNames } from "@/lib/i18n/languageNames"
import type { AssistantKey } from "@/lib/i18n"
import {
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger
} from "@/components/ui/dropdown-menu"
import {
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger
} from "@/components/ui/context-menu"

export interface TransformPick {
	kind: TransformKind
	language: TransformLanguage
}

// The menu components the rewrite menu's entries render with: a dropdown's or a context menu's.
export interface TransformMenuParts {
	Item: ComponentType<{ onClick?: () => void; children?: ReactNode }>
	Sub: ComponentType<{ children?: ReactNode }>
	SubTrigger: ComponentType<{ children?: ReactNode }>
	SubContent: ComponentType<{ children?: ReactNode }>
	Separator: ComponentType
}

export const DROPDOWN_PARTS: TransformMenuParts = {
	Item: DropdownMenuItem,
	Sub: DropdownMenuSub,
	SubTrigger: DropdownMenuSubTrigger,
	SubContent: DropdownMenuSubContent,
	Separator: DropdownMenuSeparator
}

export const CONTEXT_MENU_PARTS: TransformMenuParts = {
	Item: ContextMenuItem,
	Sub: ContextMenuSub,
	SubTrigger: ContextMenuSubTrigger,
	SubContent: ContextMenuSubContent,
	Separator: ContextMenuSeparator
}

// The menu's entry and the result's heading for each kind but a translation (which names its language).
export const TRANSFORM_KIND_LABELS: Readonly<Record<Exclude<TransformKind, "translate">, AssistantKey>> = {
	rewrite: "assistantTransformRewrite",
	shorten: "assistantTransformShorten",
	fix_grammar: "assistantTransformFixGrammar"
}

// A target language's name in the UI language.
export function useTransformLanguageName(): (language: TransformLanguage) => string {
	const { i18n } = useTranslation()
	const names = languageDisplayNames(i18n.language)

	return language => names?.of(language) ?? TRANSFORM_LANGUAGES[language]
}
