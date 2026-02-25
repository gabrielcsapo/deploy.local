import { ExploreLayout } from "./explore-layout.js";

export default function PlanetLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={4} params={params ?? {}} />;
}
