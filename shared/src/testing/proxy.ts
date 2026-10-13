// A proxy in front of a test daemon for what the daemon can't be asked to do: answer a route with a
// fixed body (the dummy driver reports no plan usage), watch what a client sends over the event
// socket (the browser input the app forwards), or push an event the daemon never emitted. HTTP and
// WebSocket traffic otherwise passes through untouched. Not imported by production code.

type Upstream = { url: string; headers: Record<string, string>; up?: WebSocket; queue: string[] };
type Client = { data: Upstream; send(data: string): void; close(): void };

export type DaemonProxyOptions = {
  /** Answer a request instead of forwarding it: return a Response, or undefined to forward. */
  intercept?: (req: Request) => Response | undefined | Promise<Response | undefined>;
  /** Called with every message a client socket sends, before it goes upstream. */
  onClientMessage?: (message: string) => void;
};

export type DaemonProxy = {
  base: string;
  /** Send an event to every connected client, the way the daemon's event socket does. */
  push(event: Record<string, unknown>): void;
  /** How many client sockets are open. */
  readonly clients: number;
  stop(): void;
};

/** `target` may be a function when the daemon isn't up yet at the time the proxy starts. */
export function startDaemonProxy(target: string | (() => string), opts: DaemonProxyOptions = {}): DaemonProxy {
  const clients = new Set<Client>();
  const server = Bun.serve<Upstream>({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const upstream = `${typeof target === "function" ? target() : target}${url.pathname}${url.search}`;
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => {
          if (/^(authorization|cookie|x-)/i.test(k)) headers[k] = v;
        });
        if (srv.upgrade(req, { data: { url: upstream.replace(/^http/, "ws"), headers, queue: [] } })) return undefined as unknown as Response;
        return new Response("upgrade failed", { status: 400 });
      }
      const answered = await opts.intercept?.(req);
      if (answered) return answered;
      // A daemon that is down (a restart test) answers 502 rather than failing the proxy.
      return fetch(upstream, { method: req.method, headers: req.headers, body: req.body, redirect: "manual" }).catch(() => new Response("the daemon is not answering", { status: 502 }));
    },
    websocket: {
      open(ws: Client) {
        clients.add(ws);
        const up = new WebSocket(ws.data.url, { headers: ws.data.headers } as never);
        ws.data.up = up;
        up.onopen = () => {
          for (const m of ws.data.queue) up.send(m);
          ws.data.queue = [];
        };
        up.onmessage = (e) => {
          try {
            ws.send(typeof e.data === "string" ? e.data : String(e.data));
          } catch {}
        };
        up.onclose = () => {
          try {
            ws.close();
          } catch {}
        };
      },
      message(ws: Client, m: string | Buffer) {
        const text = String(m);
        opts.onClientMessage?.(text);
        const up = ws.data.up;
        if (up?.readyState === WebSocket.OPEN) up.send(text);
        else ws.data.queue.push(text);
      },
      close(ws: Client) {
        clients.delete(ws);
        try {
          ws.data.up?.close();
        } catch {}
      },
    } as never,
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    push(event) {
      for (const c of clients) {
        try {
          c.send(JSON.stringify({ type: "event", event }));
        } catch {}
      }
    },
    get clients() {
      return clients.size;
    },
    stop: () => server.stop(true),
  };
}
