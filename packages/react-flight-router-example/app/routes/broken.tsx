// This module intentionally throws during import to test error route handling.
throw new Error("This route is intentionally broken");

// eslint-disable-next-line no-unreachable
export default function Broken() {
  return <div>This should never render</div>;
}
