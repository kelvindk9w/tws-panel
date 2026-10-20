import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initLocale } from "./i18n";
import "./index.css";

// idioma antes do primeiro render: preferência guardada ou idioma do navegador
initLocale();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
