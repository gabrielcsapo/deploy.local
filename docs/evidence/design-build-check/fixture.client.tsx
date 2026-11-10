import { createRoot } from 'react-dom/client';
import { V2Layout } from '../../../app/routes/dashboard/v2-layout.client';
import Task from '../../../app/routes/dashboard/v2/tasks/page.client';
import Inbox from '../../../app/routes/dashboard/v2/inbox/page.client';
import { setContent } from '../board-parity/fixture-router';
import '../../../app/design-tokens.css';
localStorage.setItem('deploy-v2-first-task-seen', 'yes');
setContent(location.pathname.startsWith('/dashboard/tasks/') ? <Task /> : <Inbox />);
createRoot(document.getElementById('root')!).render(<V2Layout />);
