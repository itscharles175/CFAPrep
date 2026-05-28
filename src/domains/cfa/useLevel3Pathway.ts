import { useEffect, useState } from 'react';
import {
  LEVEL3_PATHWAY_EVENT,
  level3PathwayFromStorage,
  normalizeLevel3Pathway,
  writeLevel3PathwayToStorage,
} from './cfaLevel3Pathways';
import type { Level3Pathway } from './cfaLevel3Pathways';

export type UseLevel3PathwayResult = [Level3Pathway, (pathway: string | null | undefined) => void];

export function useLevel3Pathway(): UseLevel3PathwayResult {
  const [activePathway, setActivePathwayState] = useState<Level3Pathway>(() => level3PathwayFromStorage());

  useEffect(() => {
    function handlePathwayChange(event: Event) {
      const detail = (event as CustomEvent<{ pathway?: string }>).detail;
      setActivePathwayState(normalizeLevel3Pathway(detail?.pathway));
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === 'quantvault:level3-pathway') setActivePathwayState(normalizeLevel3Pathway(event.newValue));
    }

    window.addEventListener(LEVEL3_PATHWAY_EVENT, handlePathwayChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(LEVEL3_PATHWAY_EVENT, handlePathwayChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  function setActivePathway(pathway: string | null | undefined) {
    setActivePathwayState(writeLevel3PathwayToStorage(pathway));
  }

  return [activePathway, setActivePathway];
}
