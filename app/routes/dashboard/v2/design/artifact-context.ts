import { createContext, useContext } from 'react';

/** The artifact the open canvas shows; null for a project's App design in design/. */
export const DesignArtifact = createContext<string | null>(null);
export const useDesignArtifact = () => useContext(DesignArtifact);
