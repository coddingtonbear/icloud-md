/**
 * clientBuildNumber/clientMasteringNumber feed IcloudSession's fields, used
 * against setup.icloud.com/ckdatabasews. These are web-app version strings
 * with no way to derive them from a login response itself - captured from a
 * real browser session and, like CKJS_BUILD_VERSION in cloudkit/databaseClient.ts,
 * may need bumping if Apple ships a new web client build. Browser login only
 * falls back to these when the observed setup call doesn't carry its own.
 */
export const DEFAULT_CLIENT_BUILD_NUMBER = "2624Build27";
export const DEFAULT_CLIENT_MASTERING_NUMBER = "2624Build27";
