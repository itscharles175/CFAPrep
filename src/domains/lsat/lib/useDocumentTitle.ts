import { useEffect } from "react";

/**
 * Sets `document.title` declaratively. Reverts to the previous title when the
 * component unmounts, so nested routes don't leave stale titles behind.
 */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}
