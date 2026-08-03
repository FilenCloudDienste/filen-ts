import { useTranslation } from "react-i18next"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ShortcutsList } from "@/lib/keymap/shortcutsList"

interface ShortcutsDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

// The overlay half of the shortcuts surface, opened by `app.openShortcuts` or the account menu. It
// renders the same <ShortcutsList /> as Settings → Keyboard — one component, one data path, so the
// two can never disagree about what a shortcut is bound to.
export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
	const { t } = useTranslation("common")

	return (
		<Dialog
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogContent className="max-h-[80svh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{t("shortcutsTitle")}</DialogTitle>
					<DialogDescription>{t("shortcutsDescription")}</DialogDescription>
				</DialogHeader>
				<ShortcutsList />
			</DialogContent>
		</Dialog>
	)
}
