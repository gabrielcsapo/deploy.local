export default async function BoundaryPage() {
  // Tiny await so the segment-map build does some real async work
  await new Promise((r) => setTimeout(r, 5));
  return (
    <div>
      <h1 className="text-3xl font-bold mb-4">Boundary Page</h1>
      <p className="text-gray-600" data-testid="boundary-page-marker">
        Server-rendered with loading + error boundaries configured.
      </p>
    </div>
  );
}
