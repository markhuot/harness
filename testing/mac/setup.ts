// Installs a DOM and pins everything a render could read from the machine: the clock, the time
// zone and the locale. Preloaded by this directory's bunfig, before any test file.
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { LOCALE, NOW, TIME_ZONE } from "../world";

process.env.TZ = TIME_ZONE;

GlobalRegistrator.register({ url: "http://localhost/", width: 1280, height: 800 });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Date.now() is the world's now; `new Date()` follows. Tests move it only through `setNow`.
const RealDate = Date;
let now = NOW;
class FrozenDate extends RealDate {
  constructor(...args: ConstructorParameters<typeof RealDate> | []) {
    if (args.length === 0) super(now);
    else super(...(args as [number]));
  }
  static override now() {
    return now;
  }
}
globalThis.Date = FrozenDate as unknown as DateConstructor;
export const setNow = (at: number) => {
  now = at;
};

// Formatting reads the default locale; pin it so a developer's own settings can't change a render.
const tag = LOCALE.replace("_", "-");
const RealDateTimeFormat = Intl.DateTimeFormat;
Intl.DateTimeFormat = ((l?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) => new RealDateTimeFormat(l ?? tag, { timeZone: TIME_ZONE, ...o })) as unknown as typeof Intl.DateTimeFormat;


// happy-dom has no canvas; the code viewer measures text with one. A fixed 8px advance keeps layout
// math deterministic (a real font would vary by machine).
HTMLCanvasElement.prototype.getContext = (() => ({ font: "", measureText: (s: string) => ({ width: s.length * 8 }), fillRect() {}, clearRect() {} })) as never;

// The per-test cleanup render.tsx installs (unmounting views). Registered here, in the preload, so
// it runs after every test in every file, not only in the first file that imported render.tsx.
let cleanup: (() => Promise<void>) | null = null;
export const setAfterEach = (fn: () => Promise<void>) => {
  cleanup = fn;
};
afterEach(async () => {
  await cleanup?.();
});
