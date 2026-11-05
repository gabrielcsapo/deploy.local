import { ExploreLayout } from "./explore-layout.js";

export default function CityLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={8} params={params ?? {}} />;
}
