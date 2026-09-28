import { requireStore } from "../../../src/screens/RequireStore";
import { BoardScreen } from "../../../src/screens/Board";

function SearchScreen() {
  return <BoardScreen mode="search" />;
}

export default requireStore(SearchScreen);
