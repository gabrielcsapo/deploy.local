import { ExploreLayout } from "./explore-layout.js";

export default function GalaxyLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={2} params={params ?? {}} />;
}
