import { Link } from "react-flight-router/client";

const PHOTO_DATA: Record<string, { title: string; color: string; description: string }> = {
  "1": { title: "Sunset", color: "#fb923c", description: "A bright orange sunset over the hills." },
  "2": { title: "Forest", color: "#22c55e", description: "Deep green canopy, midday." },
  "3": { title: "Ocean", color: "#3b82f6", description: "Open water, no shore in sight." },
  "4": { title: "Desert", color: "#f59e0b", description: "Sand dunes at golden hour." },
};

export default function PhotoPage({ params }: { params?: Record<string, string> }) {
  const id = params?.id ?? "";
  const photo = PHOTO_DATA[id];

  if (!photo) {
    return (
      <div data-testid="photo-page-missing">
        <h1 className="text-3xl font-bold mb-4">Photo not found</h1>
        <Link to="/photos" className="text-blue-600 underline">
          Back to gallery
        </Link>
      </div>
    );
  }

  return (
    <div data-testid={`photo-page-${id}`}>
      <h1 className="text-3xl font-bold mb-4">{photo.title}</h1>
      <div
        className="w-full aspect-video rounded-lg mb-4"
        style={{ backgroundColor: photo.color }}
      />
      <p className="text-gray-700 mb-6">{photo.description}</p>
      <Link to="/photos" className="text-blue-600 underline">
        Back to gallery
      </Link>
    </div>
  );
}
