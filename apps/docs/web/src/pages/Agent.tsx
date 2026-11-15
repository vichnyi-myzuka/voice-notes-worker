import { ChartGrid } from "../components/Page";
import { Features, HowCards } from "../components/Sections";
import { AgentFlow, AgentModules, GithubFlow, HandoffFlow, JobsWatcher, PortsAdapters, PostsForms, SessionLifecycle } from "../diagrams";

export default function Agent() {
  return (
    <>
      <HowCards page="agent" />
      <ChartGrid>
        <AgentFlow />
        <AgentModules />
        <SessionLifecycle />
        <JobsWatcher />
        <PostsForms />
        <HandoffFlow />
        <PortsAdapters />
        <GithubFlow />
      </ChartGrid>
      <Features page="agent" />
    </>
  );
}
