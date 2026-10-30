import { useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { KeyRoundIcon } from "lucide-react"
import { toast } from "sonner"
import { FullScreenNotice } from "@/components/fullScreenNotice"
import { ConfirmDialog } from "@/components/dialogs/confirmDialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { retrySessionResume } from "@/lib/sdk/boot"
import { log } from "@/lib/log"

// Desktop only: the shell's vault holds a session it cannot decrypt. Trying again covers a keychain unlocked since;
// signing in again covers a key that is gone for good (a reset keychain, a migrated machine). BootGate shows this in
// place of the routes, whose guards ran as signed out, so a way out that works routes from the root again.
export function SessionUnreadableScreen() {
	const { t } = useTranslation(["desktop", "common"])
	const navigate = useNavigate()
	const [retrying, setRetrying] = useState(false)
	const [stillUnreadable, setStillUnreadable] = useState(false)
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [discarding, setDiscarding] = useState(false)

	function settled(resumed: boolean): void {
		if (resumed) {
			void navigate({ to: "/", replace: true })
		} else {
			setStillUnreadable(true)
		}
	}

	async function tryAgain(): Promise<void> {
		setRetrying(true)
		settled(await retrySessionResume(false))
		setRetrying(false)
	}

	// No `finally`: the React Compiler cannot lower one yet and would skip this whole component.
	async function signInAgain(): Promise<void> {
		setDiscarding(true)

		try {
			const resumed = await retrySessionResume(true)

			setConfirmOpen(false)
			settled(resumed)
		} catch (e) {
			log.error("session", "discarding the unreadable session failed", e)
			toast.error(t("desktop:sessionDiscardFailed"))
		}

		setDiscarding(false)
	}

	return (
		<FullScreenNotice
			icon={<KeyRoundIcon />}
			destructive={true}
			title={t("desktop:sessionUnreadableTitle")}
			description={t("desktop:sessionUnreadableBody")}
		>
			<div className="flex justify-center gap-2">
				<Button
					variant="outline"
					disabled={retrying || discarding}
					onClick={() => {
						void tryAgain()
					}}
				>
					{retrying && <Spinner data-icon="inline-start" />}
					{t("desktop:sessionUnreadableTryAgain")}
				</Button>
				<Button
					variant="destructive"
					disabled={retrying || discarding}
					onClick={() => {
						setConfirmOpen(true)
					}}
				>
					{t("desktop:sessionUnreadableSignIn")}
				</Button>
			</div>
			<p
				className="min-h-5 text-sm text-destructive"
				aria-live="polite"
			>
				{stillUnreadable ? t("desktop:sessionUnreadableStill") : null}
			</p>
			<ConfirmDialog
				open={confirmOpen}
				pending={discarding}
				title={t("desktop:sessionDiscardTitle")}
				body={t("desktop:sessionDiscardBody")}
				confirmLabel={t("desktop:sessionUnreadableSignIn")}
				cancelLabel={t("common:cancel")}
				destructive
				onOpenChange={setConfirmOpen}
				onConfirm={() => {
					void signInAgain()
				}}
			/>
		</FullScreenNotice>
	)
}
