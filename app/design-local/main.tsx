import { createRoot } from 'react-dom/client';
import '../styles.css';
import { InboxProvider } from '../routes/dashboard/v2/data/hooks';
import DesignPage from '../routes/dashboard/v2/design/page.client';

createRoot(document.getElementById('root')!).render(
  <InboxProvider>
    <DesignPage />
  </InboxProvider>,
);
