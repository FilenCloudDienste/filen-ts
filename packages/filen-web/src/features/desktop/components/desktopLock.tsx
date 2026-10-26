import { type ReactNode, type SubmitEvent, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { formatSecondsToMediaClock } from "@filen/shared"
import { DESKTOP_PIN_MAX_LENGTH, desktopPinSchema } from "@filen/shared/desktopLock"
import { Button } from "@/components/ui/button"
import { SecretInput } from "@/components/ui/secretInput"
import { Spinner } from "@/components/ui/spinner"
import { Logo } from "@/features/shell/components/logo"
import { refreshDesktopLock, signOutFromLock, useDesktopLock } from "@/features/desktop/lib/lock"
import { desktopBridge } from "@/lib/desktop"
import { useDismissBootSplash } from "@/lib/bootSplash"
import { log } from "@/lib/log"

const IS_DESKTOP = desktopBridge() !== undefined

// Seconds left until `retryAt`, ticking while it lies ahead; null when attempts are open.
function useSecondsUntil(retryAt: number | null): number | null {
	const [now, setNow] = useState(() => Date.now())

	useEffect(() => {
		if (retryAt === null) {
			return
		}

		const timer = setInterval(() => {
			setNow(Date.now())
		}, 1000)

		return () => {
			clearInterval(timer)
		}
	}, [retryAt])

	return retryAt === null || retryAt <= now ? null : Math.ceil((retryAt - now) / 1000)
}

function ForgotPin({ onCancel }: { onCancel: () => void }) {
	const { t } = useTranslation(["desktop", "common"])
	const [pending, setPending] = useState(false)
	const [failed, setFailed] = useState(false)

	return (
		<div className="flex w-full flex-col gap-4 text-center">
			<p className="text-sm text-muted-foreground">{t("lockSignOutBody")}</p>
			{failed ? <p className="text-sm text-destructive">{t("lockSignOutFailed")}</p> : null}
			<div className="flex justify-center gap-2 app-region-no-drag">
				<Button
					type="button"
					variant="outline"
					disabled={pending}
					onClick={onCancel}
				>
					{t("common:cancel")}
				</Button>
				<Button
					type="button"
					variant="destructive"
					disabled={pending}
					onClick={() => {
						setPending(true)
						setFailed(false)
						signOutFromLock().catch((error: unknown) => {
							log.error("desktop", "forgotten-PIN sign-out failed", error)
							setPending(false)
							setFailed(true)
						})
					}}
				>
					{pending && <Spinner data-icon="inline-start" />}
					{t("lockSignOut")}
				</Button>
			</div>
		</div>
	)
}

function LockScreen() {
	const { t } = useTranslation("desktop")
	const status = useDesktopLock(state => state.status)
	const signingOut = useDesktopLock(state => state.signingOut)
	const [pin, setPin] = useState("")
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<"wrong" | "failed" | null>(null)
	const [forgot, setForgot] = useState(false)
	const inputRef = useRef<HTMLInputElement>(null)
	const popupRef = useRef<HTMLDivElement>(null)
	// Main reports the backoff with every status, before it answers the attempt that caused it.
	const waitSeconds = useSecondsUntil(status?.retryAt ?? null)
	const unreadable = status?.unreadable === true

	useDismissBootSplash()

	// Keys typed here are the lock screen's alone: the app's document-level shortcuts must not hear them.
	useEffect(() => {
		const popup = popupRef.current

		if (popup === null) {
			return
		}

		const stop = (event: KeyboardEvent) => {
			event.stopPropagation()
		}

		popup.addEventListener("keydown", stop)
		popup.addEventListener("keyup", stop)

		return () => {
			popup.removeEventListener("keydown", stop)
			popup.removeEventListener("keyup", stop)
		}
	}, [])

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault()

		const bridge = desktopBridge()

		if (bridge === undefined || !desktopPinSchema.allows(pin) || waitSeconds !== null) {
			return
		}

		setPending(true)
		setError(null)

		try {
			const result = await bridge.lock.unlock(pin)

			if (!result.ok) {
				setError(result.retryAt === null ? "wrong" : null)
				setPin("")
				inputRef.current?.focus()
			}
		} catch (failure) {
			log.error("desktop", "unlock failed", failure)
			setError("failed")
		} finally {
			setPending(false)
		}
	}

	let body: ReactNode

	if (forgot || signingOut) {
		body = (
			<ForgotPin
				onCancel={() => {
					setForgot(false)
				}}
			/>
		)
	} else if (unreadable) {
		body = (
			<div className="flex w-full flex-col gap-4 text-center">
				<p className="text-sm text-muted-foreground">{t("lockUnreadable")}</p>
				<div className="flex justify-center gap-2 app-region-no-drag">
					<Button
						type="button"
						variant="outline"
						onClick={() => {
							void refreshDesktopLock()
						}}
					>
						{t("lockTryAgain")}
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={() => {
							setForgot(true)
						}}
					>
						{t("lockSignOut")}
					</Button>
				</div>
			</div>
		)
	} else {
		body = (
			<form
				className="flex w-full flex-col items-stretch gap-3"
				onSubmit={event => {
					void submit(event)
				}}
			>
				<SecretInput
					ref={inputRef}
					aria-label={t("lockPinLabel")}
					inputMode="numeric"
					maxLength={DESKTOP_PIN_MAX_LENGTH}
					autoFocus
					value={pin}
					disabled={pending}
					className="h-10 text-center text-lg leading-6 tracking-[0.3em] app-region-no-drag"
					onChange={event => {
						setPin(event.target.value.replaceAll(/\D/g, ""))
						setError(null)
					}}
				/>
				<p
					className="min-h-5 text-center text-sm text-destructive"
					aria-live="polite"
				>
					{waitSeconds !== null
						? t("lockRetryIn", { time: formatSecondsToMediaClock(waitSeconds) })
						: error === "wrong"
							? t("lockWrongPin")
							: error === "failed"
								? t("lockFailed")
								: null}
				</p>
				<Button
					type="submit"
					className="app-region-no-drag"
					disabled={pending || waitSeconds !== null || !desktopPinSchema.allows(pin)}
				>
					{pending && <Spinner data-icon="inline-start" />}
					{t("lockUnlock")}
				</Button>
				<Button
					type="button"
					variant="link"
					className="self-center app-region-no-drag"
					onClick={() => {
						setForgot(true)
					}}
				>
					{t("lockForgotPin")}
				</Button>
			</form>
		)
	}

	// A modal dialog of its own, so it stacks over any dialog the app had open (taking focus and pointer from it), and
	// opaque over everything, toasts included. Escape and outside clicks cannot close it; only main unlocks.
	return (
		<DialogPrimitive.Root
			open
			disablePointerDismissal
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Popup
					ref={popupRef}
					initialFocus={inputRef}
					aria-labelledby="desktop-lock-title"
					className="fixed inset-0 z-2147483647 flex flex-col items-center justify-center bg-canvas text-foreground outline-none app-region-drag"
				>
					<div className="flex w-full max-w-xs flex-col items-center gap-6 px-6">
						<Logo className="size-12 text-primary" />
						<div className="flex flex-col items-center gap-2 text-center">
							<h1
								id="desktop-lock-title"
								className="font-heading text-lg font-medium"
							>
								{t("lockTitle")}
							</h1>
							<p className="text-sm text-muted-foreground">{t("lockDescription")}</p>
						</div>
						{body}
					</div>
				</DialogPrimitive.Popup>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	)
}

// The desktop app lock around the whole app. Until main answers nothing renders (the boot splash stays). Locked
// before the app was ever shown, only the lock screen renders, so no content mounts underneath; once shown, a lock
// covers the content instead, keeping its state. A browser renders the app as is.
export function DesktopLockGate({ children }: { children: ReactNode }) {
	const status = useDesktopLock(state => state.status)
	const revealed = useDesktopLock(state => state.revealed)
	const signingOut = useDesktopLock(state => state.signingOut)

	useEffect(() => {
		if (IS_DESKTOP) {
			void refreshDesktopLock()
		}
	}, [])

	if (!IS_DESKTOP) {
		return children
	}

	if (status === null) {
		return null
	}

	const covered = status.locked || signingOut

	return (
		<>
			{revealed ? children : null}
			{covered ? <LockScreen /> : null}
		</>
	)
}
