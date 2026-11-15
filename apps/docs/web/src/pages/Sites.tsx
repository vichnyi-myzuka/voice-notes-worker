import { ChartGrid } from "../components/Page";
import { Features, HowCards } from "../components/Sections";
import { McpFlow, SitesFlow } from "../diagrams";

export default function Sites() {
  return (
    <>
      <HowCards page="sites" />
      <ChartGrid>
        <SitesFlow />
        <McpFlow />
      </ChartGrid>
      <Features page="sites" />
    </>
  );
}
