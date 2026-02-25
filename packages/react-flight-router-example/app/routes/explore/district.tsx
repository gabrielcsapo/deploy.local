import { ExploreLayout } from "./explore-layout.js";

export default function DistrictLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={9} params={params ?? {}} />;
}
