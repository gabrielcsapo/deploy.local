import { ExploreLeaf } from "./explore-leaf.js";

export default function RoomPage({ params }: { params?: Record<string, string> }) {
  return <ExploreLeaf params={params ?? {}} />;
}
