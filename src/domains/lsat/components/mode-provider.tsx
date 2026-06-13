import { createContext, useContext, useState } from "react";

// The app has two "moods" (docs/02-ui.md):
//  - test:  minimal/calm. Hides streak + analytics, no AI feedback.
//  - study: data-rich. Dashboards, AI coach, error log.
export type AppMode = "study" | "test";

interface ModeState {
  mode: AppMode;
  setMode: (m: AppMode) => void;
}

const ModeContext = createContext<ModeState>({
  mode: "study",
  setMode: () => null,
});

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<AppMode>("study");
  return (
    <ModeContext.Provider value={{ mode, setMode }}>
      {children}
    </ModeContext.Provider>
  );
}

 
export function useMode() {
  return useContext(ModeContext);
}
