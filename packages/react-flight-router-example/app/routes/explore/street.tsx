import { ExploreLayout } from "./explore-layout.js";

export default function StreetLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={10} params={params ?? {}} />;
}
