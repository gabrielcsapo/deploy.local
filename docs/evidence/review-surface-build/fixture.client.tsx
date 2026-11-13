import { ReviewRedirect } from '../../../app/routes/dashboard/v2/design/ReviewRedirect';
import { useInbox } from '../../../app/routes/dashboard/v2/data/hooks';
import { createRoot } from 'react-dom/client';
import { V2Layout } from '../../../app/routes/dashboard/v2-layout.client';
import Inbox from '../../../app/routes/dashboard/v2/inbox/page.client';
import Design from '../../../app/routes/dashboard/v2/design/page.client';
import { setContent } from '../board-parity/fixture-router';
import '../../../app/design-tokens.css';
const params = new URLSearchParams(location.search);
if (params.has('mac') || params.get('state') === 'Mac')
  document.documentElement.classList.add('deploy-desktop-mac');
function EmbeddedReview() {
  const inbox = useInbox();
  const item = inbox.items.find((entry) => entry.id === params.get('item'));
  return (
    <div
      style={{ width: '100%', maxWidth: 700, height: 'calc(100dvh - 104px)', margin: '52px auto' }}
    >
      {item && <ReviewRedirect item={item.id} />}
    </div>
  );
}
setContent(
  params.get('state') === 'Embedded' ? (
    <EmbeddedReview />
  ) : location.pathname === '/dashboard/design' ? (
    <Design />
  ) : (
    <Inbox />
  ),
);
createRoot(document.getElementById('root')!).render(<V2Layout />);
