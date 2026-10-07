// The Mac app's bundle id. It's the iPhone/iPad app's too (PRODUCT_BUNDLE_IDENTIFIER in
// ios/project.yml), so one App ID, and one APNs topic, covers every platform, and the Mac widget
// extension is `${APP_BUNDLE_ID}.widgets` like the iOS one (ios/Tools/config.test.ts checks both).
export const APP_BUNDLE_ID = "com.markhuot.harness";

/** The id Mac builds had before they moved to the shared one. Installing quits a running copy under either. */
export const LEGACY_APP_BUNDLE_ID = "com.markhuot.harness.app";
