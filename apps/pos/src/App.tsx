import { useEffect, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toast } from './components/ui';
import Layout from './components/Layout';
import { bootstrap, disconnectSocket, useSync } from './lib/sync';
import AdminMenu from './pages/admin/AdminMenu';
import AdminSettings from './pages/admin/AdminSettings';
import AdminTables from './pages/admin/AdminTables';
import Floor from './pages/Floor';
import Login from './pages/Login';
import OrderPage from './pages/Order';
import OrdersList from './pages/OrdersList';
import Reports from './pages/Reports';
import SyncPage from './pages/SyncPage';
import { useAuth } from './store/auth';
import { useToast } from './store/toast';

export default function App() {
  const token = useAuth((s) => s.token);
  const { toasts, dismiss } = useToast();
  const bootstrapped = useSync((s) => s.bootstrapped);
  const [booting, setBooting] = useState(false);

  useEffect(() => {
    if (!token) {
      disconnectSocket();
      return;
    }
    setBooting(true);
    bootstrap().finally(() => setBooting(false));
  }, [token]);

  return (
    <HashRouter>
      {!token ? (
        <Login />
      ) : booting && !bootstrapped ? (
        <div className="flex h-full items-center justify-center text-slate-400">Loading outlet data…</div>
      ) : (
        <Layout>
          <Routes>
            <Route path="/" element={<Floor />} />
            <Route path="/order/:id" element={<OrderPage />} />
            <Route path="/orders" element={<OrdersList />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/sync" element={<SyncPage />} />
            <Route path="/admin/menu" element={<AdminMenu />} />
            <Route path="/admin/tables" element={<AdminTables />} />
            <Route path="/admin/settings" element={<AdminSettings />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Layout>
      )}
      <Toast toasts={toasts} dismiss={dismiss} />
    </HashRouter>
  );
}
