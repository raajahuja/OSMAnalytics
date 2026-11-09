import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Analytics from "./Analytics";
import Countries from "./Countries";

const onCountriesPage = location.pathname.replace(/\/+$/, "") === "/countries";

createRoot(document.getElementById("root")!).render(
  <StrictMode>{onCountriesPage ? <Countries /> : <Analytics />}</StrictMode>,
);
