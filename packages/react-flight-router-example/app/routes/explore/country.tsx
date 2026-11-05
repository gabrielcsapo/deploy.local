import { ExploreLayout } from "./explore-layout.js";

export default function CountryLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={6} params={params ?? {}} />;
}
