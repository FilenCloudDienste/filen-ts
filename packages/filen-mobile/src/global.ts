import "@/lib/polyfills/DOMException"
import "@/lib/polyfills/buffer"
import "@/lib/polyfills/crypto"
import "@/lib/polyfills/console"

// Bind TanStack onlineManager → NetInfo here (BG-04), the single universal entry that runs on EVERY
// launch — foreground render AND a headless OS background wake (entry.ts → "@/global"). Doing it only
// in _layout.tsx left onlineManager at its default `online:true` during headless runs (the nav tree
// never renders), so the offline background pass bypassed its own connectivity gate and the reconnect
// listener was inert. setEventListener binds eagerly; NetInfo's first emission is async, so it lands
// after the synchronous NetInfo.configure below.
import "@/queries/onlineStatus"

import NetInfo from "@react-native-community/netinfo"
import { NETINFO_CONFIG } from "@/constants"
import { enableFreeze } from "react-native-screens"
import { installGlobalErrorHandlers } from "@/lib/errorHandlers"

// Route uncaught JS errors + unhandled promise rejections to the on-disk diagnostic logger
// (after the console tee is installed above). In production these are otherwise invisible.
// (The prod log level — warn/error only — is armed in the logger's own default, before the first
// line; see DEFAULT_CONFIG in src/lib/logger.ts.)
installGlobalErrorHandlers()

enableFreeze(true)

NetInfo.configure(NETINFO_CONFIG)
