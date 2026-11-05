import { ExploreLayout } from "./explore-layout.js";

export default function SystemLayout({ params }: { params?: Record<string, string> }) {
  return <ExploreLayout level={3} params={params ?? {}} />;
}
