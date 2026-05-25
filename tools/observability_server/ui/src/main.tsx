// `./bootstrap` MUST be the first import so its capture runs before
// any other module's top-level code. See bootstrap.ts.
import { bootstrap } from "./bootstrap";

import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { App } from "./App";
import { Instructions } from "./components/Instructions";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Refetch intervals are configured per query — global default off.
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5_000,
    },
  },
});

async function exchangeIfNeeded(): Promise<"ok" | "instructions" | "framed"> {
  if (bootstrap.framed) return "framed";
  if (bootstrap.code !== null) {
    try {
      const resp = await fetch("/api/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: bootstrap.code }),
        credentials: "same-origin",
      });
      if (resp.status === 204) return "ok";
    } catch {
      // network errors fall through to the cookie probe
    }
  }
  // Either no code (page reloaded after exchange), or the exchange
  // failed. Probe an authenticated endpoint to decide which.
  try {
    const probe = await fetch("/api/runs?limit=1", {
      method: "GET",
      credentials: "same-origin",
    });
    if (probe.ok) return "ok";
  } catch {
    // ignore
  }
  return "instructions";
}

function mount(content: React.ReactElement): void {
  const root = document.getElementById("root");
  if (root === null) return;
  createRoot(root).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>
    </React.StrictMode>,
  );
}

void exchangeIfNeeded().then((status) => {
  if (status === "ok") {
    mount(<App />);
  } else if (status === "framed") {
    mount(<Instructions reason="framed" />);
  } else {
    mount(<Instructions reason="unauthorized" />);
  }
});
