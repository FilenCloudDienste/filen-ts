import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ShortcutsList } from "@/lib/keymap/shortcutsList"

interface ShortcutsDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

// The overlay half of the shortcuts surface, opened by `app.openShortcuts` or the account menu. It renders the same
// <ShortcutsList /> as Settings → Keyboard, compact — one component, one data path, so the two can never disagree
// about what a shortcut is bound to. A fixed height: the list is a virtualized scroll area that fills it.
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
	const { t } = useTranslation("common")

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="flex h-[min(85svh,48rem)] flex-col gap-4 sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{t("shortcutsTitle")}</DialogTitle>
					<DialogDescription>{t("shortcutsDescription")}</DialogDescription>
				</DialogHeader>
				<ShortcutsList variant="dialog" />
			</DialogContent>
		</Dialog>
	)
}
