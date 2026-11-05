import { ExploreLayout } from "./explore-layout.js";

export default function ContinentLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={5} params={params ?? {}} />;
}
