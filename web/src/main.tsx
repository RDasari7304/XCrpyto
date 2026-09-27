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

function Tabs() {
  const { pathname } = useLocation();
  // Signed-out landing page has no tabs.
  if (pathname === '/') return null;
  const cls = ({ isActive }: { isActive: boolean }) => `tab${isActive ? ' on' : ''}`;
  return (
    <nav className="tabs" aria-label="Sections">
      <NavLink to="/dashboard" className={cls}>Account</NavLink>
      <NavLink to="/send" className={cls}>Send</NavLink>
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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </WalletProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
