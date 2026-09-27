// Metro for a Bun workspace. Expo's default config already watches the monorepo root and
// resolves hoisted packages there; the one fix needed is React: the desktop app pins a newer
// react at the root, and react-native's renderer must see the exact version it was built for
// (react 19.2.3, installed in mobile/node_modules). Every import of react — from our code or
// from hoisted packages like react-native — resolves from this package.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
const anchor = path.join(__dirname, "package.json");

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "react" || moduleName.startsWith("react/")) {
    return context.resolveRequest({ ...context, originModulePath: anchor }, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
