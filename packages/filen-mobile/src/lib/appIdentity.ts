// Apple signing identity shared by app.config.ts (entitlements, plugins) and the runtime.
//
// MUST stay import-free: `app.config.ts` loads this in a plain Node context (no `@/` alias,
// no React Native, no Expo). The File Provider extension's Swift sources keep their own copy.
export const APPLE_TEAM_ID: string = "7YTW5D2K7P"

export const IOS_APP_GROUP_IDENTIFIER: string = "group.io.filen.app"

// Team-prefixed keychain access group shared with the File Provider extension (auth.json DEK).
export const IOS_KEYCHAIN_ACCESS_GROUP: string = `${APPLE_TEAM_ID}.io.filen.sharedkeys`
