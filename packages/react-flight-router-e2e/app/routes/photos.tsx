import { Link } from "react-flight-router/client";

const PHOTOS = [
  { id: "1", title: "Sunset", color: "#fb923c" },
  { id: "2", title: "Forest", color: "#22c55e" },
  { id: "3", title: "Ocean", color: "#3b82f6" },
  { id: "4", title: "Desert", color: "#f59e0b" },
];

export default function PhotosPage() {
  return (
    <div data-testid="photos-page">
      <h1 className="text-3xl font-bold mb-2">Photos</h1>
      <p className="text-gray-600 mb-6">
        Click a thumbnail to open it in a modal (parallel route slot). Direct-visit
        <code className="mx-1 px-1 bg-gray-200 rounded">/photo/&lt;id&gt;</code>
        to render the full page instead.
      </p>
      <ul className="grid grid-cols-2 sm:grid-cols-4 gap-4 list-none p-0">
        {PHOTOS.map((p) => (
          <li key={p.id}>
            <Link
              to={`/photo/${p.id}`}
              intoSlot="modal"
              data-testid={`photo-thumb-${p.id}`}
              className="block rounded-lg overflow-hidden shadow hover:shadow-md transition"
            >
              <div
                className="aspect-square flex items-end p-3 text-white font-medium"
                style={{ backgroundColor: p.color }}
              >
                {p.title}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
