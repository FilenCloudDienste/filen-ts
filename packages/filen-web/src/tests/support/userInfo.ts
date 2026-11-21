import type { UserInfo } from "@filen/sdk-rs"

// A getUserInfo answer holding only the fields a test reads, plus the lists every server read sorts
// (queries/account.ts's readUserInfo), which a real answer always carries.
export function testUserInfo(fields: Partial<UserInfo>): UserInfo {
	return { subs: [], subsInvoices: [], ...fields } as UserInfo
}
