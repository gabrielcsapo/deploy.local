import { ExploreLayout } from "./explore-layout.js";

export default function UniverseLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={1} params={params ?? {}} />;
}
