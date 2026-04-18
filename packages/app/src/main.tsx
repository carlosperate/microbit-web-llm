import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import type { ChatCompletionFn } from "./chat/tool-loop.js";
import "./styles.css";

declare global {
  interface Window {
    __mockChatCompletion?: ChatCompletionFn;
  }
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");
const mockCompletion = window.__mockChatCompletion;
createRoot(container).render(
  <React.StrictMode>
    <App mockCompletion={mockCompletion} />
  </React.StrictMode>,
);
