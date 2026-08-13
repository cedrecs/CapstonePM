import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { GuildLayout } from './pages/GuildLayout'
import { Landing } from './pages/Landing'
import { ProjectPage } from './pages/ProjectPage'
import { ProjectsPage } from './pages/ProjectsPage'
import { SettingsPage } from './pages/SettingsPage'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5000, retry: 1 } }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/g/:guildId" element={<GuildLayout />}>
            <Route index element={<Navigate to="p" replace />} />
            <Route path="p" element={<ProjectsPage />} />
            <Route path="p/:projectId" element={<ProjectPage />} />
            <Route path="p/:projectId/t/:taskId" element={<ProjectPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
)
