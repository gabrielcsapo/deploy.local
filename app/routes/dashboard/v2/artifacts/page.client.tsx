'use client';
import { useLocation, useSearchParams } from 'react-flight-router/client';
import { Gallery } from './Gallery';
import { DocumentView } from './Document';
import { galleryPath } from './model';
import './artifacts.css';

export default function ArtifactsPage() {
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const [projectId, artifact] = pathname
    .slice(galleryPath.length + 1)
    .split('/')
    .map((part) => decodeURIComponent(part));
  if (projectId && artifact)
    return (
      <DocumentView
        key={`${projectId}/${artifact}`}
        projectId={projectId}
        artifact={artifact}
        initialRef={params.get('ref')}
        reviewId={params.get('review')}
      />
    );
  return <Gallery />;
}
