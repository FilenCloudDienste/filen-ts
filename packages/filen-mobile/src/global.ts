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
import { installGlobalErrorHandlers } from "@/lib/errorHandlers"

// Route uncaught JS errors + unhandled promise rejections to the on-disk diagnostic logger
// (after the console tee is installed above). In production these are otherwise invisible.
// (The prod log level — warn/error only — is armed in the logger's own default, before the first
// line; see DEFAULT_CONFIG in src/lib/logger.ts.)
installGlobalErrorHandlers()

enableFreeze(true)
