import "@/lib/polyfills/DOMException"
import "@/lib/polyfills/buffer"
import "@/lib/polyfills/crypto"
import "@/lib/polyfills/console"

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
