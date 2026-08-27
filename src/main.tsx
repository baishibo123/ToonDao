import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "@/App";
import "@/styles/base.css";
import "@/styles/app.css";
import "@/styles/tree.css";

// Dev-only handles, so the stores can be inspected from the console while
// working on the gestures. Not shipped: import.meta.env.DEV is statically
// false in a production build and the block is dropped.
if (import.meta.env.DEV) {
  void Promise.all([import("@/store/useStore"), import("@/store/useUI")]).then(
    ([store, ui]) => {
      Object.assign(window, { __store: store.useStore, __ui: ui.useUI });
    },
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
