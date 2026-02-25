import { ExploreLayout } from "./explore-layout.js";

export default function FloorLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={12} params={params ?? {}} />;
}
