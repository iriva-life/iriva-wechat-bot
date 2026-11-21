import { StateStore } from "./policy/index.js";
import { isUserId, record } from "./wechat/normalize.js";

/** Input must come from the authenticated bridge directory, never message text. */
export function bindDirectoryAdmins(
  state: StateStore,
  directory: unknown,
  botWxid: string,
): number {
  const users = record(record(directory).users);
  let bound = 0;
  for (const alias of state.unresolvedAdminAliases()) {
    const matches = Object.entries(users).filter(
      ([wxid, entry]) =>
        wxid !== botWxid &&
        isUserId(wxid) &&
        typeof record(entry).alias === "string" &&
        String(record(entry).alias).toLowerCase() === alias.toLowerCase(),
    );
    if (matches.length !== 1) continue;
    state.bindIdentity({
      alias,
      wxid: matches[0][0],
      source: "directory",
      verified: true,
    });
    bound++;
  }
  return bound;
}
