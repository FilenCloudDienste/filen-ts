import { useTranslation } from "react-i18next"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { STAGE_POPUP_TONE_CLASS, useVideoStageContainer } from "@/components/media/video/stageContext"
import { ShortcutsList } from "@/lib/keymap/shortcutsList"

// The app's shortcuts list over the picture (the app's shortcuts key, or the button), opened on the players' own
// group: the same list as Settings → Keyboard, so what it shows is always what the keys do. Portalled into the stage
// so it shows in fullscreen too, without blurring the picture.
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const { t } = useTranslation(["common"])
	const container = useVideoStageContainer()

	return (
		<DialogPrimitive.Root
			open={open}
			onOpenChange={onOpenChange}
		>
			<DialogPrimitive.Portal container={container}>
				<DialogPrimitive.Popup
					data-stage-popup=""
					// Opened by a key, it has no trigger to go back to: the stage keeps the keyboard.
					finalFocus={() => container}
					className={cn(
						"fixed top-1/2 left-1/2 z-50 flex h-[min(85svh,48rem)] w-[min(42rem,calc(100%-2rem))] -translate-1/2 flex-col gap-4 rounded-3xl p-5 text-sm outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
						STAGE_POPUP_TONE_CLASS
					)}
				>
					<div className="flex items-center justify-between">
						<DialogPrimitive.Title className="text-base font-semibold">{t("shortcutsTitle")}</DialogPrimitive.Title>
						<DialogPrimitive.Close
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("close")}
								/>
							}
						>
							<XIcon />
						</DialogPrimitive.Close>
					</div>
					<ShortcutsList
						variant="dialog"
						initialText={t("shortcutsScopeMedia")}
					/>
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	)
}
