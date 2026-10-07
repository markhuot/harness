// The frames of one tab's page, so the agent tools can act inside iframes.
//
// Same-origin iframes live in the page's own renderer: their documents report execution contexts
// on the tab's session. Cross-origin iframes (Stripe's card fields, say) run out of process: with
// Target.setAutoAttach each one attaches as a child session (flattened, on the same socket), which
// reports its own contexts and may attach iframes of its own. TabFrames follows both, so a frame
// is always "a session plus its main world's context", whichever process holds it.
//
// It also keeps the element refs browser_snapshot hands out: a ref names a DOM node of one frame
// (backendNodeId) and lasts until that frame navigates or goes away.

import type { CdpClient, CdpResult, CdpSession } from "./cdp.ts";

/** An iframe to act in: a CSS selector for the <iframe> element, or one per level for nested frames. */
export type FrameSpec = string | string[];

export interface FrameInfo {
  id: string;
  /** The session whose target holds the frame's document: the tab's, or an out-of-process iframe's. */
  session: CdpSession;
  parentId?: string;
  /** Its main world's execution context; absent while it has no document (or none reported yet). */
  contextId?: number;
  url: string;
}

/** Where in-page code runs. No contextId: the session's default context (the tab's top document). */
export interface Scope {
  frameId: string;
  session: CdpSession;
  contextId?: number;
}

/** A DOM element held for one action: released when the action is done. */
export interface ElementHandle {
  scope: Scope;
  objectId: string;
}

/**
 * A frame that can't be used: no iframe matches, it isn't an iframe, or it hasn't loaded. A wait
 * treats `notReady` ones as "not yet" and looks again.
 */
export class FrameError extends Error {
  constructor(
    message: string,
    readonly notReady = false,
  ) {
    super(message);
    this.name = "FrameError";
  }
}

/** The frame chain as the agent wrote it, for messages: `"#a"` or `["#a", "#b"]`. */
export const frameLabel = (spec: FrameSpec) => JSON.stringify(Array.isArray(spec) && spec.length === 1 ? spec[0] : spec);

/** A frame param as a chain of selectors; a JSON array sent as a string counts as the array. */
export function frameChain(spec: unknown): string[] {
  let v = spec;
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) v = parsed;
    } catch {
      // An attribute selector like [name=card]: a selector, not JSON.
    }
  }
  const chain = Array.isArray(v) ? v : [v];
  if (!chain.length || chain.some((s) => typeof s !== "string" || !s.trim())) {
    throw new FrameError("frame is a CSS selector for the <iframe> element, or an array of them for nested frames (outermost first).");
  }
  return chain as string[];
}

const IFRAME_FILTER = [{ type: "iframe" }];

export class TabFrames {
  readonly frames = new Map<string, FrameInfo>();
  /** browser_snapshot's refs: "e12" → the node, and the node → its ref (so a node keeps its ref). */
  private refs = new Map<string, { frameId: string; backendNodeId: number }>();
  private refByNode = new Map<string, string>();
  private nextRef = 1;
  private sessionOffs = new Map<string, (() => void)[]>();

  constructor(
    private readonly client: CdpClient,
    readonly root: CdpSession,
    /** The tab's main frame id (it can change when the page navigates). */
    private readonly mainId: () => string,
  ) {}

  /** Start following the tab's own session. Call before Runtime.enable, so no context is missed. */
  start(): void {
    this.watch(this.root);
  }

  /** Auto-attach the session's out-of-process iframes (the tab's, or a child's for nested ones). */
  async autoAttach(session: CdpSession): Promise<void> {
    const params = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
    // `filter` keeps workers out; a Chrome without it attaches them too, which is harmless.
    await session.send("Target.setAutoAttach", { ...params, filter: IFRAME_FILTER }).catch(() => session.send("Target.setAutoAttach", params));
  }

  /** Learn the frames a session already has (its Page.getFrameTree result). */
  learnTree(tree: CdpResult, session: CdpSession): void {
    if (!tree?.frame?.id) return;
    const f = this.ensure(tree.frame.id, session);
    if (tree.frame.parentId) f.parentId = tree.frame.parentId;
    f.url = tree.frame.url ?? f.url;
    for (const child of tree.childFrames ?? []) this.learnTree(child, session);
  }

  dispose(): void {
    for (const offs of this.sessionOffs.values()) for (const off of offs) off();
    this.sessionOffs.clear();
    this.frames.clear();
    this.refs.clear();
    this.refByNode.clear();
  }

  private ensure(id: string, session: CdpSession): FrameInfo {
    let f = this.frames.get(id);
    if (!f) this.frames.set(id, (f = { id, session, url: "" }));
    return f;
  }

  private watch(session: CdpSession): void {
    const same = (f: FrameInfo) => f.session.id === session.id;
    const offs = [
      session.on("Runtime.executionContextCreated", (p) => {
        const aux = p.context?.auxData;
        if (!aux?.isDefault || typeof aux.frameId !== "string") return;
        const f = this.ensure(aux.frameId, session);
        f.session = session;
        f.contextId = p.context.id;
      }),
      session.on("Runtime.executionContextDestroyed", (p) => {
        for (const f of this.frames.values()) if (same(f) && f.contextId === p.executionContextId) f.contextId = undefined;
      }),
      session.on("Runtime.executionContextsCleared", () => {
        for (const f of this.frames.values()) if (same(f)) f.contextId = undefined;
      }),
      session.on("Page.frameAttached", (p) => {
        this.ensure(p.frameId, session).parentId = p.parentFrameId;
      }),
      session.on("Page.frameNavigated", (p) => {
        const f = this.ensure(p.frame.id, session);
        if (p.frame.parentId) f.parentId = p.frame.parentId;
        f.url = p.frame.url + (p.frame.urlFragment ?? "");
        this.dropRefs(new Set([p.frame.id]));
      }),
      session.on("Page.frameDetached", (p) => {
        // "swap": the frame moved to another process; its new session reports it.
        if (p.reason !== "swap") this.remove(p.frameId);
      }),
      session.on("Target.attachedToTarget", (p) => {
        if (p.targetInfo?.type === "iframe") void this.attachChild(p.sessionId, p.targetInfo.targetId);
      }),
      session.on("Target.detachedFromTarget", (p) => this.detachChild(p.sessionId)),
    ];
    this.sessionOffs.set(session.id, offs);
  }

  /** An out-of-process iframe attached: its target id is its frame id. */
  private async attachChild(sessionId: string, frameId: string): Promise<void> {
    const s = this.client.session(sessionId);
    this.watch(s);
    this.ensure(frameId, s).session = s;
    try {
      await Promise.all([s.send("Runtime.enable"), s.send("Page.enable"), this.autoAttach(s)]);
      const { frameTree } = await s.send("Page.getFrameTree");
      this.learnTree(frameTree, s);
    } catch {
      // Detached (or the tab closed) while attaching.
    }
  }

  private detachChild(sessionId: string): void {
    for (const off of this.sessionOffs.get(sessionId) ?? []) off();
    this.sessionOffs.delete(sessionId);
    // Its frames have no document here any more; one that moved back in process reports a new context.
    for (const f of this.frames.values()) if (f.session.id === sessionId) f.contextId = undefined;
  }

  /** A frame went away: it, its descendants and their refs. */
  private remove(frameId: string): void {
    const gone = new Set([frameId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of this.frames.values()) {
        if (f.parentId && gone.has(f.parentId) && !gone.has(f.id)) {
          gone.add(f.id);
          grew = true;
        }
      }
    }
    for (const id of gone) this.frames.delete(id);
    this.dropRefs(gone);
  }

  private dropRefs(frameIds: Set<string>): void {
    for (const [ref, t] of this.refs) {
      if (!frameIds.has(t.frameId)) continue;
      this.refs.delete(ref);
      this.refByNode.delete(`${t.frameId}:${t.backendNodeId}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Scopes and elements
  // ---------------------------------------------------------------------------

  top(): Scope {
    return { frameId: this.mainId(), session: this.root };
  }

  /** The scope of a frame by id (the top document for the main frame), or null without a document. */
  scopeOf(frameId: string): Scope | null {
    if (frameId === this.mainId()) return this.top();
    const f = this.frames.get(frameId);
    return f?.contextId !== undefined ? { frameId, session: f.session, contextId: f.contextId } : null;
  }

  /** Walk a frame chain from the top document. Throws FrameError for a frame that can't be used. */
  async resolve(spec: FrameSpec | undefined): Promise<Scope> {
    let scope = this.top();
    if (spec === undefined) return scope;
    const chain = frameChain(spec);
    for (let i = 0; i < chain.length; i++) {
      const sel = chain[i]!;
      const label = i === 0 ? JSON.stringify(sel) : `${JSON.stringify(sel)} (inside ${frameLabel(chain.slice(0, i))})`;
      const objectId = await this.query(scope, sel).catch((e) => {
        throw new FrameError(`frame ${label} isn't a valid CSS selector: ${(e as Error).message}`);
      });
      if (!objectId) throw new FrameError(`No iframe matches frame ${label}.`, true);
      let node: CdpResult;
      try {
        ({ node } = await scope.session.send("DOM.describeNode", { objectId }));
      } finally {
        void scope.session.send("Runtime.releaseObject", { objectId }).catch(() => {});
      }
      if (typeof node?.frameId !== "string") throw new FrameError(`frame ${label} matches a <${node?.localName ?? "?"}>, not an <iframe>.`);
      const next = this.scopeOf(node.frameId);
      if (!next) throw new FrameError(`The iframe ${label} hasn't loaded a document yet.`, true);
      scope = next;
    }
    return scope;
  }

  /** The first element matching `selector` in a scope, as an object id; null when none does. Throws for a bad selector. */
  async query(scope: Scope, selector: string): Promise<string | null> {
    const res = await scope.session.send("Runtime.evaluate", {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      ...(scope.contextId !== undefined ? { contextId: scope.contextId } : {}),
    });
    if (res.exceptionDetails) throw new Error(String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text).split("\n")[0]);
    return res.result?.subtype === "null" || !res.result?.objectId ? null : res.result.objectId;
  }

  /** Evaluate an internal expression in a scope and return its JSON value; page exceptions throw. */
  async evalIn(scope: Scope, expression: string): Promise<unknown> {
    const res = await scope.session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(scope.contextId !== undefined ? { contextId: scope.contextId } : {}),
    });
    if (res.exceptionDetails) throw new Error(String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text).split("\n")[0]);
    return res.result?.value;
  }

  /** Call `fn` (a function declaration) with `this` the element; returns its JSON value. */
  async callOn(el: ElementHandle, fn: string, args: unknown[] = []): Promise<unknown> {
    const res = await el.scope.session.send("Runtime.callFunctionOn", {
      objectId: el.objectId,
      functionDeclaration: fn,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
      // focus() in a cross-origin iframe needs a user gesture.
      userGesture: true,
    });
    if (res.exceptionDetails) throw new Error(String(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text).split("\n")[0]);
    return res.result?.value;
  }

  release(el: ElementHandle): void {
    void el.scope.session.send("Runtime.releaseObject", { objectId: el.objectId }).catch(() => {});
  }

  /** The <iframe> element holding a frame, in its parent's scope; null for the main frame. */
  async owner(frameId: string): Promise<ElementHandle | null> {
    if (frameId === this.mainId()) return null;
    const f = this.frames.get(frameId);
    const parent = f?.parentId !== undefined ? this.scopeOf(f.parentId) : null;
    if (!parent) throw new FrameError("The frame's page changed; look it up again.");
    const { backendNodeId } = await parent.session.send("DOM.getFrameOwner", { frameId });
    const { object } = await parent.session.send("DOM.resolveNode", {
      backendNodeId,
      ...(parent.contextId !== undefined ? { executionContextId: parent.contextId } : {}),
    });
    return { scope: parent, objectId: object.objectId };
  }

  /**
   * A point in a frame's viewport as a point in the tab's viewport, adding each <iframe>'s content
   * box offset on the way up. `covered`: at some level something else is on top of the iframe there.
   */
  async toPage(frameId: string, point: { x: number; y: number }): Promise<{ x: number; y: number; covered: boolean }> {
    let { x, y } = point;
    let covered = false;
    let id = frameId;
    for (let depth = 0; id !== this.mainId(); depth++) {
      if (depth > 32) throw new FrameError("The frames are nested too deeply.");
      const owner = await this.owner(id);
      if (!owner) break;
      try {
        const r = (await this.callOn(owner, OFFSET_IN_PARENT, [x, y])) as { x: number; y: number; hit: boolean };
        ({ x, y } = r);
        if (!r.hit) covered = true;
      } finally {
        this.release(owner);
      }
      id = owner.scope.frameId;
    }
    return { x, y, covered };
  }

  /**
   * Wait until input just sent has reached the page's out-of-process iframes. Chrome acknowledges
   * an input event once it has routed it, before another renderer has run its handlers; an animation
   * frame in each of those renderers comes after them. Without such iframes there's nothing to wait for.
   */
  async flushInput(): Promise<void> {
    const others = new Map<string, Scope>();
    for (const f of this.frames.values()) {
      if (f.contextId === undefined || f.session.id === this.root.id || others.has(f.session.id)) continue;
      others.set(f.session.id, { frameId: f.id, session: f.session, contextId: f.contextId });
    }
    const frame = "new Promise((r) => requestAnimationFrame(() => r(true)))";
    await Promise.all([...others.values()].map((s) => Promise.race([this.evalIn(s, frame).catch(() => {}), Bun.sleep(500)])));
  }

  /**
   * Give a frame keyboard focus from the top down (each <iframe> element focused in its parent),
   * so focusing an element inside it focuses the page there too.
   */
  async focusFrame(frameId: string): Promise<void> {
    const chain: string[] = [];
    for (let id = frameId; id !== this.mainId(); ) {
      chain.unshift(id);
      const parent = this.frames.get(id)?.parentId;
      if (!parent || chain.length > 32) break;
      id = parent;
    }
    for (const id of chain) {
      const owner = await this.owner(id);
      if (!owner) continue;
      try {
        await this.callOn(owner, "function () { this.focus({ preventScroll: true }); }");
      } finally {
        this.release(owner);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------

  /** The ref for a node of a frame: the one it already has, else a new one. */
  refFor(frameId: string, backendNodeId: number): string {
    const key = `${frameId}:${backendNodeId}`;
    let ref = this.refByNode.get(key);
    if (!ref) {
      ref = `e${this.nextRef++}`;
      this.refByNode.set(key, ref);
      this.refs.set(ref, { frameId, backendNodeId });
    }
    return ref;
  }

  /** The element a ref names. Throws when the ref is unknown or its frame has moved on. */
  async byRef(ref: string): Promise<ElementHandle> {
    const t = this.refs.get(ref.trim());
    if (!t) throw new Error(`No element has ref ${ref} in this tab. Take a browser_snapshot and use a ref from it.`);
    const stale = () => new Error(`Ref ${ref} is stale: its page or frame changed since the snapshot. Take a new browser_snapshot.`);
    const scope = this.scopeOf(t.frameId);
    if (!scope) throw stale();
    try {
      const { object } = await scope.session.send("DOM.resolveNode", {
        backendNodeId: t.backendNodeId,
        ...(scope.contextId !== undefined ? { executionContextId: scope.contextId } : {}),
      });
      if (!object?.objectId) throw stale();
      return { scope, objectId: object.objectId };
    } catch {
      throw stale();
    }
  }
}

/**
 * Runs on an <iframe> element in its parent: (x, y) in the iframe's viewport as a point in the
 * parent's, and whether the iframe is what's at that point there.
 */
const OFFSET_IN_PARENT = `function (x, y) {
  const r = this.getBoundingClientRect();
  const cs = getComputedStyle(this);
  const px = r.left + this.clientLeft + (parseFloat(cs.paddingLeft) || 0) + x;
  const py = r.top + this.clientTop + (parseFloat(cs.paddingTop) || 0) + y;
  const hit = document.elementFromPoint(px, py);
  return { x: px, y: py, hit: hit === this };
}`;
