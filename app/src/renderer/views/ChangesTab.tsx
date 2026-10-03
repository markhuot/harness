// The built-in Changes tab (shared/src/state/changesTab.ts decides when a ticket has one). Its body,
// ChangesView.tsx, loads lazily: the diff viewer and file tree stay out of the main bundle until a
// ticket's Changes tab first opens.

import { Suspense } from "react";
import type { Ticket } from "@harness/shared";
import { Icon } from "../components/Icon";
import { ChunkBoundary, retryableLazy } from "../components/lazyRetry";

const view = retryableLazy(() => import("./ChangesView").then((m) => m.default));
const ChangesView = view.Component;

const loading = (
  <div className="empty" style={{ flex: 1 }}>
    <div className="spinner" />
  </div>
);

export function ChangesTab({ ticket }: { ticket: Ticket }) {
  return (
    <ChunkBoundary
      lazies={[view]}
      fallback={(retry) => (
        <div className="empty" style={{ flex: 1 }}>
          <Icon name="alert" />
          <strong>Couldn't load the Changes tab</strong>
          <button className="btn" onClick={retry}>
            Try again
          </button>
        </div>
      )}
    >
      <Suspense fallback={loading}>
        <ChangesView key={ticket.key} ticket={ticket} />
      </Suspense>
    </ChunkBoundary>
  );
}
