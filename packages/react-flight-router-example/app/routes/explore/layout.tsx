import { ExploreLayout } from "./explore-layout.js";

export default function ExploreRoot({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={0} params={params ?? {}} />;
}
