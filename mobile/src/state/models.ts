import { useEffect, useSyncExternalStore } from "react";
import type { HarnessClient } from "@harness/shared";
import { modelCacheFor } from "@harness/shared/state";

/** The model list for a driver (shared ModelListCache); refetches on driver or epoch change. */
export function useDriverModels(client: HarnessClient, driverId: string, epoch = 0) {
  const cache = modelCacheFor(client);
  const state = useSyncExternalStore(cache.subscribe, () => cache.get(driverId));
  useEffect(() => {
    cache.syncEpoch(epoch);
    void cache.load(driverId);
  }, [cache, driverId, epoch]);
  return { ...state, refresh: () => cache.load(driverId, true) };
}
