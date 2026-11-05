import { useRouter, matchPath } from "./router";
import { Layout } from "./components/layout";
import { LandingPage } from "./pages/landing";
import { DocPage } from "./pages/doc-page";
import { NotFoundPage } from "./pages/not-found";

export function App() {
  const { pathname } = useRouter();

  if (pathname === "/" || pathname === "") {
    return <LandingPage />;
  }

  const docMatch = matchPath("/docs/:section/:slug", pathname);
  if (docMatch) {
    const { section, slug } = docMatch.params;
    return (
      <Layout>
        <DocPage slug={`${section}/${slug}`} />
      </Layout>
    );
  }

  return (
    <Layout>
      <NotFoundPage />
    </Layout>
  );
}
