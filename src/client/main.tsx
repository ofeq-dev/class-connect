import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { LecturerApp } from "./lecturer/LecturerApp";
import { ProjectorPage } from "./projector/ProjectorPage";
import { StudentApp } from "./student/StudentApp";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/lecturer/*" element={<LecturerApp />} />
          <Route path="/p/:secret" element={<ProjectorPage />} />
          <Route path="*" element={<StudentApp />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
