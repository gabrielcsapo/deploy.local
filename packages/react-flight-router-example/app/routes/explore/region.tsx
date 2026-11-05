import { ExploreLayout } from "./explore-layout.js";

export default function RegionLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={7} params={params ?? {}} />;
}
