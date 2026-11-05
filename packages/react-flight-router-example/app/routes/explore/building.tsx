import { ExploreLayout } from "./explore-layout.js";

export default function BuildingLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={11} params={params ?? {}} />;
}
