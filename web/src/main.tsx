import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate, Link, NavLink, useLocation } from 'react-router-dom';
import { WalletProvider } from './wallet';
import './styles.css';

import Landing from './pages/Landing';
import Dashboard from './pages/Dashboard';
import Approve from './pages/Approve';
import Send from './pages/Send';
import Members from './pages/Members';
import RequestPage from './pages/Request';
import Pay from './pages/Pay';
import Tip from './pages/Tip';

function Tabs() {
  const { pathname } = useLocation();
  // Signed-out landing page and public pay links have no tabs.
  if (pathname === '/' || pathname.startsWith('/pay/') || pathname.startsWith('/tip/')) return null;
  const cls = ({ isActive }: { isActive: boolean }) => `tab${isActive ? ' on' : ''}`;
  return (
    <nav className="tabs" aria-label="Sections">
      <NavLink to="/dashboard" className={cls}>Account</NavLink>
      <NavLink to="/send" className={cls}>Send</NavLink>
      <NavLink to="/request" className={cls}>Request</NavLink>
      <NavLink to="/members" className={cls}>Members</NavLink>
    </nav>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <header className="masthead">
        <span className="brand">
          <Link to="/">
            <span className="brand-dot">X</span>
            XLedger
          </Link>
        </span>
        <span className="muted" style={{ fontSize: '0.85rem' }}>You sign every transfer</span>
      </header>
      <Tabs />
      {children}
    </div>
  );
}

function App() {
  return (
    <WalletProvider>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/approve/:id" element={<Approve />} />
            <Route path="/send" element={<Send />} />
            <Route path="/members" element={<Members />} />
            <Route path="/request" element={<RequestPage />} />
            <Route path="/pay/:id" element={<Pay />} />
            <Route path="/tip/:handle" element={<Tip />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </WalletProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
