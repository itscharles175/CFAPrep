import { useEffect, useState } from 'react';
import {
  LEVEL3_PATHWAY_EVENT,
  level3PathwayFromStorage,
  normalizeLevel3Pathway,
  writeLevel3PathwayToStorage,
} from './cfaLevel3Pathways';

export function useLevel3Pathway() {
  const [activePathway, setActivePathwayState] = useState(() => level3PathwayFromStorage());

  useEffect(() => {
    function handlePathwayChange(event) {
      setActivePathwayState(normalizeLevel3Pathway(event.detail?.pathway));
    }

    function handleStorage(event) {
      if (event.key === 'quantvault:level3-pathway') setActivePathwayState(normalizeLevel3Pathway(event.newValue));
    }

    window.addEventListener(LEVEL3_PATHWAY_EVENT, handlePathwayChange);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(LEVEL3_PATHWAY_EVENT, handlePathwayChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  function setActivePathway(pathway) {
    setActivePathwayState(writeLevel3PathwayToStorage(pathway));
  }

  return [activePathway, setActivePathway];
}
