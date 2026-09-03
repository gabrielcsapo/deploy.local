import { catalogUiReleases } from './data.ts';
import CatalogDetailClient from './CatalogDetail.client.tsx';

export default function CatalogDetailRoute() {
  return <CatalogDetailClient releases={catalogUiReleases()} />;
}
