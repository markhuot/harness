// Lazily loaded chunks that can fail to load (a rebuilt app whose old chunk is gone, a flaky disk)
// without taking down what renders them. React.lazy remembers a rejected import forever, so a
// retry needs a fresh lazy component: retryableLazy hands out the current one and makes a new one
// after a failure, and ChunkBoundary shows the fallback (with a retry) instead of the error.
// Chromium also remembers a failed import() of a URL for the page's life, so a retry within the
// page only helps where that failure wasn't the fetch itself; the file pane's retry reloads.

import { Component, lazy, type ComponentType, type ReactNode } from "react";

export interface RetryableLazy<P> {
  /** The component to render now (read it during render, under a ChunkBoundary). */
  Component: ComponentType<P>;
  /** Forget a failed load, so the next render imports it again. */
  reset(): void;
}

export function retryableLazy<P extends object>(load: () => Promise<ComponentType<P>>): RetryableLazy<P> {
  const make = () => lazy(() => load().then((c) => ({ default: c })));
  let current = make();
  const Current = (props: P) => {
    const C = current;
    return <C {...props} />;
  };
  return {
    Component: Current,
    reset: () => void (current = make()),
  };
}

/**
 * Catches a chunk that failed to load (or anything else its children throw) and renders
 * `fallback(retry)`; `retry` resets the given lazies and renders the children again.
 */
export class ChunkBoundary extends Component<{ lazies: Pick<RetryableLazy<never>, "reset">[]; fallback: (retry: () => void) => ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    // The next mount (or a retry) imports again instead of rethrowing the remembered failure.
    for (const l of this.props.lazies) l.reset();
  }
  retry = () => this.setState({ failed: false });
  render() {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}
