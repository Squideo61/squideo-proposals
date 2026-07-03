import React, { useEffect } from 'react';
import { CalendarDays, CheckSquare, AlertTriangle, Bell, ChevronRight, Clapperboard } from 'lucide-react';
import { BRAND } from '../../theme.js';
import { useStore } from '../../store.jsx';
import { useIsMobile } from '../../utils.js';
import { todayStr, fmtDayLabel } from '../../lib/scheduleCalendar.js';

const KIND_LABEL = { storyboard: 'Storyboard / Visuals', production: 'Production' };

// Home dashboard for the production team — shortcuts to the calendar, their own
// tasks + notifications, and an "Amends to do" list. Mirrors the shape of the
// Business "Mission control" overview but scoped to a producer's day-to-day.
export function ProductionDashboardView({ onOpenSchedule, onOpenTasks, onOpenVideo, onOpenLink }) {
  const { state, actions } = useStore();
  const isMobile = useIsMobile();
  const sched = state.schedule || {};
  const me = (state.session?.email || '').toLowerCase();
  const firstName = (state.session?.name || '').split(' ')[0] || 'there';

  useEffect(() => {
    actions.loadSchedule();
    actions.loadTasks && actions.loadTasks();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const today = todayStr();

  const myBlocks = (sched.assignments || [])
    .filter(a => a.userEmail === me && a.endDate >= today)
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 6);
  const myAmends = (sched.amends || []).filter(a => !a.producerEmails || a.producerEmails.includes(me) || a.userEmail === me);

  const endOfToday = new Date(); endOfToday.setHours(23, 59, 59, 999);
  const myTasks = (state.tasks || [])
    .filter(t => {
      const emails = Array.isArray(t.assigneeEmails) && t.assigneeEmails.length ? t.assigneeEmails : (t.assigneeEmail ? [t.assigneeEmail] : []);
      return emails.some(e => String(e).toLowerCase() === me) && !t.doneAt && t.dueAt && new Date(t.dueAt).getTime() <= endOfToday.getTime();
    })
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

  const notifs = (state.notificationsByChannel?.general?.items || []).slice(0, 6);

  return (
    <div style={{ padding: isMobile ? '14px 12px 40px' : '24px 24px 60px', maxWidth: 1080, margin: '0 auto' }}>
      {/* Hero */}
      <div style={{ background: 'linear-gradient(135deg,#0F2A3D,#155E75)', color: 'white', borderRadius: 16, padding: isMobile ? 20 : 28, marginBottom: 20 }}>
        <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.7, fontWeight: 700 }}>Production</div>
        <div style={{ fontSize: isMobile ? 22 : 28, fontWeight: 800, margin: '4px 0 14px' }}>{greeting}, {firstName}</div>
        <div style={{ display: 'flex', gap: isMobile ? 16 : 32, flexWrap: 'wrap' }}>
          <HeroStat label="Upcoming blocks" value={myBlocks.length} />
          <HeroStat label="Amends to do" value={myAmends.length} />
          <HeroStat label="Tasks due" value={myTasks.length} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16 }}>
        {/* My calendar */}
        <Card title="My schedule" icon={CalendarDays} accent={BRAND.blue} onOpen={onOpenSchedule} openLabel="Open calendar">
          {myBlocks.length === 0 && <Empty>Nothing scheduled right now.</Empty>}
          {myBlocks.map(b => (
            <Row key={b.id} onClick={() => onOpenVideo && onOpenVideo(b.videoId)}>
              <div>
                <div style={{ fontWeight: 600 }}>{b.projectTitle} — {b.videoTitle}</div>
                <div style={{ fontSize: 12, color: BRAND.muted }}>{KIND_LABEL[b.kind]} · {fmtDayLabel(b.startDate)} → {fmtDayLabel(b.endDate)}</div>
              </div>
              {(b.conflict || b.leaveConflict) && <AlertTriangle size={16} color="#DC2626" />}
            </Row>
          ))}
        </Card>

        {/* Amends to do */}
        <Card title="Amends to do" icon={Clapperboard} accent="#DC2626">
          {myAmends.length === 0 && <Empty>No amends outstanding.</Empty>}
          {myAmends.map(a => (
            <Row key={a.videoId} onClick={() => onOpenVideo && onOpenVideo(a.videoId)}>
              <div>
                <div style={{ fontWeight: 600 }}>{a.projectTitle} — {a.videoTitle}</div>
                <div style={{ fontSize: 12, color: BRAND.muted }}>{a.kind === 'storyboard' ? 'Storyboard revisions' : 'Revisions (after production)'}</div>
              </div>
              <ChevronRight size={16} color={BRAND.muted} />
            </Row>
          ))}
        </Card>

        {/* My tasks */}
        <Card title="My tasks due" icon={CheckSquare} accent="#16A34A" onOpen={onOpenTasks} openLabel="All tasks">
          {myTasks.length === 0 && <Empty>Nothing due today. </Empty>}
          {myTasks.slice(0, 6).map(t => (
            <Row key={t.id} onClick={onOpenTasks}>
              <div>
                <div style={{ fontWeight: 600 }}>{t.title}</div>
                <div style={{ fontSize: 12, color: BRAND.muted }}>{t.dueAt ? new Date(t.dueAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''}</div>
              </div>
            </Row>
          ))}
        </Card>

        {/* Notifications */}
        <Card title="Recent notifications" icon={Bell} accent="#7C3AED">
          {notifs.length === 0 && <Empty>You're all caught up.</Empty>}
          {notifs.map(n => (
            <Row key={n.id} onClick={() => n.link && onOpenLink && onOpenLink(n.link)}>
              <div>
                <div style={{ fontWeight: n.readAt ? 500 : 700 }}>{n.title}</div>
                {n.body && <div style={{ fontSize: 12, color: BRAND.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n.body}</div>}
              </div>
            </Row>
          ))}
        </Card>
      </div>
    </div>
  );
}

function HeroStat({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}>{label}</div>
    </div>
  );
}

function Card({ title, icon: Icon, accent, children, onOpen, openLabel }) {
  return (
    <div style={{ background: 'white', border: '1px solid ' + BRAND.border, borderTop: '3px solid ' + accent, borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid ' + BRAND.paper }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14 }}><Icon size={16} color={accent} /> {title}</div>
        {onOpen && <button className="btn-ghost" onClick={onOpen} style={{ fontSize: 12, fontWeight: 600 }}>{openLabel} <ChevronRight size={13} /></button>}
      </div>
      <div style={{ padding: '6px 16px 12px' }}>{children}</div>
    </div>
  );
}

function Row({ children, onClick }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '9px 0', borderBottom: '1px solid ' + BRAND.paper, cursor: onClick ? 'pointer' : 'default' }}>
      {children}
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ color: BRAND.muted, fontSize: 13, padding: '10px 0' }}>{children}</div>;
}
