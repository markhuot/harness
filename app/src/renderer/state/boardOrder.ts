// The board's "Sort by" and "Group by project" choices (shared/src/state/boardSort.ts), remembered
// per machine in localStorage. Every board on screen follows a change made in any of them.

import { useCallback, useEffect, useState } from "react";
import { BOARD_ORDER_CHANGED, readBoardSort, readGroupByProject, writeBoardSort, writeGroupByProject, type BoardSort } from "@harness/shared/state";

export function useBoardOrder() {
  const [sort, setSortState] = useState(readBoardSort);
  const [groupByProject, setGroupState] = useState(readGroupByProject);
  useEffect(() => {
    const on = () => {
      setSortState(readBoardSort());
      setGroupState(readGroupByProject());
    };
    addEventListener(BOARD_ORDER_CHANGED, on);
    return () => removeEventListener(BOARD_ORDER_CHANGED, on);
  }, []);
  const setSort = useCallback((next: BoardSort) => {
    writeBoardSort(next);
    dispatchEvent(new Event(BOARD_ORDER_CHANGED));
  }, []);
  const toggleGroupByProject = useCallback(() => {
    writeGroupByProject(!readGroupByProject());
    dispatchEvent(new Event(BOARD_ORDER_CHANGED));
  }, []);
  return { sort, setSort, groupByProject, toggleGroupByProject };
}
