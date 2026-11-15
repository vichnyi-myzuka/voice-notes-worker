import { ChartGrid } from "../components/Page";
import { Features, HowCards } from "../components/Sections";
import { NotesLayers, NotesPipeline } from "../diagrams";

export default function Notes() {
  return (
    <>
      <HowCards page="notes" />
      <ChartGrid>
        <NotesPipeline />
        <NotesLayers />
      </ChartGrid>
      <Features page="notes" />
    </>
  );
}
