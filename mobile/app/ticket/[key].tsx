import { useLocalSearchParams } from "expo-router";
import { requireStore } from "../../src/screens/RequireStore";
import { TicketDetailScreen } from "../../src/screens/TicketDetail";
import { FileLinkScope } from "../../src/ui/fileLinks";

// File links in the ticket's messages, summaries and brief open in its own folder.
function TicketRoute() {
  const { key } = useLocalSearchParams<{ key: string }>();
  return (
    <FileLinkScope ticketKey={key}>
      <TicketDetailScreen />
    </FileLinkScope>
  );
}

export default requireStore(TicketRoute);
