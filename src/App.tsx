// Root component — immediately.run renders the default export of THIS file.
// The embedded-agent demo (UI_AS_APPS_SPEC §5.5 / §5.9 / G12): an app reads its
// own grant-FILTERED method catalog and treats it as the agent's tool list. Any
// "agent" — here a manual/scripted tool-runner standing in for an LLM — can only
// drive the methods in that list; naming a method OUTSIDE it still hits the §8.4
// gate and returns `forbidden`. Agent confinement therefore equals APP
// confinement: it falls out of the capability model, with no agent sandbox.
import "./index.css";
import AgentDemo from "./components/AgentDemo";

function App() {
  return <AgentDemo />;
}

export default App;
