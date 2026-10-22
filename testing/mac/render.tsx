// Mounts a view the way the app does (inside a StoreProvider), against a FakeClient, and waits on
// the app's own signals instead of the clock.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StoreProvider } from "../../app/src/renderer/state/store";
import { FakeClient } from "./fakeClient";
import { NOW, world as defaultWorld, type World } from "../world";
import { setNow } from "./setup";

export interface Mounted {
  client: FakeClient;
  container: HTMLElement;
  toasts: { message: string; kind: string }[];
  /** Run `fn` (an event push, a click) and let React and pending promises settle. */
  settle(fn?: () => void | Promise<void>): Promise<void>;
  /** Wait until `check` holds; fails with `what` if the app never gets there (no timeout sleep: it drains the microtask queue). */
  until(what: string, check: () => boolean): Promise<void>;
  unmount(): void;
}

const mounted: Mounted[] = [];

/** Let promises and the effects they trigger run until the fake service has nothing left to answer (inside act). */
async function drain(client: FakeClient) {
  for (let i = 0; i < 50; i++) {
    await Promise.resolve();
    await Promise.resolve();
    if (client.inflight === 0) return;
  }
}

/**
 * @param hash   the route to open at, e.g. "#/board/all"
 * @param connect  open the socket (the app loads its snapshot). false leaves the app unconnected.
 */
export async function mount(view: ReactNode, opts: { world?: World; hash?: string; connect?: boolean; client?: FakeClient } = {}): Promise<Mounted> {
  location.hash = opts.hash ?? "#/board/all";
  const client = opts.client ?? new FakeClient(opts.world);
  const toasts: Mounted["toasts"] = [];
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  const m: Mounted = {
    client,
    container,
    toasts,
    async settle(fn) {
      await act(async () => {
        await fn?.();
        await drain(client);
      });
    },
    async until(what, check) {
      for (let i = 0; i < 200; i++) {
        if (check()) return;
        await act(async () => {
          await drain(client);
        });
      }
      throw new Error(`never reached: ${what}\n${container.innerHTML.slice(0, 2000)}`);
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
  mounted.push(m);
  await act(async () => {
    root.render(
      <StoreProvider baseUrl="http://fake.test" token="fake" client={client} toast={(message, kind) => toasts.push({ message, kind: String(kind) })}>
        {view}
      </StoreProvider>,
    );
  });
  if (opts.connect !== false) await m.settle(() => client.open());
  return m;
}

import { afterEach, jest } from "bun:test";
afterEach(async () => {
  for (const m of mounted.splice(0)) {
    await m.settle();
    m.unmount();
  }
  // After the unmount, so no mounted view hears the route change.
  localStorage.clear();
  location.hash = "";
  setNow(NOW);
});

// --- Queries: by role and visible text, the way a person finds things -----------------------

export const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
export const all = (root: ParentNode, selector: string) => [...root.querySelectorAll<HTMLElement>(selector)];

/** Set an input's value the way typing does, so React's onChange sees it. */
export function type(m: Mounted, input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  return m.settle(() => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export const click = (m: Mounted, el: Element) => m.settle(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

/** A copy of the world with `edit` applied: the same data a test starts from, changed in one place. */
export function edited(edit: (w: World) => void, base: World = defaultWorld): World {
  const w = structuredClone(base);
  edit(w);
  return w;
}

/** Move jest's fake clock (a test that called jest.useFakeTimers) forward, so a debounce fires when the test says. */
export const advance = (m: Mounted, ms: number) => m.settle(() => void jest.advanceTimersByTime(ms));
