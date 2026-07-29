import "@/lib/polyfills/DOMException"
import "@/lib/polyfills/buffer"
import "@/lib/polyfills/crypto"
import "@/lib/polyfills/console"

// Bind TanStack onlineManager → NetInfo here (BG-04), the single universal entry that runs on EVERY
// launch — foreground render AND a headless OS background wake (entry.ts → "@/global"). Doing it only
// in _layout.tsx left onlineManager at its default `online:true` during headless runs (the nav tree
// never renders), so the offline background pass bypassed its own connectivity gate and the reconnect
// listener was inert. NetInfo.configure lives INSIDE onlineStatus.ts, before its subscription —
// configure() severs all existing NetInfo listeners, so running it here after this import froze
// onlineManager at a single boot-time snapshot for the whole process (the stuck-offline sign-in bug).
import "@/queries/onlineStatus"

import { enableFreeze } from "react-native-screens"
import { I18nManager } from "react-native"
import { installGlobalErrorHandlers } from "@/lib/errorHandlers"

// RTL is not a supported layout for this app. None of the 27 shipped locales is right-to-left and no
// screen has ever been laid out or reviewed mirrored, so a device set to Arabic/Hebrew/Farsi got a
// mirrored surface nobody designed: reversed rows, flipped chevrons, drawers and gestures on the
// wrong edge.
//
// Android is settled authoritatively by the manifest — RN's I18nUtil.isRTL is gated on
// `applicationHasRtlSupport()`, and withDisableRtl sets android:supportsRtl="false", so isRTL is
// false there from the very first launch and this call is redundant belt-and-braces.
//
// iOS has no such gate: RCTI18nUtil.isRTL is read from NSUserDefaults + the app's writing direction,
// and the native read happens before this bundle runs. So the FIRST launch after updating can still
// be mirrored on an RTL device; the flag persists and every launch after it is LTR. Fixing that last
// launch means injecting into AppDelegate, which is not worth patching a template for.
I18nManager.allowRTL(false)
I18nManager.forceRTL(false)

// Route uncaught JS errors + unhandled promise rejections to the on-disk diagnostic logger
// (after the console tee is installed above). In production these are otherwise invisible.
// (The prod log level — warn/error only — is armed in the logger's own default, before the first
// line; see DEFAULT_CONFIG in src/lib/logger.ts.)
installGlobalErrorHandlers()

enableFreeze(true)
