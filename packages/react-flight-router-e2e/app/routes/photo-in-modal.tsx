import { Link } from "react-flight-router/client";
import PhotoPage from "./photo.js";

export default function PhotoInModal({ params }: { params?: Record<string, string> }) {
  return (
    <>
      <PhotoPage params={params} />
      {params?.id && (
        <div className="mt-4 pt-4 border-t border-gray-200">
          <Link
            to={`/photo/${params.id}`}
            data-testid="open-full-page"
            className="text-blue-600 underline"
          >
            Open full page →
          </Link>
        </div>
      )}
    </>
  );
}
