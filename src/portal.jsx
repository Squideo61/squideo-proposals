import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import PortalApp from './portal/PortalApp.jsx';

createRoot(document.getElementById('portal-root')).render(<PortalApp />);
