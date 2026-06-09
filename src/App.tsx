// Root component — immediately.run renders the default export of THIS file.
// Agent confinement equals APP confinement (UI_AS_APPS_SPEC §5.5 / §5.9 / G12):
// an app reads its own grant-FILTERED method catalog and treats it as the agent's
// tool list; naming a method OUTSIDE it still hits the §8.4 gate and returns
// `forbidden`. CodingAgent is a REAL LLM tool-use loop over that catalog
// (LLM_AND_AGENTS_SPEC §3.3); AgentDemo below is the original scripted tool-runner
// + task/IPC demos.
import "./index.css";
import CodingAgent from "./components/CodingAgent";
import AgentDemo from "./components/AgentDemo";

function App() {
  return (
    <>
      <CodingAgent />
      <AgentDemo />
    </>
  );
}

export default App;
