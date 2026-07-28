import { Routes, Route, Link } from 'react-router-dom'
import { Layout } from './components/Layout'
import { ProtectedRoute } from './components/ProtectedRoute'
import { Button } from './components/ui/Button'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { Agents } from './pages/Agents'
import { Workflows } from './pages/Workflows'
import { Runs } from './pages/Runs'

function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="font-brand text-7xl font-bold">404</div>
      <p className="mt-2 text-ink/60">Halaman ini nggak ada di orchestrator.</p>
      <Link to="/" className="mt-6">
        <Button variant="primary">Balik ke Dashboard</Button>
      </Link>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />

      {/* Protected — semua halaman app butuh login */}
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/agents" element={<Agents />} />
                <Route path="/workflows" element={<Workflows />} />
                <Route path="/runs" element={<Runs />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Layout>
          </ProtectedRoute>
        }
      />
    </Routes>
  )
}
