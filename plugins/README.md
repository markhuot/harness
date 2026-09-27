# Writing a Harness plugin

A plugin adds tabs to a ticket's detail panel and, if it needs data, HTTP routes on the service.
The tab is a normal web page that the app shows in an iframe (a WebView on iOS), so it works in any Harness client.
The full contract (discovery, isolation, origin rules) is in [DESIGN.md → Plugins](../DESIGN.md#plugins).
`plugins/git` is a complete example.

## Layout

```
my-plugin/
  plugin.json     manifest (required)
  server.ts       routes + event hooks (optional)
  build.ts        builds ui/ into dist/ (optional)
  ui/             your UI sources
  dist/           what the service serves at /plugins/<id>/ui/  (gitignored; built)
```

Put it in `$HARNESS_HOME/plugins/` (default `~/.harness/plugins/`) and restart the service
(`bun service/src/cli.ts service restart`). A user plugin with the same `id` as a built-in one
replaces it. Built-in plugins live in this directory and are workspace packages, so they can
import `@harness/plugin-sdk` and `@harness/shared`.

## plugin.json

```json
{
  "id": "notes",
  "name": "Notes",
  "version": "0.1.0",
  "description": "Scratch notes per ticket",
  "server": "server.ts",
  "ui": "dist/",
  "build": "build.ts",
  "tabs": [{ "id": "notes", "title": "Notes", "icon": "fileText", "when": "always" }]
}
```

- `id` and tab ids: lowercase letters, digits, `-` and `_`.
- `when`: `always`, `workdir` (the ticket's workdir exists and is a git repo) or `worktree` (the
  ticket runs on its own `harness/<key>` branch).
- `icon`: a name from the app's icon set (`app/src/renderer/components/Icon.tsx`). Unknown names
  show no icon.
- `build`: run with the service's `bun` at start when `ui/index.html` is missing or older than any
  source file in the plugin (ignoring `node_modules`, dotfiles and `*.test.*`). Omit it if you ship a
  prebuilt `dist/`.

If the manifest is invalid or the server module fails to load, the service keeps running. The
plugin shows up in `GET /plugins` with an `error` and its tabs are hidden. Check
`~/.harness/logs/service.log` for `[plugins]` lines.

## Server module

```ts
import { definePlugin, PluginHttpError } from "@harness/plugin-sdk/server";

export default definePlugin({
  routes(router, ctx) {
    // GET /plugins/notes/api/summary?ticket=KEY  (bearer auth, like every service route)
    router.get("/summary", async ({ query }) => {
      const key = query.get("ticket") ?? "";
      const found = ctx.getTicket(key);
      if (!found) throw new PluginHttpError(404, `No ticket ${key}`);
      const dir = ctx.ticketWorkdir(key);
      const ls = dir ? await ctx.exec("ls", ["-1"], { cwd: dir }) : null;
      return { title: found.ticket.title, project: found.project.name, files: ls?.stdout.split("\n").filter(Boolean) ?? [] };
    });
    router.post("/items/:id", async ({ params, body }) => ({ id: params.id, got: await body() }));
  },
  onTicketEvent(event, ctx) {
    if (event.kind === "ticket.upserted" && event.ticket.status === "done") ctx.log.info(`${event.ticket.key} finished`);
  },
});
```

- Return plain data and the service wraps it as `{ data }`. Return a `Response` to send it as-is.
- Throw anything with a numeric `status` for an error response. Other errors become a 500.
- `ctx.exec` never uses a shell and never throws. It returns `{ code, stdout, stderr, truncated, timedOut }`.
  `maxBytes` caps stdout and `timeoutMs` kills slow commands (default 30 s).
- Plugins run inside the service process with its permissions. Only install plugins you trust.

Plugins outside this repo can't resolve `@harness/plugin-sdk`. Since `definePlugin` returns its
argument unchanged, a plain `export default { routes(router, ctx) { … } }` works the same way.

## UI

The app loads `/plugins/<id>/ui/index.html?tab=<tabId>` from the service: in an iframe on the
desktop, and in a React Native WebView in the iOS app. `connect()` handles both transports, so the
same bundle works in each. Talk to the host only through the SDK, and don't assume `window.parent`
is the app (in the WebView it's the page itself). Use the SDK to get the connection details:

```ts
import { connect } from "@harness/plugin-sdk";

const h = await connect();
// h.baseUrl, h.token, h.ticketKey, h.tabId, h.theme ("light" | "dark")
// h.themeId ("catppuccin-mocha"), h.themeName, h.syntaxTheme (a Shiki theme name or null), h.tokens

const summary = await h.api(`summary?ticket=${h.ticketKey}`); // → /plugins/<id>/api/summary
const detail = await h.api(`/tickets/${h.ticketKey}`);        // leading slash: any service route

h.onTheme((theme, info) => repaint(info)); // any theme change, including dark → another dark theme
h.onTicket((ticket) => refreshSoon());    // fires on every change to this ticket
h.openExternal("https://example.com");    // opens in the default browser (http, https, mailto)
h.navigate("OTHER-12");                   // show another ticket
```

The SDK keeps `<html>` in step with the app: `data-theme="light|dark"`, `color-scheme`,
`data-theme-id`, and the app theme's color tokens as custom properties named like the app's own
(`--harness-bg`, `--harness-bg-elev`, `--harness-text`, `--harness-text-2`, `--harness-accent`,
`--harness-border`, `--harness-c-planning` … `--harness-c-done`, `--harness-green`, `--harness-red`,
`--harness-diff-add`, `--harness-diff-del`, …). Use them with a fallback, since older hosts only
send light/dark: `background: var(--harness-bg, #fbfbfc)`, with dark fallbacks under
`:root[data-theme="dark"]`. `h.syntaxTheme` names the matching Shiki theme for code (null when
the app theme has none; use your own light/dark default). Bundle the SDK into your UI with
`bun build` or Vite; it has no runtime dependencies. If you use Bun with code splitting, bundle
your JS entry and write `index.html` yourself, as `plugins/git/build.ts` does. Bun's HTML
entrypoints can point the page at the wrong chunk when a dependency has many chunks.

Ticket events don't fire for file edits. If your tab shows files the agent is changing, poll
while `ticket.busy` is true, as the git plugin does.

## Testing

- Server routes: boot the service with `createHarness({ home, port: 0, … })` from
  `service/src/app.ts` and call your routes with `HarnessClient.request`. The built-in plugins load
  by default. See `plugins/git/server.test.ts`.
- The bridge: `connect({ window, fetch })` accepts a fake window, so it can be tested without a DOM.
  Give the fake window a `ReactNativeWebView` to test the iOS transport. See
  `plugins/sdk/harness-plugin.test.ts` and `mobile/src/lib/pluginHost.test.ts`.
- In the app: `cd app && bun run changes` runs the git plugin against a real daemon and saves
  screenshots. `app/scripts/lib/drive.ts`'s `frame(urlPart)` evaluates JavaScript inside a plugin iframe.
