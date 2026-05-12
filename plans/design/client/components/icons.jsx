/* Icons — minimal stroke style, currentColor */
const I = (paths, viewBox = "0 0 24 24") => ({ size = 16, className = "icon", ...p }) => (
  <svg width={size} height={size} viewBox={viewBox} fill="none" stroke="currentColor"
       strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className={className} {...p}>
    {paths}
  </svg>
);

const Icons = {
  Home: I(<><path d="M3 11l9-7 9 7" /><path d="M5 10v10h14V10" /></>),
  Flows: I(<><circle cx="6" cy="6" r="2.2" /><circle cx="18" cy="12" r="2.2" /><circle cx="6" cy="18" r="2.2" /><path d="M8 7l8 4" /><path d="M8 17l8-4" /></>),
  Template: I(<><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M3.5 9h17" /><path d="M8 14h7" /><path d="M8 17h5" /></>),
  Broadcast: I(<><path d="M3 11v2l13 5V6z" /><path d="M16 9a3 3 0 010 6" /></>),
  Contacts: I(<><circle cx="9" cy="9" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="8" r="2.5" /><path d="M15.5 14.2A5 5 0 0121 19" /></>),
  Send: I(<><path d="M22 2L11 13" /><path d="M22 2l-7 20-4-9-9-4z" /></>),
  Shield: I(<><path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6z" /></>),
  Audit: I(<><path d="M5 4h11l4 4v12a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1z" /><path d="M14 4v5h5" /><path d="M8 13h8" /><path d="M8 16h5" /></>),
  Health: I(<><path d="M3 12h4l2-6 4 12 2-6h6" /></>),
  Search: I(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>),
  Bell: I(<><path d="M6 8a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6z" /><path d="M10 19a2 2 0 004 0" /></>),
  Plus: I(<><path d="M12 5v14" /><path d="M5 12h14" /></>),
  Sun: I(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  Moon: I(<><path d="M20 14.5A8 8 0 1110.5 4a6 6 0 009.5 10.5z" /></>),
  Chevron: I(<><path d="M9 6l6 6-6 6" /></>),
  ChevronDown: I(<><path d="M6 9l6 6 6-6" /></>),
  Clock: I(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>),
  Mail: I(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>),
  Branch: I(<><path d="M6 3v6" /><path d="M6 15v6" /><circle cx="6" cy="12" r="2.5" /><path d="M18 3v6" /><circle cx="18" cy="12" r="2.5" /><path d="M18 15v6" /><path d="M8.5 12h7" /></>),
  Tag: I(<><path d="M3 12l8-8h8v8l-8 8z" /><circle cx="14.5" cy="9.5" r="1.2" /></>),
  Exit: I(<><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /><path d="M12 21H5a2 2 0 01-2-2V5a2 2 0 012-2h7" /></>),
  Webhook: I(<><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><circle cx="12" cy="6" r="2.5" /><path d="M8 17l3-6" /><path d="M16 17l-3-6" /></>),
  Play: I(<><path d="M7 4v16l13-8z" /></>),
  Pause: I(<><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></>),
  Filter: I(<><path d="M3 4h18l-7 9v6l-4 2v-8z" /></>),
  Download: I(<><path d="M12 4v12" /><path d="M7 11l5 5 5-5" /><path d="M4 20h16" /></>),
  Eye: I(<><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>),
  Cursor: I(<><path d="M5 3l14 8-6 2-2 6z" /></>),
  Edit: I(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 113 3L7 19l-4 1 1-4z" /></>),
  Copy: I(<><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V4a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2h4" /></>),
  Code: I(<><path d="M16 18l6-6-6-6" /><path d="M8 6l-6 6 6 6" /></>),
  Dots: I(<><circle cx="6" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="18" cy="12" r="1.5" /></>),
  Settings: I(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></>),
  Help: I(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 015 0c0 1.5-2.5 2-2.5 3.5" /><circle cx="12" cy="17" r="0.6" fill="currentColor" /></>),
  Check: I(<><path d="M4 12l5 5 11-11" /></>),
  X: I(<><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>),
  Calendar: I(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18" /><path d="M8 3v4M16 3v4" /></>),
  Warn: I(<><path d="M12 3l10 18H2z" /><path d="M12 10v5" /><circle cx="12" cy="18" r="0.6" fill="currentColor" /></>),
  Activity: I(<><path d="M3 12h4l3-9 4 18 3-9h4" /></>),
  Rocket: I(<><path d="M5 19c0-3 1-6 6-11l4 4c-5 5-8 6-11 6 0-3 0-3 1-6" /><path d="M14 6l4 4" /><circle cx="15" cy="9" r="1.5" /></>),
  Grid: I(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>),
  Sparkles: I(<><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M16 8l2-2M6 18l2-2" /></>),
};

window.Icons = Icons;
