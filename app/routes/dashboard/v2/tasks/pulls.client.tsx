'use client';
import { useLocation } from 'react-flight-router/client';
import PullRequest from './pull.client';
import './style.css';
import './pulls.css';

/** A pull request's own page. The list of them is part of the project's Work tab. */
export default function PullRequests() {
  const { pathname } = useLocation();
  const project = decodeURIComponent(pathname.split('/')[3] || '');
  const pullId = decodeURIComponent(pathname.split('/')[5] || '');
  return pullId ? <PullRequest key={`${project}/${pullId}`} project={project} id={pullId} /> : null;
}
