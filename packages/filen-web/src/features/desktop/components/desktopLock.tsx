import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type SubmitEvent,
	useEffect,
	useEffectEvent,
	useRef,
	useState
} from "react"
import { useTranslation } from "react-i18next"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { formatSecondsToMediaClock } from "@filen/shared"
import { DESKTOP_PIN_MAX_LENGTH, desktopPinSchema } from "@filen/shared/desktopLock"
import { matchesCombo } from "@filen/shared/keymap"
import { Button } from "@/components/ui/button"
import { SecretInput } from "@/components/ui/secretInput"
import { Spinner } from "@/components/ui/spinner"
import { Logo } from "@/features/shell/components/logo"
import { refreshDesktopLock, signOutFromLock, useDesktopLock } from "@/features/desktop/lib/lock"
import { desktopBridge } from "@/lib/desktop"
import { useDismissBootSplash } from "@/lib/bootSplash"
import { ALL_ACTIONS } from "@/lib/keymap/actions"
import { browserZoomKey, matchesOverride, userBinding } from "@/lib/keymap/browserZoom"
import { bindingsOf, comboFor, currentKeymapRecord, CURRENT_PLATFORM, registeredAction } from "@/lib/keymap/registry"
import { log } from "@/lib/log"

const IS_DESKTOP = desktopBridge() !== undefined

// Seconds left until `retryAt`, ticking while it lies ahead; null once it has passed, when the timer stops and
// `onEnded` runs. Both read the wall clock, which a timer armed for the whole backoff would not follow across a sleep
// or a clock change. Its clock starts when the hook mounts, so its owner is keyed by `retryAt`: a new backoff counts
// from the present.
function useSecondsUntil(retryAt: number, onEnded: () => void): number | null {
	const [now, setNow] = useState(() => Date.now())
	const ended = useEffectEvent(onEnded)

	useEffect(() => {
		// Already behind (back from another view after the deadline): ends at once rather than a second on.
		if (retryAt <= Date.now()) {
			const timer = setTimeout(() => {
				setNow(Date.now())
				ended()
			}, 0)

			return () => {
				clearTimeout(timer)
			}
		}

		const timer = setInterval(() => {
			const at = Date.now()

			setNow(at)

			if (at >= retryAt) {
				clearInterval(timer)
				ended()
			}
		}, 1000)

		return () => {
			clearInterval(timer)
		}
	}, [retryAt])

	return retryAt <= now ? null : Math.ceil((retryAt - now) / 1000)
}

// The ticking countdown, outside the live region: a timer is read on demand, never announced each second. Main
// pushes nothing when a backoff ends, so the clock ends it (`onEnded`).
function RetryClock({ retryAt, onEnded }: { retryAt: number; onEnded: () => void }) {
	const { t } = useTranslation("desktop")
	const seconds = useSecondsUntil(retryAt, onEnded)

	if (seconds === null) {
		return null
	}

	return (
		<span
			role="timer"
			aria-live="off"
		>
			{t("lockRetryClock", { time: formatSecondsToMediaClock(seconds) })}
		</span>
	)
}

const ZOOM_ACTIONS = { in: "desktop.zoomIn", out: "desktop.zoomOut", reset: "desktop.zoomReset" } as const

// Whether a zoom step's action has the user's own binding and `event` is it.
function isUserZoomBinding(event: KeyboardEvent, id: string, combos: Readonly<Record<string, string>>): boolean {
	const def = registeredAction(id)

	return def !== undefined && matchesOverride(event, userBinding(combos, def), CURRENT_PLATFORM.mac)
}

// The window's own keys, by the rules desktopWindowKeys.tsx runs them with: quit, full screen and zoom, which off a
// Mac no menu has. A zoom action takes the user's binding when it has one, else the zoom characters, unless turned
// off or the character is the user's binding of another action. Every other key stays in the lock screen, so PIN
// digits never run a bare-key binding, nor lock, close, navigation or any other action run under it.
function isWindowKey(event: KeyboardEvent): boolean {
	const mac = CURRENT_PLATFORM.mac

	if (matchesCombo(event, comboFor("desktop.quit"), mac) || matchesCombo(event, comboFor("desktop.fullScreen"), mac)) {
		return true
	}

	const combos = bindingsOf(currentKeymapRecord())

	if (Object.values(ZOOM_ACTIONS).some(id => isUserZoomBinding(event, id, combos))) {
		return true
	}

	const step = mac ? undefined : browserZoomKey(event, false)
	const def = step === undefined ? undefined : registeredAction(ZOOM_ACTIONS[step])

	return (
		def !== undefined &&
		combos[def.id] !== "" &&
		userBinding(combos, def) === undefined &&
		!ALL_ACTIONS.some(other => matchesOverride(event, userBinding(combos, other), false))
	)
}

// Keys typed here are the lock screen's alone, but for the window's keys: the app's document-level shortcuts must not
// hear them. A React handler, as the popup mounts in a later commit than the lock screen (its portal): stopped at the
// portal's container, the key never reaches the document or the window.
function keepKeys(event: ReactKeyboardEvent<HTMLDivElement>): void {
	if (!isWindowKey(event.nativeEvent)) {
		event.stopPropagation()
	}
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
	// Main reports the backoff with every status, before it answers the attempt that caused it.
	const retryAt = status?.retryAt ?? null
	// Ended by the countdown, on the wall clock: main pushes nothing when a backoff runs out.
	const [endedFor, setEndedFor] = useState<number | null>(null)
	const backingOff = retryAt !== null && endedFor !== retryAt
	const unreadable = status?.unreadable === true

	useDismissBootSplash()

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault()

		const bridge = desktopBridge()

		if (bridge === undefined || !desktopPinSchema.allows(pin) || backingOff) {
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

					// A backoff that ran out meanwhile ends now, not when the countdown mounts again.
					if (retryAt !== null && Date.now() >= retryAt) {
						setEndedFor(retryAt)
					}
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
				<p className="min-h-5 text-center text-sm text-destructive">
					{/* Changes with the state only (wrong PIN, failed, backoff started), so each is announced once. */}
					<span aria-live="polite">
						{backingOff
							? t("lockTooManyPins")
							: error === "wrong"
								? t("lockWrongPin")
								: error === "failed"
									? t("lockFailed")
									: null}
					</span>
					{backingOff ? (
						<>
							{" "}
							<RetryClock
								key={retryAt}
								retryAt={retryAt}
								onEnded={() => {
									setEndedFor(retryAt)
								}}
							/>
						</>
					) : null}
				</p>
				<Button
					type="submit"
					className="app-region-no-drag"
					disabled={pending || backingOff || !desktopPinSchema.allows(pin)}
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
					onKeyDown={keepKeys}
					onKeyUp={keepKeys}
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
