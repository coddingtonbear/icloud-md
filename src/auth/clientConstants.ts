/**
 * Static first-party web client identifiers sent on every idmsa.apple.com call.
 * Not secrets - the same fixed value is used by every browser/client talking to
 * this API (confirmed identical across independent reverse-engineering projects).
 */
export const APPLE_WIDGET_KEY = "d39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d";
export const APPLE_OAUTH_CLIENT_ID = APPLE_WIDGET_KEY;

/**
 * clientBuildNumber/clientMasteringNumber feed IcloudSession's existing fields,
 * used against setup.icloud.com/ckdatabasews. These are web-app version strings
 * with no way to derive them from the login response itself - captured from a
 * real browser session and, like CKJS_BUILD_VERSION in cloudkit/databaseClient.ts,
 * may need bumping if Apple ships a new web client build.
 */
export const DEFAULT_CLIENT_BUILD_NUMBER = "2624Build27";
export const DEFAULT_CLIENT_MASTERING_NUMBER = "2624Build27";
