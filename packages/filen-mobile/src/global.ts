import "@/lib/polyfills/DOMException"
import "@/lib/polyfills/buffer"
import "@/lib/polyfills/crypto"
import "@/lib/polyfills/console"

import NetInfo from "@react-native-community/netinfo"
import { NETINFO_CONFIG } from "@/constants"
import { enableFreeze } from "react-native-screens"
import { installGlobalErrorHandlers } from "@/lib/errorHandlers"
import logger from "@/lib/logger"

// Route uncaught JS errors + unhandled promise rejections to the on-disk diagnostic logger
// (after the console tee is installed above). In production these are otherwise invisible.
installGlobalErrorHandlers()

// Keep production logs lean: only warnings/errors are recorded; debug/info stay dev-only
// breadcrumbs. (console.log/info/debug call sites are additionally stripped at build time in prod —
// see babel.config.js — so they cost nothing; this gates explicit logger.debug/info calls too.)
logger.configure({
	minLevel: __DEV__ ? "debug" : "warn"
})

enableFreeze(true)

NetInfo.configure(NETINFO_CONFIG)
