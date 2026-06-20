// Root component — immediately.run renders the default export of THIS file.
// Agent confinement equals APP confinement (UI_AS_APPS_SPEC §5.5 / §5.9 / G12):
// an app reads its own grant-FILTERED method catalog and treats it as the agent's
// tool list; naming a method OUTSIDE it still hits the §8.4 gate and returns
// `forbidden`.
//
// The agents activity mounts this SAME app in two regions (§4.1): the panel slot
// (`panel.agent`) shows the conversation LIST, the stage slot
// (`stage.conversation`) shows the SELECTED conversation. We branch on
// `getRegion()` so one app, one conversation store, serves both. Standalone (no
// region) keeps the original combined demo.
import "./index.css";
import { useRegion } from "@immediately-run/sdk";
import ConversationList from "./components/ConversationList";
import ConversationStage from "./components/ConversationStage";
import CodingAgent from "./components/CodingAgent";
import AgentDemo from "./components/AgentDemo";

function App() {
  const region = useRegion();
  if (region === "panel.agent") return <ConversationList />;
  if (region === "stage.conversation") return <ConversationStage />;
  return (
    <>
      <CodingAgent />
      <AgentDemo />
    </>
  );
}

export default App;

