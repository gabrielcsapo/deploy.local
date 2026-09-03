import { catalogUiReleases } from './data.ts';
import CatalogBrowseClient from './CatalogBrowse.client.tsx';

export default function CatalogRoute() {
  return <CatalogBrowseClient releases={catalogUiReleases()} />;
}
